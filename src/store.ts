// 持久化与用例编排：
//  - append-only 事实写入（更正 = 新版本行）；
//  - 本方事实主权（requireParty），跨方映射/拆分走事件流并要求对方确认；
//  - asOf(T) 快照供规则引擎确定性重算；
//  - 批次 open 期间可重算留痕，closed 后不可变，只能冲正+替代；
//  - replay 按批次关闭时刻重放当时证据与规则，并列出迟到证据。

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RULE_VERSION, recompute, type NodeConclusion } from "./domain/rules.js";
import {
  foldMappings,
  foldObjections,
  foldSplits,
  type RawMappingEvent,
  type RawObjectionEvent,
  type RawSplitEvent,
} from "./domain/fold.js";
import type {
  CalendarSnapshot,
  ConfirmationFact,
  DeliverableFact,
  MappingFact,
  MilestoneFact,
  ReceiptFact,
  Snapshot,
} from "./domain/types.js";
import { isValidInstant, isValidLocalDate, isValidTimezone, parseInstant, type Side } from "./domain/time.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { Actor } from "./auth.js";
import { requireOwner, requireParty } from "./auth.js";

type Row = Record<string, unknown>;
type Input = Record<string, unknown>;
type SqlValue = string | number | bigint | null | Uint8Array;

export interface StoreDeps {
  clock?: () => number;
}

const SIDES: Side[] = ["A", "B"];

export class Store {
  readonly clock: () => number;

