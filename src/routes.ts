
// HTTP 路由：身份识别、本方事实权限、跨方映射共同确认、
// 结论角色确认、冲正、冻结、批次与重放、差异溯源。

import { DatabaseSync } from "node:sqlite";
import { IncomingMessage, ServerResponse } from "node:http";
import { badRequest, conflict, forbidden, HttpError, notFound } from "./errors.js";
import { all, audit, get, newId, run, tx } from "./repo.js";
import {
  acceptReversal,
  closeBatch,
  closeDispute,
  openDispute,
  payableState,
  proposeReversal,
  recomputeCooperation,
  recomputeVersion,
  rejectReversal,
  replayBatch,
  splitMilestone,
  type SplitChildSpec,
} from "./service.js";
import { nowIso } from "./time.js";
import type {
  CalendarRow,
  ConclusionRow,
  CooperationRow,
  DisputeRow,
  MappingConfirmationRow,
  MappingRow,
  MilestoneVersionRow,
  PartyRow,
  SettlementBatchRow,
} from "./types.js";
import {
  jsonBody,
  optionalDigest,
  optionalIso,
  optionalNumber,
  optionalString,
  requireDateOnly,
  requireDigest,
  requireIso,
  requireNumber,
  requireString,
  requireStringArray,
  requireTimeZone,
  requireWorkdayFlags,
} from "./validation.js";

interface Caller {
  party: string;
  role: string;
  side: "A" | "B" | null;
}

type Handler = (
  req: IncomingMessage,
  params: Record<string, string>,
  body: Record<string, unknown>,
  caller: Caller | null,
) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function pathToRegex(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  });
  return { pattern: new RegExp(`^${pattern}$`), keys };
}

