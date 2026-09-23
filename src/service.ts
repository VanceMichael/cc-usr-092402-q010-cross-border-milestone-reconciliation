
// 领域服务：证据汇聚、幂等重算、可付款派生、争议冻结集群、
// 里程碑拆分、结算批次关闭/重放、冲正与替代。

import { DatabaseSync } from "node:sqlite";
import { evaluate, CURRENT_RULE_VERSION, type EvalInput } from "./engine.js";
import { conflict, notFound } from "./errors.js";
import { all, audit, get, newId, run, tx } from "./repo.js";
import { nowIso, parseInstant } from "./time.js";
import type {
  CalendarRow,
  ConclusionConfirmationRow,
  ConclusionRow,
  DeliveryEventRow,
  DeliveryItemRow,
  DependencyRow,
  DisputeFreezeRow,
  DisputeRow,
  FactCorrectionRow,
  HolidayRow,
  MappingConfirmationRow,
  MappingRow,
  MilestoneVersionRow,
  ReceiptRow,
  ReversalRow,
  SettlementBatchRow,
  SettlementEntryRow,
} from "./types.js";

// ---------------------------------------------------------------------------
// 证据汇聚
// ---------------------------------------------------------------------------

export function gatherEvalInput(
  db: DatabaseSync,
  version: MilestoneVersionRow,
  cutoffMs: number | null,
  memo: Map<string, EvalInput> = new Map(),
): EvalInput {
  const cached = memo.get(version.id);
  if (cached) return cached;

  const calendar = get<CalendarRow>(db, "SELECT * FROM calendars WHERE id = ?", version.calendar_id);
  if (!calendar) throw notFound(`日历不存在：${version.calendar_id}`);
  const holidays = all<HolidayRow>(
    db,
    "SELECT * FROM calendar_holidays WHERE calendar_id = ? ORDER BY holiday_date",
    calendar.id,
  );
  const items = all<DeliveryItemRow>(
    db,
    "SELECT * FROM delivery_items WHERE version_id = ? ORDER BY item_code",
    version.id,
  );
  const events = items.length
    ? all<DeliveryEventRow>(
        db,
        `SELECT * FROM delivery_events WHERE item_id IN (${items.map(() => "?").join(",")})`,
        ...items.map((i) => i.id),
      )
    : [];
  const receipts = all<ReceiptRow>(
    db,
    "SELECT * FROM receipts WHERE version_id = ? ORDER BY receipt_no",
    version.id,
  );
  const factIds = [
    ...items.map((i) => i.id),
    ...events.map((e) => e.id),
    ...receipts.map((r) => r.id),
  ];
  const corrections = factIds.length
    ? all<FactCorrectionRow>(
        db,
        `SELECT * FROM fact_corrections WHERE fact_id IN (${factIds.map(() => "?").join(",")})`,
        ...factIds,
      )
    : [];

  const cutoffIso = cutoffMs === null ? null : new Date(cutoffMs).toISOString();
  // 结构性记录（映射、依赖）同样按截止时刻取“当时状态”
  const mappingRows = cutoffIso
    ? all<MappingRow>(
        db,
        `SELECT * FROM milestone_mappings
          WHERE (side_a_version_id = ? OR side_b_version_id = ?) AND created_at <= ?`,
        version.id,
        version.id,
        cutoffIso,
      )
    : all<MappingRow>(
        db,
        `SELECT * FROM milestone_mappings
          WHERE side_a_version_id = ? OR side_b_version_id = ?`,
        version.id,
        version.id,
      );
  const mappings = mappingRows.map((mapping) => {
    const confirmations = cutoffIso
      ? all<MappingConfirmationRow>(
          db,
          "SELECT * FROM mapping_confirmations WHERE mapping_id = ? AND confirmed_at <= ?",
          mapping.id,
          cutoffIso,
        ).length
      : all<MappingConfirmationRow>(
          db,
          "SELECT * FROM mapping_confirmations WHERE mapping_id = ?",
          mapping.id,
        ).length;
    // 截止时刻前已作废的映射，按作废状态参与评估
    const atCutoff: MappingRow =
      cutoffIso && mapping.voided_at !== null && mapping.voided_at <= cutoffIso
        ? mapping
        : cutoffIso
          ? { ...mapping, voided_at: null }
          : mapping;
    const other =
      mapping.side_a_version_id === version.id
        ? mapping.side_b_version_id
        : mapping.side_a_version_id;
    return { mapping: atCutoff, confirmations, other_version_id: other };
  });

  const dependencyRows = cutoffIso
    ? all<DependencyRow>(
        db,
        "SELECT * FROM milestone_dependencies WHERE version_id = ? AND created_at <= ?",
        version.id,
        cutoffIso,
      )
    : all<DependencyRow>(
        db,
        "SELECT * FROM milestone_dependencies WHERE version_id = ?",
        version.id,
      );

  // 先占位，防御依赖图中的环路（正常登记时已拒绝环路）
  const placeholder: EvalInput = {
    version, calendar, holidays, items, events, receipts, corrections,
    mappings, dependencies: [], cutoffMs,
  };
  memo.set(version.id, placeholder);

  const dependencies = dependencyRows.map((dependency) => {
    const depVersion = get<MilestoneVersionRow>(
      db,
      "SELECT * FROM milestone_versions WHERE id = ?",
      dependency.depends_on_version_id,
    );
    // R9 同口径递归：被依赖版本在该截止时刻的客观门是否满足
    const gatesMet = depVersion
      ? evaluate(gatherEvalInput(db, depVersion, cutoffMs, memo)).gates_met
      : false;
    return { dependency, depends_on_gates_met: gatesMet };
  });
  placeholder.dependencies = dependencies;
  return placeholder;
}

