
// 确定性重算规则引擎（规则集 v1）。
// 纯函数：相同输入必得相同结论，供实时重算与按批次重放共用。
//
// 规则一览（详见 docs/domain.md）：
//   R1 重复去重   重复交付事件/回执（duplicate_of 非空）不计入
//   R2 撤回更正   本方撤回的事实立即失效
//   R3 部分交付   全部未撤回清单行累计交付数量达标才算交付完成
//   R4 假日调整   约定日落非工作日顺延至下一工作日，截止为该日日终
//   R5 迟到证据   recorded_at 晚于截止时刻的证据（交付事件、回执、撤回更正）
//                 不参与本次计算，单独列出；结论不受批次后新事实影响
//   R6 完成时刻   max(交付完成时刻, 最新有效签收时刻)，以签收为准
//   R7 逾期判定   完成瞬时 > 调整后截止瞬时
//   R8 映射门     跨方映射须双方确认才视为关联成立
//   R9 依赖门     被依赖版本在同一口径下客观门满足（递归评估，不读结算态）
//   R10 里程碑拆分 子版本权重和为 1；父版本已付款结论须先冲正（服务层强制）

import { adjustToWorkday, completionLocalDate, deadlineInstant } from "./calendar.js";
import { digestOf, parseInstant } from "./time.js";
import type {
  CalendarRow,
  DeliveryEventRow,
  DeliveryItemRow,
  DependencyRow,
  FactCorrectionRow,
  HolidayRow,
  MappingRow,
  MilestoneVersionRow,
  ReceiptRow,
} from "./types.js";

export const CURRENT_RULE_VERSION = "v1";

export interface MappingGateInput {
  mapping: MappingRow;
  confirmations: number; // 已确认方数（双方确认 = 2）
  other_version_id: string;
}

export interface DependencyGateInput {
  dependency: DependencyRow;
  /** 被依赖版本在同一截止口径下的客观门是否满足（递归评估结果，不读结算态） */
  depends_on_gates_met: boolean;
}

export interface EvalInput {
  version: MilestoneVersionRow;
  calendar: CalendarRow;
  holidays: HolidayRow[];
  items: DeliveryItemRow[];
  events: DeliveryEventRow[];
  receipts: ReceiptRow[];
  corrections: FactCorrectionRow[];
  mappings: MappingGateInput[];
  dependencies: DependencyGateInput[];
  /** 结算批次截止时刻（毫秒）；null 表示实时重算（不限） */
  cutoffMs: number | null;
}

export interface EvalResult {
  gates_met: boolean;
  is_overdue: boolean;
  payment_eligible: boolean;
  payment_amount: number;
  basis_hash: string;
  details: Record<string, unknown>;
  inputs: Record<string, unknown>;
}

interface ItemEval {
  item_id: string;
  item_code: string;
  required_qty: number;
  delivered_qty: number;
  complete: boolean;
  withdrawn: boolean;
  events: string[];
}

function isWithdrawn(corrections: FactCorrectionRow[], table: string, id: string): boolean {
  return corrections.some((c) => c.fact_table === table && c.fact_id === id && c.kind === "withdraw");
}