export function createRouter(db: DatabaseSync) {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const { pattern, keys } = pathToRegex(path);
    routes.push({ method, pattern, keys, handler });
  };

  // ---- 工具 ----------------------------------------------------------------
  const identify = (req: IncomingMessage): Caller => {
    const party = req.headers["x-actor-party"];
    const role = req.headers["x-actor-role"];
    if (typeof party !== "string" || typeof role !== "string" || !party || !role) {
      throw new HttpError(401, "unauthenticated", "缺少 x-actor-party / x-actor-role 请求头");
    }
    const row = get<PartyRow>(db, "SELECT * FROM parties WHERE party_code = ?", party);
    if (!row) throw new HttpError(401, "unknown_party", `未知参与方：${party}`);
    return { party, role, side: row.side };
  };

  const requirePm = (caller: Caller) => {
    if (caller.role !== "project_owner") {
      throw forbidden("该操作需要项目负责人角色");
    }
  };

  const cooperation = (ref: string): CooperationRow => {
    const row = get<CooperationRow>(
      db,
      "SELECT * FROM cooperations WHERE cooperation_ref = ?",
      ref,
    );
    if (!row) throw notFound(`合作不存在：${ref}`);
    return row;
  };

  const versionOf = (ref: string, versionId: string): MilestoneVersionRow => {
    const row = get<MilestoneVersionRow>(
      db,
      "SELECT * FROM milestone_versions WHERE id = ? AND cooperation_ref = ?",
      versionId,
      ref,
    );
    if (!row) throw notFound(`里程碑版本不存在：${versionId}`);
    return row;
  };

  /** 本方事实：调用方必须属于版本归属方 */
  const assertOwnSide = (caller: Caller, version: MilestoneVersionRow) => {
    if (caller.side !== version.side) {
      throw forbidden("只能登记或更正本方里程碑的事实");
    }
  };

  const assertCoopParty = (caller: Caller, coop: CooperationRow) => {
    if (caller.party !== coop.home_party && caller.party !== coop.partner_party) {
      throw forbidden("调用方不是该合作的参与方");
    }
  };

  const refresh = (ref: string, actor: string) =>
    recomputeCooperation(db, ref, { actor });

  const conclusionJson = (row: ConclusionRow, withInputs = false) => ({
    ...row,
    details: JSON.parse(row.details_json) as unknown,
    ...(withInputs ? { inputs: JSON.parse(row.inputs_json) as unknown } : {}),
  });

  // ---- 健康与引导 -----------------------------------------------------------
  add("GET", "/health", () => ({ data: { status: "ok" } }));

  add("POST", "/admin/parties", (_req, _params, body) => {
    const party: PartyRow = {
      party_code: requireString(body, "party_code"),
      side: requireString(body, "side") as "A" | "B",
      display_name: requireString(body, "display_name"),
      created_at: nowIso(),
    };
    if (party.side !== "A" && party.side !== "B") {
      throw badRequest("invalid_side", "side 必须为 A 或 B");
    }
    run(
      db,
      "INSERT INTO parties (party_code, side, display_name, created_at) VALUES (?, ?, ?, ?)",
      party.party_code,
      party.side,
      party.display_name,
      party.created_at,
    );
    audit(db, { action: "party.registered", entity_type: "party", entity_id: party.party_code });
    return { status: 201, data: party };
  });

  add("POST", "/admin/cooperations", (_req, _params, body) => {
    const coop: CooperationRow = {
      cooperation_ref: requireString(body, "cooperation_ref"),
      home_party: requireString(body, "home_party"),
      partner_party: requireString(body, "partner_party"),
      currency: optionalString(body, "currency") ?? "CNY",
      status: "active",
      created_by: "admin",
      created_at: nowIso(),
    };
    for (const p of [coop.home_party, coop.partner_party]) {
      if (!get(db, "SELECT party_code FROM parties WHERE party_code = ?", p)) {
        throw badRequest("unknown_party", `参与方未登记：${p}`);
      }
    }
    run(
      db,
      `INSERT INTO cooperations (cooperation_ref, home_party, partner_party, currency, status, created_by, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      coop.cooperation_ref,
      coop.home_party,
      coop.partner_party,
      coop.currency,
      coop.created_by,
      coop.created_at,
    );
    audit(db, {
      cooperation_ref: coop.cooperation_ref,
      action: "cooperation.created",
      entity_type: "cooperation",
      entity_id: coop.cooperation_ref,
    });
    return { status: 201, data: coop };
  });

  add("POST", "/admin/cooperations/:ref/calendars", (_req, params, body) => {
    cooperation(params.ref);
    const flags = requireWorkdayFlags(body);
    const cal: CalendarRow = {
      id: newId("cal"),
      cooperation_ref: params.ref,
      party_code: optionalString(body, "party_code") ?? null,
      calendar_code: requireString(body, "calendar_code"),
      iana_timezone: requireTimeZone(body, "iana_timezone"),
      work_mon: flags.work_mon,
      work_tue: flags.work_tue,
      work_wed: flags.work_wed,
      work_thu: flags.work_thu,
      work_fri: flags.work_fri,
      work_sat: flags.work_sat,
      work_sun: flags.work_sun,
      valid_from_date: requireDateOnly(body, "valid_from_date"),
      valid_to_date: optionalString(body, "valid_to_date") ?? null,
      created_by: "admin",
      created_at: nowIso(),
    };
    run(
      db,
      `INSERT INTO calendars (id, cooperation_ref, party_code, calendar_code, iana_timezone,
         work_mon, work_tue, work_wed, work_thu, work_fri, work_sat, work_sun,
         valid_from_date, valid_to_date, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cal.id,
      cal.cooperation_ref,
      cal.party_code,
      cal.calendar_code,
      cal.iana_timezone,
      cal.work_mon,
      cal.work_tue,
      cal.work_wed,
      cal.work_thu,
      cal.work_fri,
      cal.work_sat,
      cal.work_sun,
      cal.valid_from_date,
      cal.valid_to_date,
      cal.created_by,
      cal.created_at,
    );
    audit(db, {
      cooperation_ref: params.ref,
      action: "calendar.created",
      entity_type: "calendar",
      entity_id: cal.id,
    });
    return { status: 201, data: cal };
  });

  add("POST", "/admin/calendars/:id/holidays", (_req, params, body) => {
    const cal = get<CalendarRow>(db, "SELECT * FROM calendars WHERE id = ?", params.id);
    if (!cal) throw notFound("日历不存在");
    const id = newId("hol");
    run(
      db,
      `INSERT INTO calendar_holidays (id, calendar_id, holiday_date, name, workday_override, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      cal.id,
      requireDateOnly(body, "holiday_date"),
      requireString(body, "name"),
      body.workday_override === 1 ? 1 : 0,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: cal.cooperation_ref,
      action: "calendar.holiday_added",
      entity_type: "calendar",
      entity_id: cal.id,
      payload: { holiday_date: body.holiday_date },
    });
    // 假日调整影响逾期判定：触发重算
    refresh(cal.cooperation_ref, "admin");
    return { status: 201, data: { id } };
  });

  // ---- 里程碑版本 -----------------------------------------------------------
  add("POST", "/cooperations/:ref/milestones", (_req, params, body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const code = requireString(body, "milestone_code");
    const side = caller!.side!;
    const calendarId = requireString(body, "calendar_id");
    const cal = get<CalendarRow>(
      db,
      "SELECT * FROM calendars WHERE id = ? AND cooperation_ref = ?",
      calendarId,
      params.ref,
    );
    if (!cal) throw badRequest("unknown_calendar", "日历不属于该合作");
    const existing = get<{ max_revision: number }>(
      db,
      `SELECT MAX(revision) AS max_revision FROM milestone_versions
        WHERE cooperation_ref = ? AND side = ? AND milestone_code = ?`,
      params.ref,
      side,
      code,
    );
    const revision = (existing?.max_revision ?? 0) + 1;
    const row: MilestoneVersionRow = {
      id: newId("mv"),
      cooperation_ref: params.ref,
      side,
      milestone_code: code,
      revision,
      version_kind: revision === 1 ? "initial" : "revision",
      parent_version_id: null,
      title: requireString(body, "title"),
      planned_date: requireIso(body, "planned_date"),
      amount: requireNumber(body, "amount"),
      weight: optionalNumber(body, "weight") ?? null,
      calendar_id: calendarId,
      required_roles: JSON.stringify(
        body.required_roles === undefined ? [] : requireStringArray(body, "required_roles"),
      ),
      recorded_by: caller!.party,
      recorded_at: nowIso(),
    };
    run(
      db,
      `INSERT INTO milestone_versions (id, cooperation_ref, side, milestone_code, revision,
         version_kind, parent_version_id, title, planned_date, amount, weight, calendar_id,
         required_roles, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.cooperation_ref,
      row.side,
      row.milestone_code,
      row.revision,
      row.version_kind,
      row.title,
      row.planned_date,
      row.amount,
      row.weight,
      row.calendar_id,
      row.required_roles,
      row.recorded_by,
      row.recorded_at,
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "milestone.version_recorded",
      entity_type: "milestone_version",
      entity_id: row.id,
      payload: { milestone_code: code, revision },
    });
    refresh(params.ref, caller!.party);
    return { status: 201, data: row };
  });

  add("GET", "/cooperations/:ref/milestones", (req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const url = new URL(req.url ?? "", "http://x");
    const allRevisions = url.searchParams.get("all") === "1";
    const rows = allRevisions
      ? all<MilestoneVersionRow>(
          db,
          "SELECT * FROM milestone_versions WHERE cooperation_ref = ? ORDER BY side, milestone_code, revision",
          params.ref,
        )
      : all<MilestoneVersionRow>(
          db,
          "SELECT * FROM v_current_milestone WHERE cooperation_ref = ? ORDER BY side, milestone_code",
          params.ref,
        );
    return { data: rows };
  });

  add("POST", "/cooperations/:ref/milestones/:vid/split", (_req, params, body, caller) => {
    const parent = versionOf(params.ref, params.vid);
    assertOwnSide(caller!, parent);
    const rawChildren = body.children;
    if (!Array.isArray(rawChildren) || rawChildren.length < 2) {
      throw badRequest("invalid_children", "children 必须为至少两个子节点");
    }
    const children: SplitChildSpec[] = rawChildren.map((c, i) => {
      const child = c as Record<string, unknown>;
      try {
        return {
          milestone_code: requireString(child, "milestone_code"),
          title: requireString(child, "title"),
          planned_date: requireIso(child, "planned_date"),
          amount: requireNumber(child, "amount"),
          weight: requireNumber(child, "weight"),
          calendar_id: requireString(child, "calendar_id"),
          required_roles:
            child.required_roles === undefined
              ? []
              : (requireStringArray(child, "required_roles") as string[]),
        };
      } catch (error) {
        if (error instanceof HttpError) {
          throw badRequest("invalid_child", `第 ${i + 1} 个子节点：${error.message}`);
        }
        throw error;
      }
    });
    const created = splitMilestone(db, parent.id, children, caller!.party);
    refresh(params.ref, caller!.party);
    return { status: 201, data: created };
  });

  // ---- 跨方映射（双方确认才生效） -------------------------------------------
  add("POST", "/cooperations/:ref/mappings", (_req, params, body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const aId = requireString(body, "side_a_version_id");
    const bId = requireString(body, "side_b_version_id");
    const a = versionOf(params.ref, aId);
    const b = versionOf(params.ref, bId);
    if (a.side !== "A" || b.side !== "B") {
      throw badRequest("invalid_mapping_sides", "映射必须一侧为 A 方版本、一侧为 B 方版本");
    }
    const relation = optionalString(body, "relation") ?? "equivalent";
    if (relation !== "equivalent" && relation !== "split") {
      throw badRequest("invalid_relation", "relation 必须为 equivalent 或 split");
    }
    const mapping: MappingRow = {
      id: newId("map"),
      cooperation_ref: params.ref,
      side_a_version_id: aId,
      side_b_version_id: bId,
      relation,
      note: optionalString(body, "note") ?? null,
      created_by: caller!.party,
      created_at: nowIso(),
      voided_at: null,
    };
    tx(db, () => {
      run(
        db,
        `INSERT INTO milestone_mappings (id, cooperation_ref, side_a_version_id, side_b_version_id,
           relation, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        mapping.id,
        mapping.cooperation_ref,
        mapping.side_a_version_id,
        mapping.side_b_version_id,
        mapping.relation,
        mapping.note,
        mapping.created_by,
        mapping.created_at,
      );
      // 创建方视为已确认本方
      run(
        db,
        "INSERT INTO mapping_confirmations (id, mapping_id, party_code, confirmed_at) VALUES (?, ?, ?, ?)",
        newId("mc"),
        mapping.id,
        caller!.party,
        nowIso(),
      );
      audit(db, {
        cooperation_ref: params.ref,
        actor_party: caller!.party,
        action: "mapping.created",
        entity_type: "mapping",
        entity_id: mapping.id,
      });
    });
    refresh(params.ref, caller!.party);
    return { status: 201, data: mapping };
  });

  add("POST", "/cooperations/:ref/mappings/:id/confirm", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const mapping = get<MappingRow>(
      db,
      "SELECT * FROM milestone_mappings WHERE id = ? AND cooperation_ref = ?",
      params.id,
      params.ref,
    );
    if (!mapping) throw notFound("映射不存在");
    if (mapping.voided_at) throw conflict("mapping_void", "映射已作废");
    const already = get<MappingConfirmationRow>(
      db,
      "SELECT * FROM mapping_confirmations WHERE mapping_id = ? AND party_code = ?",
      mapping.id,
      caller!.party,
    );
    if (already) throw conflict("already_confirmed", "本方已确认过该映射");
    run(
      db,
      "INSERT INTO mapping_confirmations (id, mapping_id, party_code, confirmed_at) VALUES (?, ?, ?, ?)",
      newId("mc"),
      mapping.id,
      caller!.party,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "mapping.confirmed",
      entity_type: "mapping",
      entity_id: mapping.id,
    });
    refresh(params.ref, caller!.party);
    return { data: { mapping_id: mapping.id, confirmed_by: caller!.party } };
  });

  add("POST", "/cooperations/:ref/mappings/:id/void", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const mapping = get<MappingRow>(
      db,
      "SELECT * FROM milestone_mappings WHERE id = ? AND cooperation_ref = ?",
      params.id,
      params.ref,
    );
    if (!mapping) throw notFound("映射不存在");
    if (mapping.voided_at) throw conflict("mapping_void", "映射已作废");
    run(db, "UPDATE milestone_mappings SET voided_at = ? WHERE id = ?", nowIso(), mapping.id);
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "mapping.voided",
      entity_type: "mapping",
      entity_id: mapping.id,
    });
    refresh(params.ref, caller!.party);
    return { data: { mapping_id: mapping.id, voided: true } };
  });

  add("GET", "/cooperations/:ref/mappings", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const mappings = all<MappingRow>(
      db,
      "SELECT * FROM milestone_mappings WHERE cooperation_ref = ? ORDER BY created_at, id",
      params.ref,
    );
    const confirmations = all<MappingConfirmationRow>(
      db,
      `SELECT mc.* FROM mapping_confirmations mc
        JOIN milestone_mappings m ON m.id = mc.mapping_id
       WHERE m.cooperation_ref = ?`,
      params.ref,
    );
    return {
      data: mappings.map((m) => ({
        ...m,
        confirmations: confirmations.filter((c) => c.mapping_id === m.id),
      })),
    };
  });

  // ---- 依赖 -----------------------------------------------------------------
  add("POST", "/cooperations/:ref/dependencies", (_req, params, body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const versionId = requireString(body, "version_id");
    const dependsOnId = requireString(body, "depends_on_version_id");
    versionOf(params.ref, versionId);
    versionOf(params.ref, dependsOnId);
    if (versionId === dependsOnId) {
      throw badRequest("self_dependency", "里程碑不能依赖自身");
    }
    // 环路检测：depends_on 不可（传递）依赖 version
    const deps = all<{ version_id: string; depends_on_version_id: string }>(
      db,
      "SELECT version_id, depends_on_version_id FROM milestone_dependencies WHERE cooperation_ref = ?",
      params.ref,
    );
    const reaches = (from: string, target: string, seen: Set<string>): boolean => {
      if (from === target) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return deps
        .filter((d) => d.version_id === from)
        .some((d) => reaches(d.depends_on_version_id, target, seen));
    };
    if (reaches(dependsOnId, versionId, new Set())) {
      throw conflict("dependency_cycle", "依赖会形成环路");
    }
    const id = newId("dep");
    run(
      db,
      `INSERT INTO milestone_dependencies (id, cooperation_ref, version_id, depends_on_version_id, kind, created_by, created_at)
       VALUES (?, ?, ?, ?, 'finish_to_start', ?, ?)`,
      id,
      params.ref,
      versionId,
      dependsOnId,
      caller!.party,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "dependency.created",
      entity_type: "dependency",
      entity_id: id,
      payload: { version_id: versionId, depends_on_version_id: dependsOnId },
    });
    refresh(params.ref, caller!.party);
    return { status: 201, data: { id } };
  });

  add("GET", "/cooperations/:ref/dependencies", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    return {
      data: all(
        db,
        "SELECT * FROM milestone_dependencies WHERE cooperation_ref = ? ORDER BY created_at, id",
        params.ref,
      ),
    };
  });

  // ---- 交付清单 / 交付事件 / 签收回执（本方事实） ----------------------------
  add("POST", "/cooperations/:ref/versions/:vid/items", (_req, params, body, caller) => {
    const version = versionOf(params.ref, params.vid);
    assertOwnSide(caller!, version);
    const id = newId("item");
    run(
      db,
      `INSERT INTO delivery_items (id, version_id, item_code, title, required_qty, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      version.id,
      requireString(body, "item_code"),
      requireString(body, "title"),
      optionalNumber(body, "required_qty") ?? 1,
      caller!.party,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "delivery_item.recorded",
      entity_type: "delivery_item",
      entity_id: id,
    });
    refresh(params.ref, caller!.party);
    return { status: 201, data: { id } };
  });

  add("POST", "/cooperations/:ref/versions/:vid/deliveries", (_req, params, body, caller) => {
    const version = versionOf(params.ref, params.vid);
    assertOwnSide(caller!, version);
    const itemCode = requireString(body, "item_code");
    const item = get<{ id: string }>(
      db,
      "SELECT id FROM delivery_items WHERE version_id = ? AND item_code = ?",
      version.id,
      itemCode,
    );
    if (!item) throw badRequest("unknown_item", `清单中不存在交付项：${itemCode}`);
    const digest = requireDigest(body, "evidence_digest");
    // 重复交付事件（同清单行同摘要）：幂等返回已有记录（R1）
    const existing = get<{ id: string }>(
      db,
      "SELECT id FROM delivery_events WHERE item_id = ? AND evidence_digest = ?",
      item.id,
      digest,
    );
    if (existing) {
      return { data: { id: existing.id, duplicate: true } };
    }
    // 显式标注为另一条事件的重复（编号/摘要不同但实物同一）：落库但不计入（R1）
    let duplicateOf: string | null = null;
    const duplicateOfId = optionalString(body, "duplicate_of_event_id");
    if (duplicateOfId) {
      const original = get<{ id: string; item_id: string }>(
        db,
        "SELECT id, item_id FROM delivery_events WHERE id = ?",
        duplicateOfId,
      );
      if (!original) throw badRequest("unknown_duplicate_of", "被指向的原交付事件不存在");
      if (original.item_id !== item.id) {
        throw badRequest("duplicate_cross_item", "重复标注必须指向同一清单行的事件");
      }
      duplicateOf = original.id;
    }
    const id = newId("evt");
    run(
      db,
      `INSERT INTO delivery_events (id, item_id, evidence_digest, local_ref, delivered_at, qty, duplicate_of, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      item.id,
      digest,
      optionalString(body, "local_ref") ?? null,
      requireIso(body, "delivered_at"),
      optionalNumber(body, "qty") ?? 1,
      duplicateOf,
      caller!.party,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "delivery.recorded",
      entity_type: "delivery_event",
      entity_id: id,
      payload: { duplicate_of: duplicateOf },
    });
    refresh(params.ref, caller!.party);
    return { status: 201, data: { id, duplicate: duplicateOf !== null, duplicate_of: duplicateOf } };
  });

  add("POST", "/cooperations/:ref/versions/:vid/receipts", (_req, params, body, caller) => {
    const version = versionOf(params.ref, params.vid);
    const receiptNo = requireString(body, "receipt_no");
    // 重复回执（同版本同回执号）：幂等返回已有记录（R1）
    const existing = get<{ id: string }>(
      db,
      "SELECT id FROM receipts WHERE version_id = ? AND receipt_no = ?",
      version.id,
      receiptNo,
    );
    if (existing) {
      return { data: { id: existing.id, duplicate: true } };
    }
    // 显式重复回执（回执号不同但实物同一）：落库、标注、不计入（R1）
    let duplicateOf: string | null = null;
    const duplicateOfId = optionalString(body, "duplicate_of_receipt_id");
    if (duplicateOfId) {
      const original = get<{ id: string; version_id: string }>(
        db,
        "SELECT id, version_id FROM receipts WHERE id = ?",
        duplicateOfId,
      );
      if (!original) throw badRequest("unknown_duplicate_of", "被指向的原回执不存在");
      if (original.version_id !== version.id) {
        throw badRequest("duplicate_cross_version", "重复标注必须指向同一版本的回执");
      }
      duplicateOf = original.id;
    }
    const receivingParty = optionalString(body, "receiving_party") ?? caller!.party;
    if (
      !get(db, "SELECT party_code FROM parties WHERE party_code = ?", receivingParty)
    ) {
      throw badRequest("unknown_party", `签收方未登记：${receivingParty}`);
    }
    const id = newId("rcp");
    run(
      db,
      `INSERT INTO receipts (id, version_id, receipt_no, evidence_digest, local_ref, signed_at,
         receiving_party, duplicate_of, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      version.id,
      receiptNo,
      requireDigest(body, "evidence_digest"),
      optionalString(body, "local_ref") ?? null,
      requireIso(body, "signed_at"),
      receivingParty,
      duplicateOf,
      caller!.party,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "receipt.recorded",
      entity_type: "receipt",
      entity_id: id,
      payload: { duplicate_of: duplicateOf, receiving_party: receivingParty },
    });
    refresh(params.ref, caller!.party);
    return {
      status: 201,
      data: { id, duplicate: duplicateOf !== null, duplicate_of: duplicateOf },
    };
  });

  // ---- 本方事实更正（撤回，追加写） ------------------------------------------
  add("POST", "/cooperations/:ref/facts/:table/:id/withdraw", (_req, params, body, caller) => {
    const table = params.table;
    if (table !== "delivery_events" && table !== "receipts" && table !== "delivery_items") {
      throw badRequest("invalid_fact_table", "fact_table 仅支持 delivery_events / receipts / delivery_items");
    }
    cooperation(params.ref);
    // 归属校验：只能更正本方事实
    if (table === "receipts") {
      const fact = get<{ recorded_by: string }>(
        db,
        "SELECT recorded_by FROM receipts WHERE id = ?",
        params.id,
      );
      if (!fact) throw notFound("事实不存在");
      if (fact.recorded_by !== caller!.party) {
        throw forbidden("只能更正本方登记的事实");
      }
    } else {
      const ownerSql =
        table === "delivery_events"
          ? `SELECT mv.side AS side FROM delivery_events de
              JOIN delivery_items di ON di.id = de.item_id
              JOIN milestone_versions mv ON mv.id = di.version_id
             WHERE de.id = ?`
          : `SELECT mv.side AS side FROM delivery_items di
              JOIN milestone_versions mv ON mv.id = di.version_id
             WHERE di.id = ?`;
      const fact = get<{ side: string }>(db, ownerSql, params.id);
      if (!fact) throw notFound("事实不存在");
      if (caller!.side !== fact.side) {
        throw forbidden("只能更正本方里程碑的事实");
      }
    }
    const id = newId("cor");
    try {
      run(
        db,
        `INSERT INTO fact_corrections (id, fact_table, fact_id, kind, reason, recorded_by, recorded_at)
         VALUES (?, ?, ?, 'withdraw', ?, ?, ?)`,
        id,
        table,
        params.id,
        optionalString(body, "reason") ?? null,
        caller!.party,
        nowIso(),
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE")) {
        throw conflict("already_withdrawn", "该事实已被撤回");
      }
      throw error;
    }
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "fact.withdrawn",
      entity_type: table,
      entity_id: params.id,
    });
    refresh(params.ref, caller!.party);
    return { status: 201, data: { id } };
  });

  // ---- 异议与冻结 ------------------------------------------------------------
  add("POST", "/cooperations/:ref/disputes", (_req, params, body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const subjectVersionId = optionalString(body, "subject_version_id");
    const mappingId = optionalString(body, "mapping_id");
    if (!subjectVersionId && !mappingId) {
      throw badRequest("missing_subject", "异议必须指向里程碑版本或映射");
    }
    if (subjectVersionId) versionOf(params.ref, subjectVersionId);
    if (mappingId) {
      const mapping = get<MappingRow>(
        db,
        "SELECT id FROM milestone_mappings WHERE id = ? AND cooperation_ref = ?",
        mappingId,
        params.ref,
      );
      if (!mapping) throw badRequest("unknown_mapping", "映射不属于该合作");
    }
    const dispute: DisputeRow = {
      id: newId("dsp"),
      cooperation_ref: params.ref,
      subject_version_id: subjectVersionId ?? null,
      mapping_id: mappingId ?? null,
      reason: requireString(body, "reason"),
      evidence_digest: optionalDigest(body, "evidence_digest") ?? null,
      local_ref: optionalString(body, "local_ref") ?? null,
      raised_by: caller!.party,
      raised_at: requireIso(body, "raised_at"),
      recorded_at: nowIso(),
      status: "open",
      resolved_at: null,
      resolution_note: null,
    };
    const freezes = openDispute(db, dispute, caller!.party);
    refresh(params.ref, caller!.party);
    return { status: 201, data: { dispute, freezes } };
  });

  const closeDisputeHandler =
    (status: "resolved" | "withdrawn"): Handler =>
    (_req, params, body, caller) => {
      const coop = cooperation(params.ref);
      assertCoopParty(caller!, coop);
      closeDispute(db, params.id, status, caller!.party, optionalString(body, "note"));
      refresh(params.ref, caller!.party);
      return { data: { dispute_id: params.id, status } };
    };
  add("POST", "/cooperations/:ref/disputes/:id/resolve", closeDisputeHandler("resolved"));
  add("POST", "/cooperations/:ref/disputes/:id/withdraw", closeDisputeHandler("withdrawn"));

  add("GET", "/cooperations/:ref/disputes", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const disputes = all<DisputeRow>(
      db,
      "SELECT * FROM disputes WHERE cooperation_ref = ? ORDER BY recorded_at, id",
      params.ref,
    );
    const freezes = all(
      db,
      "SELECT * FROM dispute_freezes WHERE cooperation_ref = ? ORDER BY created_at, id",
      params.ref,
    );
    return { data: { disputes, freezes } };
  });

  // ---- 重算与结论 ------------------------------------------------------------
  add("POST", "/cooperations/:ref/recompute", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const results = refresh(params.ref, caller!.party);
    return { data: { created: results.length, conclusions: results.map((r) => r.conclusion.id) } };
  });

  add("POST", "/cooperations/:ref/versions/:vid/recompute", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    versionOf(params.ref, params.vid);
    const result = recomputeVersion(db, params.vid, { actor: caller!.party });
    return { data: conclusionJson(result.conclusion), created: result.created };
  });

  add("GET", "/cooperations/:ref/versions/:vid/conclusions", (req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    versionOf(params.ref, params.vid);
    const withInputs = new URL(req.url ?? "", "http://x").searchParams.get("inputs") === "1";
    const rows = all<ConclusionRow>(
      db,
      "SELECT * FROM conclusions WHERE version_id = ? ORDER BY created_at, id",
      params.vid,
    );
    return { data: rows.map((r) => conclusionJson(r, withInputs)) };
  });

  add("GET", "/cooperations/:ref/versions/:vid/payable", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    versionOf(params.ref, params.vid);
    const state = payableState(db, params.vid);
    return {
      data: {
        ...state,
        conclusion: state.conclusion ? conclusionJson(state.conclusion) : null,
      },
    };
  });

  add("POST", "/cooperations/:ref/conclusions/:id/confirm", (_req, params, body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const conclusion = get<ConclusionRow>(
      db,
      "SELECT * FROM conclusions WHERE id = ? AND cooperation_ref = ?",
      params.id,
      params.ref,
    );
    if (!conclusion) throw notFound("结论不存在");
    const role = requireString(body, "role"); // 形如 HOME:lead
    const [roleParty, roleName] = role.split(":");
    if (!roleParty || !roleName) {
      throw badRequest("invalid_role", "role 必须为 <party_code>:<role> 形式");
    }
    const version = versionOf(params.ref, conclusion.version_id);
    const required = JSON.parse(version.required_roles) as string[];
    if (!required.includes(role)) {
      throw badRequest("role_not_required", "该角色不在此版本的约定确认角色中");
    }
    if (caller!.party !== roleParty && caller!.role !== "project_owner") {
      throw forbidden("只能以本方被约定的角色确认");
    }
    const existing = get(
      db,
      "SELECT id FROM conclusion_confirmations WHERE conclusion_id = ? AND role = ?",
      conclusion.id,
      role,
    );
    if (existing) throw conflict("already_confirmed", "该角色已确认过此结论");
    run(
      db,
      `INSERT INTO conclusion_confirmations (id, conclusion_id, role, party_code, confirmed_at)
       VALUES (?, ?, ?, ?, ?)`,
      newId("cc"),
      conclusion.id,
      role,
      caller!.party,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "conclusion.confirmed",
      entity_type: "conclusion",
      entity_id: conclusion.id,
      payload: { role },
    });
    return { status: 201, data: payableState(db, conclusion.version_id) };
  });

  // ---- 冲正 ------------------------------------------------------------------
  add("POST", "/cooperations/:ref/conclusions/:id/reversals", (_req, params, body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const reversal = proposeReversal(
      db,
      params.id,
      {
        reason_code: requireString(body, "reason_code"),
        reason: requireString(body, "reason"),
        evidence_digest: optionalDigest(body, "evidence_digest"),
      },
      caller!.party,
    );
    return { status: 201, data: reversal };
  });

  add("POST", "/cooperations/:ref/reversals/:id/accept", (_req, params, _body, caller) => {
    cooperation(params.ref);
    requirePm(caller!);
    const reversal = acceptReversal(db, params.id, caller!.party);
    refresh(params.ref, caller!.party);
    return { data: reversal };
  });

  add("POST", "/cooperations/:ref/reversals/:id/reject", (_req, params, _body, caller) => {
    cooperation(params.ref);
    requirePm(caller!);
    const reversal = rejectReversal(db, params.id, caller!.party);
    return { data: reversal };
  });

  add("GET", "/cooperations/:ref/reversals", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    return {
      data: all(
        db,
        "SELECT * FROM conclusion_reversals WHERE cooperation_ref = ? ORDER BY created_at, id",
        params.ref,
      ),
    };
  });

  // ---- 结算批次与重放 ----------------------------------------------------------
  add("POST", "/cooperations/:ref/batches", (_req, params, body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const batchNo = requireString(body, "batch_no");
    const id = newId("bat");
    run(
      db,
      `INSERT INTO settlement_batches (id, cooperation_ref, batch_no, rule_version, status, cutoff_at, created_by, created_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
      id,
      params.ref,
      batchNo,
      "v1",
      nowIso(),
      caller!.party,
      nowIso(),
    );
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "batch.opened",
      entity_type: "settlement_batch",
      entity_id: id,
      payload: { batch_no: batchNo },
    });
    return { status: 201, data: { id, batch_no: batchNo } };
  });

  add("POST", "/cooperations/:ref/batches/:id/close", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const { entries, batch } = closeBatch(db, params.id, caller!.party);
    return { data: { batch, entries } };
  });

  add("GET", "/cooperations/:ref/batches", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    return {
      data: all<SettlementBatchRow>(
        db,
        "SELECT * FROM settlement_batches WHERE cooperation_ref = ? ORDER BY created_at, id",
        params.ref,
      ),
    };
  });

  add("GET", "/cooperations/:ref/batches/:id", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const batch = get<SettlementBatchRow>(
      db,
      "SELECT * FROM settlement_batches WHERE id = ? AND cooperation_ref = ?",
      params.id,
      params.ref,
    );
    if (!batch) throw notFound("批次不存在");
    const entries = all(
      db,
      "SELECT * FROM settlement_entries WHERE batch_id = ? ORDER BY included_at, id",
      batch.id,
    );
    return { data: { batch, entries } };
  });

  add("GET", "/cooperations/:ref/batches/:id/replay", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const result = replayBatch(db, params.id);
    audit(db, {
      cooperation_ref: params.ref,
      actor_party: caller!.party,
      action: "batch.replayed",
      entity_type: "settlement_batch",
      entity_id: params.id,
      payload: { all_reproduced: result.all_reproduced },
    });
    return { data: result };
  });

  // ---- 差异溯源与审计 ----------------------------------------------------------
  add("GET", "/cooperations/:ref/state", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const versions = all<MilestoneVersionRow>(
      db,
      "SELECT * FROM v_current_milestone WHERE cooperation_ref = ? ORDER BY side, milestone_code",
      params.ref,
    );
    return {
      data: versions.map((v) => {
        const state = payableState(db, v.id);
        return {
          version: v,
          payable: state.payable,
          frozen: state.frozen,
          reasons: state.reasons,
          required_roles: state.required_roles,
          confirmed_roles: state.confirmed_roles,
          conclusion: state.conclusion
            ? {
                id: state.conclusion.id,
                gates_met: state.conclusion.gates_met,
                is_overdue: state.conclusion.is_overdue,
                payment_eligible: state.conclusion.payment_eligible,
                payment_amount: state.conclusion.payment_amount,
                basis_hash: state.conclusion.basis_hash,
              }
            : null,
        };
      }),
    };
  });

  add("GET", "/cooperations/:ref/versions/:vid/diff", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    const version = versionOf(params.ref, params.vid);
    const mappings = all<MappingRow>(
      db,
      `SELECT * FROM milestone_mappings
        WHERE voided_at IS NULL AND (side_a_version_id = ? OR side_b_version_id = ?)`,
      version.id,
      version.id,
    );
    const summarize = (v: MilestoneVersionRow) => {
      const state = payableState(db, v.id);
      const details = state.conclusion
        ? (JSON.parse(state.conclusion.details_json) as Record<string, unknown>)
        : null;
      return {
        version_id: v.id,
        side: v.side,
        milestone_code: v.milestone_code,
        revision: v.revision,
        planned_date: v.planned_date,
        amount: v.amount,
        conclusion_id: state.conclusion?.id ?? null,
        is_overdue: state.conclusion?.is_overdue ?? null,
        planned: details?.planned ?? null,
        completion: details?.completion ?? null,
        gates: details?.gates ?? null,
      };
    };
    const counterparts = mappings.map((m) => {
      const otherId = m.side_a_version_id === version.id ? m.side_b_version_id : m.side_a_version_id;
      const other = get<MilestoneVersionRow>(
        db,
        "SELECT * FROM milestone_versions WHERE id = ?",
        otherId,
      );
      return {
        mapping_id: m.id,
        relation: m.relation,
        counterpart: other ? summarize(other) : null,
      };
    });
    return {
      data: {
        self: summarize(version),
        mappings: counterparts,
        explanation:
          "planned.holiday_adjustment 展示假日顺延轨迹；completion 展示完成时刻口径（交付与签收取较晚者）；两侧 is_overdue 不一致即差异来源。",
      },
    };
  });

  add("GET", "/cooperations/:ref/audit", (_req, params, _body, caller) => {
    const coop = cooperation(params.ref);
    assertCoopParty(caller!, coop);
    return {
      data: all(
        db,
        "SELECT * FROM audit_events WHERE cooperation_ref = ? ORDER BY occurred_at, id",
        params.ref,
      ),
    };
  });

  // ---- 请求分发 ----------------------------------------------------------------
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const route = routes.find((r) => r.method === method && r.pattern.test(path));
      if (!route) {
        send(404, { error: { code: "not_found", message: "接口不存在" } });
        return;
      }
      const match = route.pattern.exec(path)!;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });
      let body: Record<string, unknown> = {};
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        const raw = await readBody(req);
        body = jsonBody(raw);
      }
      const isAdmin = path.startsWith("/admin/") || path === "/health";
      const caller = isAdmin ? null : identify(req);
      const result = await route.handler(req, params, body, caller);
      if (
        result &&
        typeof result === "object" &&
        typeof (result as Record<string, unknown>).status === "number" &&
        "data" in (result as Record<string, unknown>)
      ) {
        const r = result as { status: number; data: unknown };
        send(r.status, { data: r.data });
      } else if (result && typeof result === "object" && "data" in (result as Record<string, unknown>)) {
        send(200, result);
      } else {
        send(200, { data: result ?? null });
      }
    } catch (error) {
      if (error instanceof HttpError) {
        send(error.status, { error: { code: error.code, message: error.message } });
      } else if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        send(409, { error: { code: "duplicate", message: "记录已存在（唯一约束）" } });
      } else {
        send(500, {
          error: { code: "internal", message: error instanceof Error ? error.message : "内部错误" },
        });
      }
    }
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