export function latestConclusion(db: DatabaseSync, versionId: string): ConclusionRow | null {
  return get<ConclusionRow>(
    db,
    "SELECT * FROM conclusions WHERE version_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
    versionId,
  );
}

// ---------------------------------------------------------------------------
// 重算
// ---------------------------------------------------------------------------

export interface RecomputeResult {
  conclusion: ConclusionRow;
  created: boolean;
}

/** 幂等重算：同一证据基（basis_hash）已存在结论则直接复用 */
export function recomputeVersion(
  db: DatabaseSync,
  versionId: string,
  opts: { cutoffMs?: number | null; actor: string; splitParentConclusionId?: string | null },
): RecomputeResult {
  const version = get<MilestoneVersionRow>(
    db,
    "SELECT * FROM milestone_versions WHERE id = ?",
    versionId,
  );
  if (!version) throw notFound(`里程碑版本不存在：${versionId}`);
  const cutoffMs = opts.cutoffMs ?? null;
  const input = gatherEvalInput(db, version, cutoffMs);
  const result = evaluate(input);

  const existing = get<ConclusionRow>(
    db,
    "SELECT * FROM conclusions WHERE version_id = ? AND basis_hash = ?",
    versionId,
    result.basis_hash,
  );
  if (existing) return { conclusion: existing, created: false };

  const previous = latestConclusion(db, versionId);
  const conclusion: ConclusionRow = {
    id: newId("con"),
    cooperation_ref: version.cooperation_ref,
    version_id: version.id,
    rule_version: CURRENT_RULE_VERSION,
    gates_met: result.gates_met ? 1 : 0,
    is_overdue: result.is_overdue ? 1 : 0,
    payment_eligible: result.payment_eligible ? 1 : 0,
    payment_amount: result.payment_amount,
    details_json: JSON.stringify(result.details),
    inputs_json: JSON.stringify(result.inputs),
    basis_hash: result.basis_hash,
    supersedes_conclusion_id: previous && previous.basis_hash !== result.basis_hash ? previous.id : null,
    split_parent_conclusion_id: opts.splitParentConclusionId ?? null,
    created_by: opts.actor,
    created_at: nowIso(),
  };
  run(
    db,
    `INSERT INTO conclusions (id, cooperation_ref, version_id, rule_version, gates_met, is_overdue,
       payment_eligible, payment_amount, details_json, inputs_json, basis_hash,
       supersedes_conclusion_id, split_parent_conclusion_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    conclusion.id,
    conclusion.cooperation_ref,
    conclusion.version_id,
    conclusion.rule_version,
    conclusion.gates_met,
    conclusion.is_overdue,
    conclusion.payment_eligible,
    conclusion.payment_amount,
    conclusion.details_json,
    conclusion.inputs_json,
    conclusion.basis_hash,
    conclusion.supersedes_conclusion_id,
    conclusion.split_parent_conclusion_id,
    conclusion.created_by,
    conclusion.created_at,
  );
  audit(db, {
    cooperation_ref: version.cooperation_ref,
    actor_party: opts.actor,
    action: "conclusion.created",
    entity_type: "conclusion",
    entity_id: conclusion.id,
    payload: {
      version_id: version.id,
      basis_hash: conclusion.basis_hash,
      gates_met: conclusion.gates_met,
      is_overdue: conclusion.is_overdue,
      payment_eligible: conclusion.payment_eligible,
    },
  });
  return { conclusion, created: true };
}

/** 合作级重算：迭代到不动点（依赖状态会随新结论变化） */
export function recomputeCooperation(
  db: DatabaseSync,
  cooperationRef: string,
  opts: { cutoffMs?: number | null; actor: string },
): RecomputeResult[] {
  return tx(db, () => {
    const results: RecomputeResult[] = [];
    const versions = all<MilestoneVersionRow>(
      db,
      "SELECT * FROM v_current_milestone WHERE cooperation_ref = ? ORDER BY side, milestone_code",
      cooperationRef,
    );
    const maxRounds = versions.length + 2;
    for (let round = 0; round < maxRounds; round += 1) {
      let changed = false;
      for (const version of versions) {
        const r = recomputeVersion(db, version.id, { cutoffMs: opts.cutoffMs ?? null, actor: opts.actor });
        if (r.created) {
          changed = true;
          results.push(r);
        }
      }
      if (!changed) break;
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// 可付款派生：结论可付款 = 客观门满足 + 约定角色确认齐备 + 未冻结 + 未被冲正
// ---------------------------------------------------------------------------

export interface PayableState {
  conclusion: ConclusionRow | null;
  payable: boolean;
  required_roles: string[];
  confirmed_roles: string[];
  frozen: boolean;
  reversed: boolean;
  reasons: string[];
}

export function payableState(db: DatabaseSync, versionId: string): PayableState {
  const conclusion = latestConclusion(db, versionId);
  const version = get<MilestoneVersionRow>(
    db,
    "SELECT * FROM milestone_versions WHERE id = ?",
    versionId,
  );
  const requiredRoles = version ? (JSON.parse(version.required_roles) as string[]) : [];
  if (!conclusion) {
    return {
      conclusion: null,
      payable: false,
      required_roles: requiredRoles,
      confirmed_roles: [],
      frozen: isVersionFrozen(db, versionId),
      reversed: false,
      reasons: ["尚无结论"],
    };
  }
  const confirmations = all<ConclusionConfirmationRow>(
    db,
    "SELECT * FROM conclusion_confirmations WHERE conclusion_id = ?",
    conclusion.id,
  );
  const confirmedRoles = confirmations.map((c) => c.role);
  const missingRoles = requiredRoles.filter((r) => !confirmedRoles.includes(r));
  const frozen = isVersionFrozen(db, versionId);
  // 冲正语义：该版本有已受理冲正，且最新结论尚未重新进入付款，
  // 则其付款位置处于冲正态；新结论再次入批后解除。
  let reversed = false;
  const acceptedReversal = get<{ id: string }>(
    db,
    `SELECT cr.id FROM conclusion_reversals cr
       JOIN conclusions c ON c.id = cr.original_conclusion_id
      WHERE c.version_id = ? AND cr.status = 'accepted' LIMIT 1`,
    versionId,
  );
  if (acceptedReversal) {
    const reIncluded = get<{ id: string }>(
      db,
      `SELECT se.id FROM settlement_entries se
        WHERE se.version_id = ? AND se.status = 'included'
          AND se.conclusion_id = ? LIMIT 1`,
      versionId,
      conclusion.id,
    );
    reversed = reIncluded === null;
  }
  const reasons: string[] = [];
  if (conclusion.payment_eligible !== 1) reasons.push("客观门未全部满足");
  if (missingRoles.length) reasons.push(`待确认角色：${missingRoles.join("、")}`);
  if (frozen) reasons.push("存在未结异议，金额冻结中");
  if (reversed) reasons.push("结论已被冲正");
  return {
    conclusion,
    payable:
      conclusion.payment_eligible === 1 && missingRoles.length === 0 && !frozen && !reversed,
    required_roles: requiredRoles,
    confirmed_roles: confirmedRoles,
    frozen,
    reversed,
    reasons,
  };
}

export function isVersionFrozen(db: DatabaseSync, versionId: string): boolean {
  return (
    get<DisputeFreezeRow>(
      db,
      "SELECT id FROM dispute_freezes WHERE version_id = ? AND status = 'frozen' LIMIT 1",
      versionId,
    ) !== null
  );
}

// ---------------------------------------------------------------------------
// 争议冻结集群：被争议版本 + 映射对端 + 下游依赖（传递）
// ---------------------------------------------------------------------------

export function disputeCluster(db: DatabaseSync, dispute: DisputeRow): string[] {
  const seeds = new Set<string>();
  if (dispute.subject_version_id) seeds.add(dispute.subject_version_id);
  if (dispute.mapping_id) {
    const mapping = get<MappingRow>(
      db,
      "SELECT * FROM milestone_mappings WHERE id = ?",
      dispute.mapping_id,
    );
    if (mapping) {
      seeds.add(mapping.side_a_version_id);
      seeds.add(mapping.side_b_version_id);
    }
  }
  // 映射对端
  for (const seed of [...seeds]) {
    const mappings = all<MappingRow>(
      db,
      `SELECT * FROM milestone_mappings
        WHERE voided_at IS NULL AND (side_a_version_id = ? OR side_b_version_id = ?)`,
      seed,
      seed,
    );
    for (const m of mappings) {
      seeds.add(m.side_a_version_id === seed ? m.side_b_version_id : m.side_a_version_id);
    }
  }
  // 下游依赖传递闭包
  const cluster = new Set(seeds);
  let grew = true;
  while (grew) {
    grew = false;
    const deps = all<DependencyRow>(
      db,
      "SELECT * FROM milestone_dependencies WHERE cooperation_ref = ?",
      dispute.cooperation_ref,
    );
    for (const dep of deps) {
      if (cluster.has(dep.depends_on_version_id) && !cluster.has(dep.version_id)) {
        cluster.add(dep.version_id);
        grew = true;
      }
    }
  }
  return [...cluster];
}

export function openDispute(
  db: DatabaseSync,
  dispute: DisputeRow,
  actor: string,
): DisputeFreezeRow[] {
  return tx(db, () => {
    run(
      db,
      `INSERT INTO disputes (id, cooperation_ref, subject_version_id, mapping_id, reason,
         evidence_digest, local_ref, raised_by, raised_at, recorded_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      dispute.id,
      dispute.cooperation_ref,
      dispute.subject_version_id,
      dispute.mapping_id,
      dispute.reason,
      dispute.evidence_digest,
      dispute.local_ref,
      dispute.raised_by,
      dispute.raised_at,
      dispute.recorded_at,
    );
    const cluster = disputeCluster(db, dispute);
    const freezes: DisputeFreezeRow[] = [];
    for (const versionId of cluster) {
      const version = get<MilestoneVersionRow>(
        db,
        "SELECT * FROM milestone_versions WHERE id = ?",
        versionId,
      );
      const freeze: DisputeFreezeRow = {
        id: newId("frz"),
        dispute_id: dispute.id,
        cooperation_ref: dispute.cooperation_ref,
        version_id: versionId,
        amount: version?.amount ?? 0,
        status: "frozen",
        created_at: nowIso(),
        released_at: null,
      };
      run(
        db,
        `INSERT INTO dispute_freezes (id, dispute_id, cooperation_ref, version_id, amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'frozen', ?)`,
        freeze.id,
        freeze.dispute_id,
        freeze.cooperation_ref,
        freeze.version_id,
        freeze.amount,
        freeze.created_at,
      );
      freezes.push(freeze);
    }
    audit(db, {
      cooperation_ref: dispute.cooperation_ref,
      actor_party: actor,
      action: "dispute.opened",
      entity_type: "dispute",
      entity_id: dispute.id,
      payload: { frozen_versions: cluster },
    });
    return freezes;
  });
}