export function evaluate(input: EvalInput): EvalResult {
  const { version, calendar, holidays, cutoffMs } = input;
  const cutoff = cutoffMs ?? Number.POSITIVE_INFINITY;

  // ---- R5 迟到证据：先按截止时刻过滤，迟到的单独列出 ----------------------
  // 撤回更正同样以入库时刻判定，保证批次后撤回不改写历史重放。
  const lateEvents = input.events.filter((e) => parseInstant(e.recorded_at) > cutoff);
  const lateReceipts = input.receipts.filter((r) => parseInstant(r.recorded_at) > cutoff);
  const lateItems = input.items.filter((i) => parseInstant(i.recorded_at) > cutoff);
  const lateCorrections = input.corrections.filter((c) => parseInstant(c.recorded_at) > cutoff);
  const corrections = input.corrections.filter((c) => parseInstant(c.recorded_at) <= cutoff);
  const events = input.events.filter((e) => parseInstant(e.recorded_at) <= cutoff);
  const receipts = input.receipts.filter((r) => parseInstant(r.recorded_at) <= cutoff);

  // ---- R1 + R2：去重与撤回 -------------------------------------------------
  const effectiveEvents = events.filter(
    (e) => e.duplicate_of === null && !isWithdrawn(corrections, "delivery_events", e.id),
  );
  const duplicateEvents = events.filter((e) => e.duplicate_of !== null);
  const withdrawnEvents = events.filter((e) => isWithdrawn(corrections, "delivery_events", e.id));

  const effectiveReceipts = receipts.filter(
    (r) => r.duplicate_of === null && !isWithdrawn(corrections, "receipts", r.id),
  );
  const duplicateReceipts = receipts.filter((r) => r.duplicate_of !== null);
  const withdrawnReceipts = receipts.filter((r) => isWithdrawn(corrections, "receipts", r.id));

  // 清单行：截止后新增的不参与本批次；截止前的再看是否被截止前的撤回命中
  const visibleItems = input.items.filter((i) => parseInstant(i.recorded_at) <= cutoff);
  const activeItems = visibleItems.filter((i) => !isWithdrawn(corrections, "delivery_items", i.id));
  const withdrawnItems = visibleItems.filter((i) => isWithdrawn(corrections, "delivery_items", i.id));

  // ---- R3 部分交付：逐行累计 ------------------------------------------------
  const itemEvals: ItemEval[] = activeItems.map((item) => {
    const itemEvents = effectiveEvents.filter((e) => e.item_id === item.id);
    const delivered = itemEvents.reduce((sum, e) => sum + e.qty, 0);
    return {
      item_id: item.id,
      item_code: item.item_code,
      required_qty: item.required_qty,
      delivered_qty: delivered,
      complete: delivered >= item.required_qty,
      withdrawn: false,
      events: itemEvents.map((e) => e.id),
    };
  });
  const deliveryComplete = itemEvals.length > 0 && itemEvals.every((i) => i.complete);

  // 交付完成时刻：最后一批使清单达标的有效交付事件时刻
  let deliveryCompleteMs: number | null = null;
  if (deliveryComplete) {
    deliveryCompleteMs = Math.max(...effectiveEvents.map((e) => parseInstant(e.delivered_at)));
  }

  // ---- R6 完成时刻：交付与签收取较晚者（签收为准） -------------------------
  const latestReceiptMs = effectiveReceipts.length
    ? Math.max(...effectiveReceipts.map((r) => parseInstant(r.signed_at)))
    : null;
  let completionMs: number | null = null;
  if (deliveryCompleteMs !== null) {
    completionMs = latestReceiptMs !== null ? Math.max(deliveryCompleteMs, latestReceiptMs) : deliveryCompleteMs;
  }

  // ---- R4 假日调整 + R7 逾期判定 ------------------------------------------
  const deadline = deadlineInstant(calendar, holidays, version.planned_date);
  const isOverdue = completionMs !== null && completionMs > deadline.deadline_ms;
  const completionDate =
    completionMs !== null ? completionLocalDate(calendar, completionMs) : null;

  // ---- R8 映射门 ------------------------------------------------------------
  const mappingEvals = input.mappings.map((m) => ({
    mapping_id: m.mapping.id,
    other_version_id: m.other_version_id,
    relation: m.mapping.relation,
    confirmations: m.confirmations,
    ok: m.mapping.voided_at === null && m.confirmations >= 2,
  }));
  const mappingOk = mappingEvals.every((m) => m.ok);

  // ---- R9 依赖门（同口径递归结果，见 gatherEvalInput） ----------------------
  const dependencyEvals = input.dependencies.map((d) => ({
    dependency_id: d.dependency.id,
    depends_on_version_id: d.dependency.depends_on_version_id,
    gates_met: d.depends_on_gates_met,
  }));
  const depsOk = dependencyEvals.every((d) => d.gates_met);

  // ---- 汇总 -----------------------------------------------------------------
  const gatesMet = depsOk && mappingOk && deliveryComplete;
  const paymentEligible = gatesMet;
  const paymentAmount = paymentEligible ? version.amount : 0;

  const details: Record<string, unknown> = {
    rule_version: CURRENT_RULE_VERSION,
    side: version.side,
    milestone_code: version.milestone_code,
    revision: version.revision,
    planned: {
      iso: version.planned_date,
      local_date: deadline.local_date,
      holiday_adjustment: deadline.adjustment,
    },
    delivery: {
      complete: deliveryComplete,
      items: itemEvals,
      late_items: lateItems.map((i) => ({ id: i.id, item_code: i.item_code, recorded_at: i.recorded_at })),
      withdrawn_items: withdrawnItems.map((i) => i.id),
      duplicate_events: duplicateEvents.map((e) => ({ id: e.id, duplicate_of: e.duplicate_of })),
      withdrawn_events: withdrawnEvents.map((e) => e.id),
      late_events: lateEvents.map((e) => ({ id: e.id, recorded_at: e.recorded_at })),
      completion_ms: deliveryCompleteMs,
    },
    receipts: {
      effective: effectiveReceipts.map((r) => r.id),
      duplicates: duplicateReceipts.map((r) => ({ id: r.id, duplicate_of: r.duplicate_of })),
      withdrawn: withdrawnReceipts.map((r) => r.id),
      late: lateReceipts.map((r) => ({ id: r.id, recorded_at: r.recorded_at })),
      latest_signed_ms: latestReceiptMs,
    },
    completion: {
      instant_ms: completionMs,
      local_date: completionDate,
      overdue: isOverdue,
      overdue_by_ms: isOverdue && completionMs !== null ? completionMs - deadline.deadline_ms : 0,
    },
    mapping: { ok: mappingOk, mappings: mappingEvals },
    dependencies: { ok: depsOk, items: dependencyEvals },
    late_evidence: {
      events: lateEvents.map((e) => ({ id: e.id, recorded_at: e.recorded_at })),
      receipts: lateReceipts.map((r) => ({ id: r.id, recorded_at: r.recorded_at })),
      items: lateItems.map((i) => ({ id: i.id, item_code: i.item_code, recorded_at: i.recorded_at })),
      corrections: lateCorrections.map((c) => ({ fact_table: c.fact_table, fact_id: c.fact_id, recorded_at: c.recorded_at })),
    },
    gates: {
      delivery_ok: deliveryComplete,
      mapping_ok: mappingOk,
      deps_ok: depsOk,
      gates_met: gatesMet,
    },
    required_roles: JSON.parse(version.required_roles) as string[],
    cutoff_ms: cutoffMs,
  };

  // 证据基指纹：决定结论身份。cutoff 不参与（重放语义）；
  // 迟到证据不参与指纹——它被截止时刻排除，只作为解释信息进入 details。
  // 已标注的重复/撤回记录参与指纹：它们被“考虑后剔除”，属于判定轨迹的一部分。
  const basisHash = digestOf([
    CURRENT_RULE_VERSION,
    version.id,
    version.revision,
    version.planned_date,
    String(version.amount),
    calendar.id,
    ...holidays.map((h) => `${h.holiday_date}:${h.workday_override}`).sort(),
    ...activeItems.map((i) => `${i.id}:${i.item_code}:${i.required_qty}`).sort(),
    ...effectiveEvents.map((e) => `${e.id}:${e.evidence_digest}:${e.delivered_at}:${e.qty}`).sort(),
    ...effectiveReceipts.map((r) => `${r.id}:${r.receipt_no}:${r.signed_at}`).sort(),
    ...duplicateEvents.map((e) => `dup:${e.id}`).sort(),
    ...duplicateReceipts.map((r) => `dup:${r.id}`).sort(),
    ...corrections.map((c) => `${c.fact_table}:${c.fact_id}:${c.kind}`).sort(),
    ...mappingEvals.map((m) => `${m.mapping_id}:${m.confirmations}:${m.ok}`).sort(),
    ...dependencyEvals.map((d) => `${d.dependency_id}:${d.gates_met}`).sort(),
  ]);

  const inputs: Record<string, unknown> = {
    version,
    calendar,
    holidays,
    items: visibleItems,
    events,
    receipts,
    corrections,
    mappings: input.mappings.map((m) => ({
      mapping: m.mapping,
      confirmations: m.confirmations,
      other_version_id: m.other_version_id,
    })),
    dependencies: input.dependencies.map((d) => ({
      dependency: d.dependency,
      depends_on_gates_met: d.depends_on_gates_met,
    })),
    cutoff_ms: cutoffMs,
  };

  return {
    gates_met: gatesMet,
    is_overdue: isOverdue,
    payment_eligible: paymentEligible,
    payment_amount: paymentAmount,
    basis_hash: basisHash,
    details,
    inputs,
  };
}