  constructor(
    private readonly db: DatabaseSync,
    deps: StoreDeps = {},
  ) {
    this.clock = deps.clock ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...(params as SqlValue[])) as Row[];
  }
  private one(sql: string, ...params: unknown[]): Row | undefined {
    return this.db.prepare(sql).get(...(params as SqlValue[])) as Row | undefined;
  }
  private run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...(params as SqlValue[]));
  }

  // ---------- 校验辅助 ----------

  private requireCooperation(ref: string): Row {
    const row = this.one("SELECT * FROM cooperations WHERE ref = ?", ref);
    if (!row) throw notFound("cooperation_not_found", `合作项目不存在：${ref}`);
    return row;
  }

  private assertDigest(digest: unknown): asserts digest is string {
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw badRequest("invalid_digest", "摘要格式必须为 sha256:<64位十六进制>");
    }
  }

  private assertInstant(value: unknown, field: string): asserts value is string {
    if (!isValidInstant(value)) throw badRequest("invalid_instant", `${field} 必须为带偏移量的 ISO 8601 时间`);
  }

  // ---------- 合作项目与双方档案 ----------

  createCooperation(actor: Actor, input: Input): Row {
    requireOwner(actor);
    const ref = input.ref?.toString().trim() ?? `COOP-${randomUUID().slice(0, 8)}`.toUpperCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ref)) {
      throw badRequest("invalid_ref", "合作项目编号只能包含字母、数字、_、-（1-64 位）");
    }
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw badRequest("invalid_name", "name 不能为空");
    }
    const currency = typeof input.currency === "string" ? input.currency.toUpperCase() : "CNY";
    if (!/^[A-Z]{3}$/.test(currency)) throw badRequest("invalid_currency", "currency 必须为 3 位字母代码");
    if (this.one("SELECT 1 FROM cooperations WHERE ref = ?", ref)) {
      throw conflict("cooperation_exists", `合作项目编号已存在：${ref}`);
    }
    this.run(
      "INSERT INTO cooperations(ref, name, currency, created_at) VALUES (?, ?, ?, ?)",
      ref,
      input.name.trim(),
      currency,
      this.nowIso(),
    );
    return this.one("SELECT * FROM cooperations WHERE ref = ?", ref)!;
  }

  registerParty(
    actor: Actor,
    input: Input,
  ): Row {
    const side = this.sideOf(input.side);
    requireParty(actor, side);
    if (typeof input.partyName !== "string" || input.partyName.trim().length === 0) {
      throw badRequest("invalid_party_name", "partyName 不能为空");
    }
    if (!isValidTimezone(input.ianaTimezone)) {
      throw badRequest("invalid_timezone", "ianaTimezone 不是有效的 IANA 时区");
    }
    let weekendDays = [0, 6];
    if (input.weekendDays !== undefined) {
      if (
        !Array.isArray(input.weekendDays) ||
        input.weekendDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
      ) {
        throw badRequest("invalid_weekend_days", "weekendDays 必须为 0-6 的整数数组");
      }
      weekendDays = [...new Set(input.weekendDays as number[])].sort();
    }
    const seqRow = this.one("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM party_versions WHERE side = ?", side);
    const id = randomUUID();
    this.run(
      `INSERT INTO party_versions(id, side, seq, party_name, iana_timezone, weekend_days, recorded_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      side,
      seqRow!.next_seq,
      input.partyName.trim(),
      input.ianaTimezone,
      JSON.stringify(weekendDays),
      this.nowIso(),
      actor.ref,
    );
    return this.one("SELECT * FROM party_versions WHERE id = ?", id)!;
  }

  private sideOf(value: unknown): Side {
    if (value === "A" || value === "B") return value;
    throw badRequest("invalid_side", "side 必须为 A 或 B");
  }

  // ---------- 日历 ----------

  upsertCalendarDay(
    actor: Actor,
    input: Input,
  ): Row {
    const side = this.sideOf(input.side);
    requireParty(actor, side);
    if (!isValidLocalDate(input.localDate)) throw badRequest("invalid_local_date", "localDate 格式必须为 YYYY-MM-DD");
    if (input.kind !== "holiday" && input.kind !== "workday") {
      throw badRequest("invalid_day_kind", "kind 必须为 holiday 或 workday");
    }
    const id = randomUUID();
    this.run(
      `INSERT INTO calendar_days(id, side, local_date, kind, label, recorded_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      side,
      input.localDate,
      input.kind,
      typeof input.label === "string" ? input.label : null,
      this.nowIso(),
      actor.ref,
    );
    return this.one("SELECT * FROM calendar_days WHERE id = ?", id)!;
  }

  // ---------- 里程碑版本 ----------

  recordMilestone(
    actor: Actor,
    cooperationRef: string,
    input: Input,
  ): Row {
    const side = this.sideOf(input.side);
    requireParty(actor, side);
    this.requireCooperation(cooperationRef);
    const code = this.codeOf(input.milestoneCode, "milestoneCode");
    if (typeof input.title !== "string" || input.title.trim().length === 0) {
      throw badRequest("invalid_title", "title 不能为空");
    }
    if (!isValidLocalDate(input.localDueDate)) throw badRequest("invalid_local_date", "localDueDate 格式必须为 YYYY-MM-DD");
    if (typeof input.requiredRole !== "string" || input.requiredRole.trim().length === 0) {
      throw badRequest("invalid_required_role", "requiredRole 不能为空");
    }
    const policy = input.holidayPolicy ?? "next_workday";
    if (policy !== "as_is" && policy !== "next_workday") {
      throw badRequest("invalid_holiday_policy", "holidayPolicy 必须为 as_is 或 next_workday");
    }
    const dependencies = this.normalizeDeps(cooperationRef, input.dependencies);

    this.db.exec("BEGIN");
    try {
      const seqRow = this.one(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM milestone_versions WHERE cooperation_ref = ? AND side = ? AND milestone_code = ?",
        cooperationRef,
        side,
        code,
      );
      const id = randomUUID();
      this.run(
        `INSERT INTO milestone_versions(id, cooperation_ref, side, milestone_code, seq, title, local_due_date,
             dependencies, required_role, holiday_policy, recorded_at, recorded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        cooperationRef,
        side,
        code,
        seqRow!.next_seq,
        input.title.trim(),
        input.localDueDate,
        JSON.stringify(dependencies),
        input.requiredRole.trim(),
        policy,
        this.nowIso(),
        actor.ref,
      );
      this.db.exec("COMMIT");
      return this.one("SELECT * FROM milestone_versions WHERE id = ?", id)!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private codeOf(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
      throw badRequest("invalid_code", `${field} 只能包含字母、数字、.、_、-（1-64 位）`);
    }
    return value;
  }

  private normalizeDeps(cooperationRef: string, value: unknown): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((d) => typeof d !== "string")) {
      throw badRequest("invalid_dependencies", "dependencies 必须为限定码字符串数组，如 [\"A:M1\"]");
    }
    const deps = value as string[];
    for (const dep of deps) {
      if (!/^(A|B):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(dep)) {
        throw badRequest("invalid_dependency", `依赖限定码格式非法：${dep}`);
      }
      const [side, code] = dep.split(":");
      const exists = this.one(
        "SELECT 1 FROM milestone_versions WHERE cooperation_ref = ? AND side = ? AND milestone_code = ? LIMIT 1",
        cooperationRef,
        side,
        code,
      );
      if (!exists) throw badRequest("unknown_dependency", `依赖的里程碑尚无任何版本：${dep}`);
    }
    if (new Set(deps).size !== deps.length) throw badRequest("duplicate_dependency", "依赖列表存在重复项");
    return deps;
  }

  // ---------- 交付清单 ----------

  recordDeliverables(
    actor: Actor,
    cooperationRef: string,
    input: Input,
  ): Row {
    const side = this.sideOf(input.side);
    requireParty(actor, side);
    this.requireCooperation(cooperationRef);
    const code = this.codeOf(input.milestoneCode, "milestoneCode");
    this.requireMilestone(cooperationRef, side, code);
    if (!Array.isArray(input.items)) throw badRequest("invalid_items", "items 必须为数组");
    const items: { itemCode: string; title: string }[] = [];
    const seen = new Set<string>();
    for (const raw of input.items) {
      if (!raw || typeof raw !== "object") throw badRequest("invalid_item", "交付项必须为对象");
      const item = raw as { itemCode?: unknown; title?: unknown };
      const itemCode = this.codeOf(item.itemCode, "itemCode");
      if (seen.has(itemCode)) throw badRequest("duplicate_item", `交付项编码重复：${itemCode}`);
      seen.add(itemCode);
      if (typeof item.title !== "string" || item.title.trim().length === 0) {
        throw badRequest("invalid_item_title", `交付项 ${itemCode} 的 title 不能为空`);
      }
      items.push({ itemCode, title: item.title.trim() });
    }
    const versionRow = this.one(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM deliverable_versions
       WHERE cooperation_ref = ? AND side = ? AND milestone_code = ?`,
      cooperationRef,
      side,
      code,
    );
    const id = randomUUID();
    this.run(
      `INSERT INTO deliverable_versions(id, cooperation_ref, side, milestone_code, version, items, recorded_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      cooperationRef,
      side,
      code,
      versionRow!.next_version,
      JSON.stringify(items),
      this.nowIso(),
      actor.ref,
    );
    return this.one("SELECT * FROM deliverable_versions WHERE id = ?", id)!;
  }

  private requireMilestone(cooperationRef: string, side: Side, code: string): Row {
    const row = this.one(
      `SELECT * FROM milestone_versions WHERE cooperation_ref = ? AND side = ? AND milestone_code = ?
       ORDER BY seq DESC LIMIT 1`,
      cooperationRef,
      side,
      code,
    );
    if (!row) throw notFound("milestone_not_found", `里程碑不存在：${side}:${code}`);
    return row;
  }

  // ---------- 签收回执（含重复检测） ----------

  recordReceipt(
    actor: Actor,
    cooperationRef: string,
    input: Input,
  ): Row {
    const side = this.sideOf(input.side);
    requireParty(actor, side);
    this.requireCooperation(cooperationRef);
    const code = this.codeOf(input.milestoneCode, "milestoneCode");
    this.requireMilestone(cooperationRef, side, code);
    this.assertDigest(input.digest);
    if (typeof input.sourceRef !== "string" || input.sourceRef.trim().length === 0) {
      throw badRequest("invalid_source_ref", "sourceRef 不能为空");
    }
    this.assertInstant(input.signedAt, "signedAt");
    let receivedAt = this.nowIso();
    if (input.receivedAt !== undefined) {
      this.assertInstant(input.receivedAt, "receivedAt");
      receivedAt = input.receivedAt;
    }
    let itemCode: string | null = null;
    if (input.itemCode !== undefined && input.itemCode !== null) {
      itemCode = this.codeOf(input.itemCode, "itemCode");
    }

    // 重复回执：同节点同交付项（或整包）同摘要的已 accepted 回执先到为准
    const existing = this.one(
      `SELECT id FROM receipts WHERE cooperation_ref = ? AND side = ? AND milestone_code = ?
         AND COALESCE(item_code, '') = COALESCE(?, '') AND digest = ? AND status = 'accepted'
       ORDER BY received_at ASC, recorded_at ASC LIMIT 1`,
      cooperationRef,
      side,
      code,
      itemCode,
      input.digest,
    );

    const id = randomUUID();
    this.run(
      `INSERT INTO receipts(id, cooperation_ref, side, milestone_code, item_code, digest, source_ref,
           signed_at, received_at, status, duplicate_of, recorded_at, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      cooperationRef,
      side,
      code,
      itemCode,
      input.digest,
      input.sourceRef.trim(),
      input.signedAt,
      receivedAt,
      existing ? "duplicate" : "accepted",
      existing ? (existing.id as string) : null,
      this.nowIso(),
      actor.ref,
    );
    return this.one("SELECT * FROM receipts WHERE id = ?", id)!;
  }

  // ---------- 角色确认 ----------

  recordConfirmation(
    actor: Actor,
    cooperationRef: string,
    input: Input,
  ): Row {
    const side = this.sideOf(input.side);
    requireParty(actor, side);
    this.requireCooperation(cooperationRef);
    const code = this.codeOf(input.milestoneCode, "milestoneCode");
    this.requireMilestone(cooperationRef, side, code);
    if (typeof input.role !== "string" || input.role.trim().length === 0) {
      throw badRequest("invalid_role", "role 不能为空");
    }
    if (input.decision !== "confirmed" && input.decision !== "rejected") {
      throw badRequest("invalid_decision", "decision 必须为 confirmed 或 rejected");
    }
    const id = randomUUID();
    this.run(
      `INSERT INTO confirmations(id, cooperation_ref, side, milestone_code, role, actor_ref, decision, note, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      cooperationRef,
      side,
      code,
      input.role.trim(),
      actor.ref,
      input.decision,
      typeof input.note === "string" ? input.note : null,
      this.nowIso(),
    );
    return this.one("SELECT * FROM confirmations WHERE id = ?", id)!;
  }

  // ---------- 跨方映射（共同确认） ----------

  proposeMapping(
    actor: Actor,
    cooperationRef: string,
    input: Input,
  ): Row {
    requireParty(actor, actor.side!);
    this.requireCooperation(cooperationRef);
    const nodeCode = this.codeOf(input.nodeCode ?? this.autoNodeCode(), "nodeCode");
    const sideACode = this.codeOf(input.sideACode, "sideACode");
    const sideBCode = this.codeOf(input.sideBCode, "sideBCode");
    this.requireMilestone(cooperationRef, "A", sideACode);
    this.requireMilestone(cooperationRef, "B", sideBCode);
    const amountCents = this.amountOf(input.amountCents);
    const governingSide = this.sideOf(input.governingSide);

    // 已作为拆分子节点（最新状态为 proposed/confirmed）的节点码不能开立/修订独立映射
    const splitRows = this.all(
      "SELECT rowid AS _seq, * FROM split_events WHERE cooperation_ref = ? AND child_node = ?",
      cooperationRef,
      nodeCode,
    );
    const liveSplitChild = foldSplits(splitRows.map(mapSplitEventRow)).some((s) => s.status !== "rejected");
    if (liveSplitChild) {
      throw conflict("node_is_split_child", `节点 ${nodeCode} 已是拆分子节点，不能开立独立映射`);
    }
    // 已有生效或协商中拆分的父节点，其映射修订需先处理拆分，避免子树悬空
    const parentSplitRows = this.all(
      "SELECT rowid AS _seq, * FROM split_events WHERE cooperation_ref = ? AND parent_node = ?",
      cooperationRef,
      nodeCode,
    );
    const liveParentSplit = foldSplits(parentSplitRows.map(mapSplitEventRow)).some((s) => s.status !== "rejected");
    if (liveParentSplit) {
      throw conflict("node_has_live_split", `节点 ${nodeCode} 存在未终结的拆分，不能修订映射`);
    }
    // 已确认映射允许由任一方重新提议修订（金额/管辖方/编码变更）：
    // 状态回到 proposed，必须经对方再次确认；修订期间该节点不产生付款结论。
    return this.appendMappingEvent(cooperationRef, nodeCode, "propose", actor.side!, {
      sideACode,
      sideBCode,
      amountCents,
      governingSide,
    });
  }

  private autoNodeCode(): string {
    return `N-${randomUUID().slice(0, 8)}`.toUpperCase();
  }

  private amountOf(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      throw badRequest("invalid_amount", "amountCents 必须为非负整数");
    }
    return value;
  }

  respondMapping(
    actor: Actor,
    cooperationRef: string,
    nodeCode: string,
    action: "confirm" | "reject",
  ): Row {
    requireParty(actor, actor.side!);
    this.requireCooperation(cooperationRef);
    const current = this.requireCurrentProposal(cooperationRef, nodeCode);
    if (current.proposedBy === actor.side) {
      throw conflict("cross_confirmation_required", "跨方映射必须由非提议方确认或拒绝");
    }
    return this.appendMappingEvent(cooperationRef, nodeCode, action, actor.side!, {
      sideACode: current.sideACode,
      sideBCode: current.sideBCode,
      amountCents: current.amountCents,
      governingSide: current.governingSide,
    });
  }

  private appendMappingEvent(
    cooperationRef: string,
    nodeCode: string,
    action: "propose" | "confirm" | "reject",
    actorSide: Side,
    payload: { sideACode: string; sideBCode: string; amountCents: number; governingSide: Side },
  ): Row {
    const at = this.nowIso();
    const id = randomUUID();
    this.run(
      `INSERT INTO cross_mapping_events(id, cooperation_ref, node_code, action, side_a_code, side_b_code,
           amount_cents, governing_side, actor_side, event_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      cooperationRef,
      nodeCode,
      action,
      payload.sideACode,
      payload.sideBCode,
      payload.amountCents,
      payload.governingSide,
      actorSide,
      at,
      at,
    );
    return this.one("SELECT rowid AS _seq, * FROM cross_mapping_events WHERE id = ?", id)!;
  }

  private currentMapping(cooperationRef: string, nodeCode: string): MappingFact | null {
    const rows = this.all(
      "SELECT rowid AS _seq, * FROM cross_mapping_events WHERE cooperation_ref = ? AND node_code = ?",
      cooperationRef,
      nodeCode,
    );
    const facts = foldMappings(rows.map(mapMappingEventRow));
    return facts[0] ?? null;
  }

  private requireCurrentProposal(cooperationRef: string, nodeCode: string): MappingFact {
    const current = this.currentMapping(cooperationRef, nodeCode);
    if (!current) throw notFound("mapping_not_found", `节点映射不存在：${nodeCode}`);
    if (current.status !== "proposed") {
      throw conflict("mapping_not_pending", `节点 ${nodeCode} 当前状态为 ${current.status}，无需响应`);
    }
    return current;
  }

  // ---------- 里程碑拆分 ----------

  proposeSplit(
    actor: Actor,
    cooperationRef: string,
    input: Input,
  ): Row {
    requireParty(actor, actor.side!);
    this.requireCooperation(cooperationRef);
    const parentNode = this.codeOf(input.parentNode, "parentNode");
    const childNode = this.codeOf(input.childNode, "childNode");
    const sideACode = this.codeOf(input.sideACode, "sideACode");
    const sideBCode = this.codeOf(input.sideBCode, "sideBCode");
    const weight = this.weightOf(input.weight);
    const parent = this.currentMapping(cooperationRef, parentNode);
    if (!parent || parent.status !== "confirmed") {
      throw badRequest("parent_not_confirmed", `父节点 ${parentNode} 尚不是已确认映射，不能拆分`);
    }
    this.requireMilestone(cooperationRef, "A", sideACode);
    this.requireMilestone(cooperationRef, "B", sideBCode);
    if (childNode === parentNode) throw badRequest("invalid_split", "子节点不能与父节点同名");
    const childMapping = this.currentMapping(cooperationRef, childNode);
    if (childMapping && childMapping.status !== "rejected") {
      throw conflict("child_is_mapping_node", `子节点 ${childNode} 已是${childMapping.status === "confirmed" ? "确认" : "提议中"}的映射节点，不能作为拆分子节点`);
    }
    const currentSplit = this.currentSplit(cooperationRef, parentNode, childNode);
    if (currentSplit?.status === "confirmed") {
      throw conflict("split_already_confirmed", `拆分 ${parentNode}→${childNode} 已共同确认`);
    }
    return this.appendSplitEvent(cooperationRef, "propose", actor.side!, {
      parentNode,
      childNode,
      weight,
      sideACode,
      sideBCode,
    });
  }

  private weightOf(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 10000) {
      throw badRequest("invalid_weight", "weight 必须为 1-10000 的整数（基点，10000=100%）");
    }
    return value;
  }

  respondSplit(
    actor: Actor,
    cooperationRef: string,
    parentNode: string,
    childNode: string,
    action: "confirm" | "reject",
  ): Row {
    requireParty(actor, actor.side!);
    this.requireCooperation(cooperationRef);
    const current = this.currentSplit(cooperationRef, parentNode, childNode);
    if (!current) throw notFound("split_not_found", `拆分提议不存在：${parentNode}→${childNode}`);
    if (current.status !== "proposed") {
      throw conflict("split_not_pending", `拆分 ${parentNode}→${childNode} 当前状态为 ${current.status}`);
    }
    if (current.proposedBy === actor.side) {
      throw conflict("cross_confirmation_required", "拆分必须由非提议方确认或拒绝");
    }
    // 权重完整性不在写入时阻断：子拆分可逐条共同确认，是否齐备由重算引擎按
    // 「无未决提议且已确认权重恰为 10000」判定；此处只拒绝不可能再补齐的超额确认。
    if (action === "confirm") {
      const alreadyConfirmed = this.splitsForParent(cooperationRef, parentNode)
        .filter((s) => s.status === "confirmed" && s.childNode !== childNode)
        .reduce((sum, s) => sum + s.weight, 0);
      if (alreadyConfirmed + current.weight > 10000) {
        throw conflict(
          "split_weight_exceeded",
          `确认后 ${parentNode} 已确认子拆分权重之和超过 10000 基点`,
          { confirmedBasisPoints: alreadyConfirmed, incomingBasisPoints: current.weight },
        );
      }
    }
    return this.appendSplitEvent(cooperationRef, action, actor.side!, {
      parentNode,
      childNode,
      weight: current.weight,
      sideACode: current.sideACode,
      sideBCode: current.sideBCode,
    });
  }

  private appendSplitEvent(
    cooperationRef: string,
    action: "propose" | "confirm" | "reject",
    actorSide: Side,
    payload: { parentNode: string; childNode: string; weight: number; sideACode: string; sideBCode: string },
  ): Row {
    const at = this.nowIso();
    const id = randomUUID();
    this.run(
      `INSERT INTO split_events(id, cooperation_ref, parent_node, child_node, weight, side_a_code, side_b_code,
           action, actor_side, event_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      cooperationRef,
      payload.parentNode,
      payload.childNode,
      payload.weight,
      payload.sideACode,
      payload.sideBCode,
      action,
      actorSide,
      at,
      at,
    );
    return this.one("SELECT rowid AS _seq, * FROM split_events WHERE id = ?", id)!;
  }

  private currentSplit(cooperationRef: string, parentNode: string, childNode: string) {
    const rows = this.all(
      "SELECT rowid AS _seq, * FROM split_events WHERE cooperation_ref = ? AND parent_node = ? AND child_node = ?",
      cooperationRef,
      parentNode,
      childNode,
    );
    return foldSplits(rows.map(mapSplitEventRow))[0] ?? null;
  }

  private splitsForParent(cooperationRef: string, parentNode: string) {
    const rows = this.all(
      "SELECT rowid AS _seq, * FROM split_events WHERE cooperation_ref = ? AND parent_node = ?",
      cooperationRef,
      parentNode,
    );
    return foldSplits(rows.map(mapSplitEventRow));
  }

  // ---------- 异议 ----------

  openObjection(
    actor: Actor,
    cooperationRef: string,
    input: Input,
  ): Row {
    requireParty(actor, actor.side!);
    this.requireCooperation(cooperationRef);
    const nodeCode = this.codeOf(input.nodeCode, "nodeCode");
    this.assertDigest(input.reasonDigest);
    this.requireKnownNode(cooperationRef, nodeCode);
    for (const o of this.openObjectionsFor(cooperationRef, nodeCode)) {
      if (o.side === actor.side) {
        throw conflict("objection_already_open", `${actor.side} 方对节点 ${nodeCode} 已有未撤回异议：${o.id}`);
      }
    }
    const at = this.nowIso();
    const id = randomUUID();
    this.run(
      `INSERT INTO objection_events(id, cooperation_ref, node_code, action, open_objection_id, side,
           reason_digest, detail_ref, event_at, recorded_by, recorded_at)
       VALUES (?, ?, ?, 'open', NULL, ?, ?, ?, ?, ?, ?)`,
      id,
      cooperationRef,
      nodeCode,
      actor.side,
      input.reasonDigest,
      typeof input.detailRef === "string" ? input.detailRef : null,
      at,
      actor.ref,
      at,
    );
    return this.one("SELECT rowid AS _seq, * FROM objection_events WHERE id = ?", id)!;
  }

  withdrawObjection(actor: Actor, cooperationRef: string, objectionId: string): Row {
    requireParty(actor, actor.side!);
    const openEvent = this.one(
      "SELECT rowid AS _seq, * FROM objection_events WHERE id = ? AND action = 'open'",
      objectionId,
    );
    if (!openEvent || openEvent.cooperation_ref !== cooperationRef) {
      throw notFound("objection_not_found", `异议不存在：${objectionId}`);
    }
    if (openEvent.side !== actor.side) {
      throw conflict("objection_ownership", "只能撤回本方提出的异议");
    }
    const withdrawn = this.one(
      "SELECT 1 FROM objection_events WHERE open_objection_id = ? AND action = 'withdraw' LIMIT 1",
      objectionId,
    );
    if (withdrawn) throw conflict("objection_already_withdrawn", `异议 ${objectionId} 已撤回`);
    const at = this.nowIso();
    const id = randomUUID();
    this.run(
      `INSERT INTO objection_events(id, cooperation_ref, node_code, action, open_objection_id, side,
           reason_digest, detail_ref, event_at, recorded_by, recorded_at)
       VALUES (?, ?, ?, 'withdraw', ?, ?, NULL, NULL, ?, ?, ?)`,
      id,
      cooperationRef,
      openEvent.node_code,
      objectionId,
      actor.side,
      at,
      actor.ref,
      at,
    );
    return this.one("SELECT rowid AS _seq, * FROM objection_events WHERE id = ?", id)!;
  }

  private openObjectionsFor(cooperationRef: string, nodeCode: string) {
    const rows = this.all(
      "SELECT rowid AS _seq, * FROM objection_events WHERE cooperation_ref = ? AND node_code = ?",
      cooperationRef,
      nodeCode,
    );
    return foldObjections(rows.map(mapObjectionEventRow)).filter((o) => o.status === "open");
  }

  /** 节点必须来自已确认映射，或当前折叠状态为已确认的拆分子节点。 */
  private requireKnownNode(cooperationRef: string, nodeCode: string): void {
    const mapping = this.currentMapping(cooperationRef, nodeCode);
    if (mapping?.status === "confirmed") return;
    const childRows = this.all(
      "SELECT rowid AS _seq, * FROM split_events WHERE cooperation_ref = ? AND child_node = ?",
      cooperationRef,
      nodeCode,
    );
    const liveConfirmedChild = foldSplits(childRows.map(mapSplitEventRow)).some((s) => s.status === "confirmed");
    if (liveConfirmedChild) return;
    throw notFound("node_not_found", `节点不存在或尚未共同确认：${nodeCode}`);
  }

  // ---------- 快照 ----------

  snapshot(cooperationRef: string, asOf: number): Snapshot {
    this.requireCooperation(cooperationRef);
    const t = new Date(asOf).toISOString();

    const calendars = {} as Record<Side, CalendarSnapshot | null>;
    for (const side of SIDES) {
      const party = this.one(
        "SELECT * FROM party_versions WHERE side = ? AND recorded_at <= ? ORDER BY recorded_at DESC, id DESC LIMIT 1",
        side,
        t,
      );
      if (!party) {
        calendars[side] = null;
        continue;
      }
      const overrideRows = this.all(
        `SELECT * FROM calendar_days WHERE side = ? AND recorded_at <= ?
         ORDER BY local_date, recorded_at, id`,
        side,
        t,
      );
      const overrides: CalendarSnapshot["overrides"] = {};
      for (const row of overrideRows) {
        overrides[row.local_date as string] = row.kind as "holiday" | "workday"; // 后写覆盖
      }
      calendars[side] = {
        side,
        ianaTimezone: party.iana_timezone as string,
        weekendDays: JSON.parse(party.weekend_days as string) as number[],
        overrides,
      };
    }

    const milestones = this.latestPerKey<MilestoneFact>(
      this.all(
        `SELECT * FROM milestone_versions WHERE cooperation_ref = ? AND recorded_at <= ?
         ORDER BY side, milestone_code, seq DESC, recorded_at DESC`,
        cooperationRef,
        t,
      ).map(mapMilestoneRow),
      (m) => `${m.side}:${m.milestoneCode}`,
    );

    const deliverables = this.latestPerKey<DeliverableFact>(
      this.all(
        `SELECT * FROM deliverable_versions WHERE cooperation_ref = ? AND recorded_at <= ?
         ORDER BY side, milestone_code, version DESC, recorded_at DESC`,
        cooperationRef,
        t,
      ).map(mapDeliverableRow),
      (d) => `${d.side}:${d.milestoneCode}`,
    );

    const receipts: ReceiptFact[] = this.all(
      "SELECT * FROM receipts WHERE cooperation_ref = ? AND recorded_at <= ? ORDER BY recorded_at, id",
      cooperationRef,
      t,
    ).map(mapReceiptRow);

    const confirmations: ConfirmationFact[] = this.all(
      "SELECT * FROM confirmations WHERE cooperation_ref = ? AND recorded_at <= ? ORDER BY recorded_at, id",
      cooperationRef,
      t,
    ).map(mapConfirmationRow);

    const mappings = foldMappings(
      this.all(
        "SELECT rowid AS _seq, * FROM cross_mapping_events WHERE cooperation_ref = ? AND recorded_at <= ? ORDER BY event_at, id",
        cooperationRef,
        t,
      ).map(mapMappingEventRow),
    );

    const splits = foldSplits(
      this.all(
        "SELECT rowid AS _seq, * FROM split_events WHERE cooperation_ref = ? AND recorded_at <= ? ORDER BY event_at, id",
        cooperationRef,
        t,
      ).map(mapSplitEventRow),
    );

    const objections = foldObjections(
      this.all(
        "SELECT rowid AS _seq, * FROM objection_events WHERE cooperation_ref = ? AND recorded_at <= ? ORDER BY event_at, id",
        cooperationRef,
        t,
      ).map(mapObjectionEventRow),
    );

    return {
      cooperationRef,
      asOf,
      calendars,
      milestones,
      deliverables,
      receipts,
      confirmations,
      mappings,
      splits,
      objections,
    };
  }

  private latestPerKey<T>(rowsInOrder: T[], keyOf: (row: T) => string): T[] {
    const picked = new Map<string, T>();
    for (const row of rowsInOrder) {
      const key = keyOf(row);
      if (!picked.has(key)) picked.set(key, row); // SQL 已按版本倒序
    }
    return [...picked.values()];
  }

  // ---------- 结算批次 ----------

  openBatch(actor: Actor, input: Input): Row {
    requireOwner(actor);
    const cooperationRef = String(input.cooperationRef ?? "");
    const coop = this.requireCooperation(cooperationRef);
    const id = input.id?.toString().trim() ?? `BATCH-${randomUUID().slice(0, 8)}`.toUpperCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
      throw badRequest("invalid_batch_id", "批次编号只能包含字母、数字、.、_、-（1-64 位）");
    }
    if (this.one("SELECT 1 FROM settlement_batches WHERE id = ?", id)) {
      throw conflict("batch_exists", `批次编号已存在：${id}`);
    }
    const currency = input.currency ? String(input.currency).toUpperCase() : (coop.currency as string);
    this.run(
      `INSERT INTO settlement_batches(id, cooperation_ref, currency, status, rule_version, note, opened_at, closed_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, NULL)`,
      id,
      cooperationRef,
      currency,
      RULE_VERSION,
      typeof input.note === "string" ? input.note : null,
      this.nowIso(),
    );
    return this.one("SELECT * FROM settlement_batches WHERE id = ?", id)!;
  }

  private requireBatch(id: string): Row {
    const batch = this.one("SELECT * FROM settlement_batches WHERE id = ?", id);
    if (!batch) throw notFound("batch_not_found", `结算批次不存在：${id}`);
    return batch;
  }

  /** open 批次重算：插入新的 recompute_seq 行，历史行保留。 */
  recomputeBatch(actor: Actor, batchId: string): Row {
    requireOwner(actor);
    const batch = this.requireBatch(batchId);
    if (batch.status !== "open") throw conflict("batch_closed", "批次已关闭，不能重算；请使用冲正与替代记录");
    this.computeIntoBatch(batch);
    return this.requireBatch(batchId);
  }

  private computeIntoBatch(batch: Row, fixedAsOf?: number): number {
    const asOf = fixedAsOf ?? this.clock();
    const snapshotData = this.snapshot(batch.cooperation_ref as string, asOf);
    const conclusions = recompute(snapshotData);

    const priorRows = this.all(
      "SELECT node_code, MAX(recompute_seq) AS max_seq, status FROM payment_conclusions WHERE batch_id = ? GROUP BY node_code",
      batch.id,
    );
    // SQLite 中聚合查询里的 status 不保证来自最大 seq 行，逐节点再取一次最新状态
    const priorSeq = new Map<string, number>();
    const priorStatus = new Map<string, string>();
    for (const r of priorRows) {
      const latest = this.one(
        "SELECT status FROM payment_conclusions WHERE batch_id = ? AND node_code = ? ORDER BY recompute_seq DESC LIMIT 1",
        batch.id,
        r.node_code,
      )!;
      priorSeq.set(r.node_code as string, Number(r.max_seq));
      priorStatus.set(r.node_code as string, latest.status as string);
    }

    this.db.exec("BEGIN");
    try {
      this.writeConclusions(batch, asOf, conclusions, priorSeq, priorStatus);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return asOf;
  }

  /** 在当前事务内写入本轮结论；可被关闭批次的外层事务复用。 */
  private writeConclusions(
    batch: Row,
    asOf: number,
    conclusions: NodeConclusion[],
    priorSeq: Map<string, number>,
    priorStatus: Map<string, string>,
  ): void {
    const present = new Set(conclusions.map((c) => c.nodeCode));
    for (const conclusion of conclusions) {
      const seq = (priorSeq.get(conclusion.nodeCode) ?? 0) + 1;
      this.insertConclusion(batch.id as string, seq, asOf, conclusion, "payment_conclusions");
      priorSeq.set(conclusion.nodeCode, seq);
      priorStatus.set(conclusion.nodeCode, conclusion.status);
    }
    // 曾在本批次出现、当前已不再映射的节点留痕一次 superseded（已标记过不重复追加）
    for (const [nodeCode] of priorSeq) {
      if (!present.has(nodeCode) && priorStatus.get(nodeCode) !== "superseded") {
        const seq = priorSeq.get(nodeCode)! + 1;
        this.run(
          `INSERT INTO payment_conclusions(id, batch_id, node_code, recompute_seq, status, amount_cents,
               reasons, evidence_snapshot, evidence_as_of, rule_version, computed_at)
           VALUES (?, ?, ?, ?, 'superseded', NULL, ?, ?, ?, ?, ?)`,
          randomUUID(),
          batch.id,
          nodeCode,
          seq,
          JSON.stringify([{ code: "node_no_longer_mapped" }]),
          JSON.stringify({ asOf: new Date(asOf).toISOString() }),
          new Date(asOf).toISOString(),
          RULE_VERSION,
          this.nowIso(),
        );
        priorSeq.set(nodeCode, seq);
        priorStatus.set(nodeCode, "superseded");
      }
    }
  }

  private insertConclusion(batchId: string, seq: number, asOf: number, conclusion: NodeConclusion, table: string): string {
    const id = randomUUID();
    const sql = `INSERT INTO ${table}(id, batch_id, node_code, recompute_seq, status, amount_cents, reasons,
         evidence_snapshot, evidence_as_of, rule_version, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.run(
      sql,
      id,
      batchId,
      conclusion.nodeCode,
      seq,
      conclusion.status,
      conclusion.amountCents,
      JSON.stringify(conclusion.reasons),
      JSON.stringify(conclusion.evidence),
      new Date(asOf).toISOString(),
      RULE_VERSION,
      this.nowIso(),
    );
    return id;
  }

  closeBatch(actor: Actor, batchId: string): Row {
    requireOwner(actor);
    const batch = this.requireBatch(batchId);
    if (batch.status !== "open") throw conflict("batch_closed", "批次已关闭");
    // closed_at 与最终一轮证据截止时刻严格相同，保证按 closed_at 重放可复现关闭时结论
    const asOf = this.clock();
    this.computeIntoBatch(batch, asOf);
    this.run("UPDATE settlement_batches SET status = 'closed', closed_at = ? WHERE id = ?", new Date(asOf).toISOString(), batchId);
    return this.requireBatch(batchId);
  }

  // ---------- 冲正与替代 ----------

  reverseConclusion(
    actor: Actor,
    batchId: string,
    input: Input,
  ): { reversal: Row; replacement: NodeConclusion; original: Row } {
    requireOwner(actor);
    const batch = this.requireBatch(batchId);
    if (batch.status !== "closed") {
      throw conflict("batch_not_closed", "仅已关闭批次的结论需要冲正；open 批次可直接重算");
    }
    const nodeCode = this.codeOf(input.nodeCode, "nodeCode");
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw badRequest("invalid_reason", "冲正原因不能为空");
    }
    const original = this.one(
      "SELECT * FROM payment_conclusions WHERE batch_id = ? AND node_code = ? ORDER BY recompute_seq DESC LIMIT 1",
      batchId,
      nodeCode,
    );
    if (!original) throw notFound("conclusion_not_found", `批次中没有节点 ${nodeCode} 的结论`);
    if (this.one("SELECT 1 FROM reversals WHERE original_conclusion_id = ?", original.id)) {
      throw conflict("already_reversed", `结论 ${original.id} 已冲正，不能重复冲正`);
    }

    const asOf = this.clock();
    const snapshotData = this.snapshot(batch.cooperation_ref as string, asOf);
    const conclusion = recompute(snapshotData).find((c) => c.nodeCode === nodeCode);
    if (!conclusion) throw conflict("node_gone", `节点 ${nodeCode} 在当前证据下已不存在映射，无法生成替代结论`);

    const at = this.nowIso();
    this.db.exec("BEGIN");
    try {
      const reversalId = randomUUID();
      this.run(
        `INSERT INTO reversals(id, original_conclusion_id, batch_id, node_code, reason, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        reversalId,
        original.id,
        batchId,
        nodeCode,
        input.reason.trim(),
        actor.ref,
        at,
      );
      const replacementId = randomUUID();
      this.run(
        `INSERT INTO replacement_conclusions(id, reversal_id, batch_id, node_code, status, amount_cents, reasons,
             evidence_snapshot, evidence_as_of, rule_version, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        replacementId,
        reversalId,
        batchId,
        nodeCode,
        conclusion.status,
        conclusion.amountCents,
        JSON.stringify(conclusion.reasons),
        JSON.stringify({ ...conclusion.evidence, reversalReason: input.reason.trim() }),
        new Date(asOf).toISOString(),
        RULE_VERSION,
        at,
      );
      this.db.exec("COMMIT");
      return {
        reversal: this.one("SELECT * FROM reversals WHERE id = ?", reversalId)!,
        replacement: conclusion,
        original,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------- 重放 ----------

  replayBatch(actor: Actor, batchId: string): Row {
    requireOwner(actor);
    const batch = this.requireBatch(batchId);
    // closed 批次严格按关闭时刻重放当时证据；open 批次按当前时刻重放（其结论尚在变动中）
    const asOf = batch.status === "closed" && batch.closed_at ? parseInstant(batch.closed_at as string) : this.clock();
    const asOfIso = new Date(asOf).toISOString();
    if (batch.rule_version !== RULE_VERSION) {
      throw conflict(
        "rule_version_unsupported",
        `批次规则版本 ${batch.rule_version} 与当前引擎 ${RULE_VERSION} 不同，历史版本待归档`,
      );
    }
    const snapshotData = this.snapshot(batch.cooperation_ref as string, asOf);
    const replayed = recompute(snapshotData);

    // 与批次关闭时固化的结论逐节点对比。
    // open 期间消失的节点在库中留痕为 node_no_longer_mapped/superseded，重放时理应缺席，属一致。
    const storedRows = this.all(
      "SELECT * FROM payment_conclusions WHERE batch_id = ?",
      batchId,
    );
    const latestByNode = new Map<string, Row>();
    for (const row of storedRows) {
      const prev = latestByNode.get(row.node_code as string);
      if (!prev || Number(row.recompute_seq) > Number(prev.recompute_seq)) latestByNode.set(row.node_code as string, row);
    }
    const replayedByNode = new Map(replayed.map((c) => [c.nodeCode, c]));

    let matches = true;
    const details: Record<string, unknown>[] = [];
    for (const [nodeCode, s] of latestByNode) {
      const goneMarker = Array.isArray(safeParse(s.reasons))
        ? (safeParse(s.reasons) as Row[]).some((r) => r?.code === "node_no_longer_mapped")
        : false;
      const c = replayedByNode.get(nodeCode);
      let same: boolean;
      if (goneMarker) {
        same = c === undefined; // 关闭时已不存在的节点，重放必须同样缺席
      } else {
        same = c !== undefined && s.status === c.status && Number(s.amount_cents ?? -1) === (c.amountCents ?? -1);
      }
      details.push({
        nodeCode,
        stored: { status: s.status, amountCents: s.amount_cents, goneMarker },
        replayed: c ? { status: c.status, amountCents: c.amountCents } : null,
        match: same,
      });
      if (!same) matches = false;
    }
    for (const c of replayed) {
      if (!latestByNode.has(c.nodeCode)) {
        matches = false;
        details.push({
          nodeCode: c.nodeCode,
          stored: null,
          replayed: { status: c.status, amountCents: c.amountCents },
          match: false,
        });
      }
    }
    details.sort((a, b) => String(a.nodeCode).localeCompare(String(b.nodeCode)));

    const late = this.lateEvidence(batch.cooperation_ref as string, asOf);
    const runId = randomUUID();
    this.run(
      `INSERT INTO replay_runs(id, batch_id, evidence_as_of, rule_version, request_actor, conclusions,
           late_evidence, matches_original, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      batchId,
      asOfIso,
      RULE_VERSION,
      actor.ref,
      JSON.stringify(details.length > 0 ? details : replayed.map((c) => ({ nodeCode: c.nodeCode, status: c.status, amountCents: c.amountCents }))),
      JSON.stringify(late),
      matches ? 1 : 0,
      this.nowIso(),
    );
    const row = this.one("SELECT * FROM replay_runs WHERE id = ?", runId)!;
    return {
      ...row,
      conclusions: safeParse(row.conclusions),
      late_evidence: safeParse(row.late_evidence),
      matches_original: matches ? 1 : 0,
    };
  }

  /** 截止时刻之后登记的证据（重放中必须被剔除）。 */
  private lateEvidence(cooperationRef: string, asOf: number) {
    const t = new Date(asOf).toISOString();
    const pick = (table: string, label: string) =>
      this.all(
        `SELECT id, recorded_at AS recordedAt FROM ${table}
         WHERE cooperation_ref = ? AND recorded_at > ?`,
        cooperationRef,
        t,
      ).map((r) => ({ type: label, id: r.id as string, recordedAt: r.recordedAt as string }));
    // calendar_days / party_versions 是全局按 side 登记的本方事实，无 cooperation_ref 列
    const pickGlobal = (table: string, label: string) =>
      this.all(`SELECT id, recorded_at AS recordedAt FROM ${table} WHERE recorded_at > ?`, t).map((r) => ({
        type: label,
        id: r.id as string,
        recordedAt: r.recordedAt as string,
      }));
    return {
      asOf: t,
      items: [
        ...pick("milestone_versions", "milestone_version"),
        ...pick("deliverable_versions", "deliverable_version"),
        ...pick("receipts", "receipt"),
        ...pick("confirmations", "confirmation"),
        ...pick("cross_mapping_events", "mapping_event"),
        ...pick("split_events", "split_event"),
        ...pick("objection_events", "objection_event"),
        ...pickGlobal("calendar_days", "calendar_day"),
        ...pickGlobal("party_versions", "party_version"),
      ],
    };
  }

  // ---------- 差异溯源 ----------

  traceNode(actor: Actor, cooperationRef: string, nodeCode: string): unknown {
    requireOwner(actor);
    this.requireCooperation(cooperationRef);
    const now = this.clock();
    const snapshotData = this.snapshot(cooperationRef, now);
    const current = recompute(snapshotData).find((c) => c.nodeCode === nodeCode);
    const mappingEvents = this.all(
      "SELECT rowid AS _seq, * FROM cross_mapping_events WHERE cooperation_ref = ? AND node_code = ? ORDER BY event_at, id",
      cooperationRef,
      nodeCode,
    ).map(mapMappingEventRow);
    const splitEvents = this.all(
      "SELECT rowid AS _seq, * FROM split_events WHERE cooperation_ref = ? AND (parent_node = ? OR child_node = ?) ORDER BY event_at, id",
      cooperationRef,
      nodeCode,
      nodeCode,
    ).map(mapSplitEventRow);
    const objectionEvents = this.all(
      "SELECT rowid AS _seq, * FROM objection_events WHERE cooperation_ref = ? AND node_code = ? ORDER BY event_at, id",
      cooperationRef,
      nodeCode,
    ).map(mapObjectionEventRow);
    const batches = this.all(
      `SELECT b.id AS batch_id, b.status, b.closed_at, pc.status AS conclusion_status, pc.amount_cents,
              pc.reasons, pc.evidence_as_of, pc.rule_version
       FROM settlement_batches b
       JOIN payment_conclusions pc ON pc.batch_id = b.id
       WHERE b.cooperation_ref = ? AND pc.node_code = ?
       ORDER BY b.opened_at, pc.recompute_seq`,
      cooperationRef,
      nodeCode,
    ).map((r) => ({ ...r, reasons: safeParse(r.reasons) }));
    const reversals = this.all(
      `SELECT r.*, rc.status AS replacement_status, rc.amount_cents AS replacement_amount,
              rc.reasons AS replacement_reasons, rc.evidence_as_of AS replacement_as_of
       FROM reversals r JOIN replacement_conclusions rc ON rc.reversal_id = r.id
       WHERE r.batch_id IN (SELECT id FROM settlement_batches WHERE cooperation_ref = ?) AND r.node_code = ?
       ORDER BY r.recorded_at`,
      cooperationRef,
      nodeCode,
    ).map((r) => ({ ...r, replacement_reasons: safeParse(r.replacement_reasons) }));

    return {
      nodeCode,
      generatedAt: this.nowIso(),
      currentConclusion: current ?? null,
      timeline: {
        mappingEvents,
        splitEvents,
        objectionEvents,
      },
      batchHistory: batches,
      reversals,
    };
  }

  cooperationView(actor: Actor, cooperationRef: string, asOfRaw?: unknown): unknown {
    this.requireCooperation(cooperationRef);
    const asOf = asOfRaw === undefined ? this.clock() : parseInstant(String(asOfRaw));
    if (actor.role !== "owner" && actor.side !== "A" && actor.side !== "B") {
      throw badRequest("actor_invalid", "无效调用方");
    }
    const snapshotData = this.snapshot(cooperationRef, asOf);
    const conclusions = recompute(snapshotData);
    return {
      cooperationRef,
      asOf: new Date(asOf).toISOString(),
      ruleVersion: RULE_VERSION,
      actor: { ref: actor.ref, side: actor.side, role: actor.role },
      calendars: snapshotData.calendars,
      conclusions,
    };
  }

  getBatch(actor: Actor, batchId: string): unknown {
    const batch = this.requireBatch(batchId);
    const rows: Row[] = this.all(
      "SELECT * FROM payment_conclusions WHERE batch_id = ? ORDER BY node_code, recompute_seq",
      batchId,
    ).map((r) => ({ ...r, reasons: safeParse(r.reasons), evidence_snapshot: safeParse(r.evidence_snapshot) }));
    const latest = new Map<string, Row>();
    for (const r of rows) {
      const prev = latest.get(r.node_code as string);
      if (!prev || Number(r.recompute_seq) > Number(prev.recompute_seq)) latest.set(r.node_code as string, r);
    }
    const reversals = this.all("SELECT * FROM reversals WHERE batch_id = ? ORDER BY recorded_at", batchId).map((r) => {
      const replacement = this.one("SELECT * FROM replacement_conclusions WHERE reversal_id = ?", r.id);
      return {
        ...r,
        replacement: replacement
          ? { ...replacement, reasons: safeParse(replacement.reasons), evidence_snapshot: safeParse(replacement.evidence_snapshot) }
          : null,
      };
    });
    const replays = this.all("SELECT id, evidence_as_of, rule_version, matches_original, ran_at FROM replay_runs WHERE batch_id = ? ORDER BY ran_at", batchId);
    return {
      batch,
      latestConclusions: [...latest.values()],
      conclusionRevisions: rows,
      reversals,
      replays,
      viewer: actor.ref,
    };
  }
}

function safeParse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// ---------- 行映射 ----------

function num(value: unknown): number {
  return typeof value === "number" ? value : Date.parse(String(value));
}

function mapMilestoneRow(r: Row): MilestoneFact {
  return {
    versionId: r.id as string,
    seq: Number(r.seq),
    side: r.side as Side,
    milestoneCode: r.milestone_code as string,
    title: r.title as string,
    localDueDate: r.local_due_date as string,
    dependencies: safeParse(r.dependencies) as string[],
    requiredRole: r.required_role as string,
    holidayPolicy: r.holiday_policy as "as_is" | "next_workday",
    recordedAt: num(r.recorded_at),
  };
}

function mapDeliverableRow(r: Row): DeliverableFact {
  return {
    versionId: r.id as string,
    version: Number(r.version),
    side: r.side as Side,
    milestoneCode: r.milestone_code as string,
    items: safeParse(r.items) as DeliverableFact["items"],
    recordedAt: num(r.recorded_at),
  };
}

function mapReceiptRow(r: Row): ReceiptFact {
  return {
    id: r.id as string,
    side: r.side as Side,
    milestoneCode: r.milestone_code as string,
    itemCode: (r.item_code as string | null) ?? null,
    digest: r.digest as string,
    sourceRef: r.source_ref as string,
    signedAt: num(r.signed_at),
    receivedAt: num(r.received_at),
    status: r.status as "accepted" | "duplicate",
    duplicateOf: (r.duplicate_of as string | null) ?? null,
    recordedAt: num(r.recorded_at),
  };
}

function mapConfirmationRow(r: Row): ConfirmationFact {
  return {
    id: r.id as string,
    side: r.side as Side,
    milestoneCode: r.milestone_code as string,
    role: r.role as string,
    actorRef: r.actor_ref as string,
    decision: r.decision as "confirmed" | "rejected",
    note: (r.note as string | null) ?? null,
    recordedAt: num(r.recorded_at),
  };
}

function mapMappingEventRow(r: Row): RawMappingEvent {
  return {
    id: r.id as string,
    seq: Number(r._seq),
    nodeCode: r.node_code as string,
    action: r.action as RawMappingEvent["action"],
    sideACode: r.side_a_code as string,
    sideBCode: r.side_b_code as string,
    amountCents: Number(r.amount_cents),
    governingSide: r.governing_side as Side,
    actorSide: r.actor_side as Side,
    eventAt: num(r.event_at),
    recordedAt: num(r.recorded_at),
  };
}

function mapSplitEventRow(r: Row): RawSplitEvent {
  return {
    id: r.id as string,
    seq: Number(r._seq),
    parentNode: r.parent_node as string,
    childNode: r.child_node as string,
    weight: Number(r.weight),
    sideACode: r.side_a_code as string,
    sideBCode: r.side_b_code as string,
    action: r.action as RawSplitEvent["action"],
    actorSide: r.actor_side as Side,
    eventAt: num(r.event_at),
    recordedAt: num(r.recorded_at),
  };
}

function mapObjectionEventRow(r: Row): RawObjectionEvent {
  return {
    id: r.id as string,
    seq: Number(r._seq),
    nodeCode: r.node_code as string,
    action: r.action as RawObjectionEvent["action"],
    openObjectionId: (r.open_objection_id as string | null) ?? null,
    side: r.side as Side,
    reasonDigest: (r.reason_digest as string | null) ?? null,
    detailRef: (r.detail_ref as string | null) ?? null,
    eventAt: num(r.event_at),
    recordedAt: num(r.recorded_at),
  };
}