export function closeDispute(
  db: DatabaseSync,
  disputeId: string,
  status: "withdrawn" | "resolved",
  actor: string,
  note?: string,
): void {
  tx(db, () => {
    const dispute = get<DisputeRow>(db, "SELECT * FROM disputes WHERE id = ?", disputeId);
    if (!dispute) throw notFound("异议不存在");
    if (dispute.status !== "open") throw conflict("dispute_not_open", "异议已关闭");
    run(
      db,
      "UPDATE disputes SET status = ?, resolved_at = ?, resolution_note = ? WHERE id = ?",
      status,
      nowIso(),
      note ?? null,
      disputeId,
    );
    run(
      db,
      "UPDATE dispute_freezes SET status = 'released', released_at = ? WHERE dispute_id = ? AND status = 'frozen'",
      nowIso(),
      disputeId,
    );
    audit(db, {
      cooperation_ref: dispute.cooperation_ref,
      actor_party: actor,
      action: `dispute.${status}`,
      entity_type: "dispute",
      entity_id: disputeId,
      payload: { note: note ?? null },
    });
  });
}

// ---------------------------------------------------------------------------
// 里程碑拆分（R10）
// ---------------------------------------------------------------------------

export interface SplitChildSpec {
  milestone_code: string;
  title: string;
  planned_date: string;
  amount: number;
  weight: number;
  calendar_id: string;
  required_roles: string[];
}

export function splitMilestone(
  db: DatabaseSync,
  parentVersionId: string,
  children: SplitChildSpec[],
  actor: string,
): MilestoneVersionRow[] {
  return tx(db, () => {
    const parent = get<MilestoneVersionRow>(
      db,
      "SELECT * FROM milestone_versions WHERE id = ?",
      parentVersionId,
    );
    if (!parent) throw notFound("父里程碑版本不存在");
    const current = get<MilestoneVersionRow>(
      db,
      `SELECT * FROM v_current_milestone
        WHERE cooperation_ref = ? AND side = ? AND milestone_code = ?`,
      parent.cooperation_ref,
      parent.side,
      parent.milestone_code,
    );
    if (!current || current.id !== parent.id) {
      throw conflict("split_requires_current", "只能拆分当前版本的里程碑");
    }
    // 已进入付款的结论必须先冲正
    const paidEntry = get<SettlementEntryRow>(
      db,
      `SELECT se.* FROM settlement_entries se
        JOIN conclusions c ON c.id = se.conclusion_id
       WHERE c.version_id = ? AND se.status = 'included' LIMIT 1`,
      parent.id,
    );
    if (paidEntry) {
      throw conflict(
        "split_requires_reversal",
        "父里程碑已进入付款，须先对其结论冲正再拆分",
      );
    }
    const weightSum = children.reduce((s, c) => s + c.weight, 0);
    if (children.length < 2 || Math.abs(weightSum - 1) > 1e-9) {
      throw conflict("split_weight_invalid", "拆分至少两个子节点且权重之和必须为 1");
    }
    const created: MilestoneVersionRow[] = [];
    for (const child of children) {
      const dup = get<MilestoneVersionRow>(
        db,
        `SELECT id FROM milestone_versions
          WHERE cooperation_ref = ? AND side = ? AND milestone_code = ?`,
        parent.cooperation_ref,
        parent.side,
        child.milestone_code,
      );
      if (dup) throw conflict("milestone_code_exists", `子里程碑编号已存在：${child.milestone_code}`);
      const row: MilestoneVersionRow = {
        id: newId("mv"),
        cooperation_ref: parent.cooperation_ref,
        side: parent.side,
        milestone_code: child.milestone_code,
        revision: 1,
        version_kind: "split",
        parent_version_id: parent.id,
        title: child.title,
        planned_date: child.planned_date,
        amount: child.amount,
        weight: child.weight,
        calendar_id: child.calendar_id,
        required_roles: JSON.stringify(child.required_roles),
        recorded_by: actor,
        recorded_at: nowIso(),
      };
      run(
        db,
        `INSERT INTO milestone_versions (id, cooperation_ref, side, milestone_code, revision,
           version_kind, parent_version_id, title, planned_date, amount, weight, calendar_id,
           required_roles, recorded_by, recorded_at)
         VALUES (?, ?, ?, ?, ?, 'split', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.cooperation_ref,
        row.side,
        row.milestone_code,
        row.revision,
        row.parent_version_id,
        row.title,
        row.planned_date,
        row.amount,
        row.weight,
        row.calendar_id,
        row.required_roles,
        row.recorded_by,
        row.recorded_at,
      );
      created.push(row);
    }
    audit(db, {
      cooperation_ref: parent.cooperation_ref,
      actor_party: actor,
      action: "milestone.split",
      entity_type: "milestone_version",
      entity_id: parent.id,
      payload: { children: created.map((c) => c.id) },
    });
    return created;
  });
}

// ---------------------------------------------------------------------------
// 结算批次：关闭时固化 cutoff 与规则版本；重放按当时证据与规则复核
// ---------------------------------------------------------------------------

export function closeBatch(
  db: DatabaseSync,
  batchId: string,
  actor: string,
): { entries: SettlementEntryRow[]; batch: SettlementBatchRow } {
  return tx(db, () => {
    const batch = get<SettlementBatchRow>(
      db,
      "SELECT * FROM settlement_batches WHERE id = ?",
      batchId,
    );
    if (!batch) throw notFound("结算批次不存在");
    if (batch.status !== "open") throw conflict("batch_not_open", "批次已关闭");
    const cutoffMs = Date.now();
    const cutoffIso = new Date(cutoffMs).toISOString();

    // 以批次截止时刻重算全部当前版本
    recomputeCooperation(db, batch.cooperation_ref, { cutoffMs, actor });

    const versions = all<MilestoneVersionRow>(
      db,
      "SELECT * FROM v_current_milestone WHERE cooperation_ref = ?",
      batch.cooperation_ref,
    );
    const entries: SettlementEntryRow[] = [];
    for (const version of versions) {
      const state = payableState(db, version.id);
      if (!state.payable || !state.conclusion) continue;
      // 同一版本在已关闭批次中已有未冲正条目则跳过
      const alreadySettled = get<SettlementEntryRow>(
        db,
        `SELECT se.* FROM settlement_entries se
          JOIN settlement_batches b ON b.id = se.batch_id
         WHERE se.version_id = ? AND se.status = 'included' AND b.status = 'closed' LIMIT 1`,
        version.id,
      );
      if (alreadySettled) continue;
      const entry: SettlementEntryRow = {
        id: newId("se"),
        batch_id: batch.id,
        version_id: version.id,
        conclusion_id: state.conclusion.id,
        amount: state.conclusion.payment_amount,
        basis_hash: state.conclusion.basis_hash,
        status: "included",
        reversal_id: null,
        included_at: nowIso(),
      };
      run(
        db,
        `INSERT INTO settlement_entries (id, batch_id, version_id, conclusion_id, amount, basis_hash, status, included_at)
         VALUES (?, ?, ?, ?, ?, ?, 'included', ?)`,
        entry.id,
        entry.batch_id,
        entry.version_id,
        entry.conclusion_id,
        entry.amount,
        entry.basis_hash,
        entry.included_at,
      );
      entries.push(entry);
    }
    run(
      db,
      "UPDATE settlement_batches SET status = 'closed', cutoff_at = ?, closed_at = ? WHERE id = ?",
      cutoffIso,
      cutoffIso,
      batch.id,
    );
    audit(db, {
      cooperation_ref: batch.cooperation_ref,
      actor_party: actor,
      action: "batch.closed",
      entity_type: "settlement_batch",
      entity_id: batch.id,
      payload: { entries: entries.map((e) => e.id), cutoff_at: cutoffIso },
    });
    return {
      entries,
      batch: { ...batch, status: "closed", cutoff_at: cutoffIso, closed_at: cutoffIso },
    };
  });
}

export interface ReplayEntryResult {
  entry_id: string;
  version_id: string;
  conclusion_id: string;
  /** 用结论内嵌快照重放：验证“当时证据 + 当时规则”是否复现结论 */
  snapshot_reproduced: boolean | "rule_unavailable";
  /** 用当前库内证据按批次截止时刻重算：是否得到同一证据基 */
  current_matches: boolean | "rule_unavailable";
  /** 无截止的当前视角：迟到证据进入后证据基是否已偏离批次（R5） */
  live_view: {
    basis_hash: string;
    differs_from_batch: boolean;
    late_events: Array<{ id: string; recorded_at: string }>;
    late_receipts: Array<{ id: string; recorded_at: string }>;
  } | null;
  entry_status: string;
  reversed: boolean;
  detail?: string;
}

export function replayBatch(db: DatabaseSync, batchId: string): {
  batch: SettlementBatchRow;
  all_reproduced: boolean;
  entries: ReplayEntryResult[];
} {
  const batch = get<SettlementBatchRow>(
    db,
    "SELECT * FROM settlement_batches WHERE id = ?",
    batchId,
  );
  if (!batch) throw notFound("结算批次不存在");
  if (batch.status !== "closed") throw conflict("batch_not_closed", "批次尚未关闭，无法重放");
  const entries = all<SettlementEntryRow>(
    db,
    "SELECT * FROM settlement_entries WHERE batch_id = ? ORDER BY included_at, id",
    batch.id,
  );
  const cutoffMs = parseInstant(batch.cutoff_at);
  const results: ReplayEntryResult[] = [];
  for (const entry of entries) {
    const conclusion = get<ConclusionRow>(
      db,
      "SELECT * FROM conclusions WHERE id = ?",
      entry.conclusion_id,
    );
    if (!conclusion) {
      results.push({
        entry_id: entry.id,
        version_id: entry.version_id,
        conclusion_id: entry.conclusion_id,
        snapshot_reproduced: false,
        current_matches: false,
        live_view: null,
        entry_status: entry.status,
        reversed: entry.status === "reversed",
        detail: "结论记录缺失",
      });
      continue;
    }
    // (a) 快照重放：结论内嵌证据 + 批次规则版本
    let snapshotReproduced: boolean | "rule_unavailable";
    if (conclusion.rule_version !== CURRENT_RULE_VERSION) {
      snapshotReproduced = "rule_unavailable";
    } else {
      const snapshot = JSON.parse(conclusion.inputs_json) as EvalInput;
      const replayed = evaluate({ ...snapshot, cutoffMs: snapshot.cutoffMs ?? cutoffMs });
      snapshotReproduced =
        replayed.basis_hash === conclusion.basis_hash &&
        replayed.payment_amount === conclusion.payment_amount &&
        replayed.payment_eligible === (conclusion.payment_eligible === 1);
    }
    // (b) 当前视角：以批次截止时刻重新汇聚证据
    let currentMatches: boolean | "rule_unavailable";
    if (batch.rule_version !== CURRENT_RULE_VERSION) {
      currentMatches = "rule_unavailable";
    } else {
      const version = get<MilestoneVersionRow>(
        db,
        "SELECT * FROM milestone_versions WHERE id = ?",
        entry.version_id,
      );
      if (!version) {
        currentMatches = false;
      } else {
        const fresh = evaluate(gatherEvalInput(db, version, cutoffMs));
        currentMatches = fresh.basis_hash === entry.basis_hash;
      }
    }
    // (c) 无截止当前视角：迟到证据进入后证据基是否已偏离批次
    let liveView: ReplayEntryResult["live_view"] = null;
    const liveVersion = get<MilestoneVersionRow>(
      db,
      "SELECT * FROM milestone_versions WHERE id = ?",
      entry.version_id,
    );
    if (liveVersion) {
      const live = evaluate(gatherEvalInput(db, liveVersion, null));
      // 迟到清单须相对于批次截止判定
      const atCutoff = evaluate(gatherEvalInput(db, liveVersion, cutoffMs));
      const late = atCutoff.details.late_evidence as {
        events: Array<{ id: string; recorded_at: string }>;
        receipts: Array<{ id: string; recorded_at: string }>;
      };
      liveView = {
        basis_hash: live.basis_hash,
        differs_from_batch: live.basis_hash !== entry.basis_hash,
        late_events: late.events,
        late_receipts: late.receipts,
      };
    }
    results.push({
      entry_id: entry.id,
      version_id: entry.version_id,
      conclusion_id: entry.conclusion_id,
      snapshot_reproduced: snapshotReproduced,
      current_matches: currentMatches,
      live_view: liveView,
      entry_status: entry.status,
      reversed: entry.status === "reversed",
    });
  }
  const allReproduced = results.every((r) => r.snapshot_reproduced === true);
  return { batch, all_reproduced: allReproduced, entries: results };
}

// ---------------------------------------------------------------------------
// 冲正与替代（R7 的落地）：已进入付款的结论只能这样变更
// ---------------------------------------------------------------------------

export function proposeReversal(
  db: DatabaseSync,
  conclusionId: string,
  input: { reason_code: string; reason: string; evidence_digest?: string | null },
  actor: string,
): ReversalRow {
  return tx(db, () => {
    const conclusion = get<ConclusionRow>(
      db,
      "SELECT * FROM conclusions WHERE id = ?",
      conclusionId,
    );
    if (!conclusion) throw notFound("结论不存在");
    const entry = get<SettlementEntryRow>(
      db,
      "SELECT * FROM settlement_entries WHERE conclusion_id = ? AND status = 'included'",
      conclusionId,
    );
    if (!entry) {
      throw conflict("conclusion_not_in_payment", "该结论尚未进入付款，无需冲正");
    }
    const existing = get<ReversalRow>(
      db,
      `SELECT * FROM conclusion_reversals
        WHERE original_conclusion_id = ? AND status IN ('proposed', 'accepted')`,
      conclusionId,
    );
    if (existing) throw conflict("reversal_exists", "该结论已有进行中的冲正");
    const reversal: ReversalRow = {
      id: newId("rev"),
      cooperation_ref: conclusion.cooperation_ref,
      original_conclusion_id: conclusionId,
      replacement_conclusion_id: null,
      reason_code: input.reason_code,
      reason: input.reason,
      evidence_digest: input.evidence_digest ?? null,
      net_amount: null,
      status: "proposed",
      raised_by: actor,
      created_at: nowIso(),
      decided_at: null,
    };
    run(
      db,
      `INSERT INTO conclusion_reversals (id, cooperation_ref, original_conclusion_id,
         replacement_conclusion_id, reason_code, reason, evidence_digest, net_amount,
         status, raised_by, created_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, 'proposed', ?, ?)`,
      reversal.id,
      reversal.cooperation_ref,
      reversal.original_conclusion_id,
      reversal.reason_code,
      reversal.reason,
      reversal.evidence_digest,
      reversal.raised_by,
      reversal.created_at,
    );
    audit(db, {
      cooperation_ref: conclusion.cooperation_ref,
      actor_party: actor,
      action: "reversal.proposed",
      entity_type: "conclusion_reversal",
      entity_id: reversal.id,
      payload: { original_conclusion_id: conclusionId, reason_code: input.reason_code },
    });
    return reversal;
  });
}

export function acceptReversal(db: DatabaseSync, reversalId: string, actor: string): ReversalRow {
  return tx(db, () => {
    const reversal = get<ReversalRow>(
      db,
      "SELECT * FROM conclusion_reversals WHERE id = ?",
      reversalId,
    );
    if (!reversal) throw notFound("冲正记录不存在");
    if (reversal.status !== "proposed") {
      throw conflict("reversal_not_proposed", "冲正不在待处理状态");
    }
    const original = get<ConclusionRow>(
      db,
      "SELECT * FROM conclusions WHERE id = ?",
      reversal.original_conclusion_id,
    );
    if (!original) throw notFound("原结论不存在");
    const entry = get<SettlementEntryRow>(
      db,
      "SELECT * FROM settlement_entries WHERE conclusion_id = ? AND status = 'included'",
      original.id,
    );
    if (!entry) throw conflict("conclusion_not_in_payment", "原结论不在付款中");

    // 以当前证据重算，得到替代结论
    const { conclusion: replacement } = recomputeVersion(db, original.version_id, { actor });
    const replacementId = replacement.id !== original.id ? replacement.id : null;
    const net = (replacementId ? replacement.payment_amount : 0) - entry.amount;

    run(
      db,
      `UPDATE conclusion_reversals
          SET status = 'accepted', replacement_conclusion_id = ?, net_amount = ?, decided_at = ?
        WHERE id = ?`,
      replacementId,
      net,
      nowIso(),
      reversal.id,
    );
    run(
      db,
      "UPDATE settlement_entries SET status = 'reversed', reversal_id = ? WHERE id = ?",
      reversal.id,
      entry.id,
    );
    audit(db, {
      cooperation_ref: reversal.cooperation_ref,
      actor_party: actor,
      action: "reversal.accepted",
      entity_type: "conclusion_reversal",
      entity_id: reversal.id,
      payload: {
        original_conclusion_id: original.id,
        replacement_conclusion_id: replacementId,
        net_amount: net,
      },
    });
    return { ...reversal, status: "accepted", replacement_conclusion_id: replacementId, net_amount: net };
  });
}

export function rejectReversal(db: DatabaseSync, reversalId: string, actor: string): ReversalRow {
  return tx(db, () => {
    const reversal = get<ReversalRow>(
      db,
      "SELECT * FROM conclusion_reversals WHERE id = ?",
      reversalId,
    );
    if (!reversal) throw notFound("冲正记录不存在");
    if (reversal.status !== "proposed") {
      throw conflict("reversal_not_proposed", "冲正不在待处理状态");
    }
    run(
      db,
      "UPDATE conclusion_reversals SET status = 'rejected', decided_at = ? WHERE id = ?",
      nowIso(),
      reversal.id,
    );
    audit(db, {
      cooperation_ref: reversal.cooperation_ref,
      actor_party: actor,
      action: "reversal.rejected",
      entity_type: "conclusion_reversal",
      entity_id: reversal.id,
      payload: {},
    });
    return { ...reversal, status: "rejected" };
  });
}
