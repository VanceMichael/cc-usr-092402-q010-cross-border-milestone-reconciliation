// 确定性证据重算规则（rules-1.0.0）。
//
// 确定的重算规则（任何时点 T 重放必须得到一致结论）：
//  R1 版本选取：各类事实只取 recorded_at <= T 的最新版本；之后到达的事实一律不参与（迟到证据）。
//  R2 跨方映射：status=confirmed 才形成结算节点；proposed/rejected 不产生付款结论。
//  R3 里程碑拆分：存在未决提议 → blocked(split_negotiation_open)；无未决提议但已确认权重≠10000
//     → blocked(split_weight_mismatch)；已确认权重恰为 10000 时父节点 superseded，
//     子节点按权重（基点）以最大余数法分摊金额。
//  R4 完成条件（逐方判定）：交付清单中每个交付项都有 accepted 签收回执（duplicate 回执剔除），
//     且约定角色最新决定为 confirmed；缺一即 blocked（部分交付）。完成时刻 = max(覆盖回执 signedAt, 角色确认 recordedAt)。
//  R5 依赖：限定码依赖（"A:M1"）全部满足后本节点才满足；依赖满足时刻并入完成时刻；成环即 blocked(dependency_cycle)。
//  R6 时区/日历：双方各按自己的 IANA 时区与本地日历（假日/补班覆盖优先于周末）计算到期日；
//     next_workday 策略将休假日顺延。双视图同时保留，逾期结论以 governing_side 为准。
//  R7 异议冻结：节点存在 open 异议（opened_at<=T 且未撤回）→ frozen，金额保留但不付；只影响本节点。
//  R8 逾期：governing 视角完成时刻 >= 到期日次日 00:00（本地）→ not_payable(late_under_governing_calendar)。
//  R9 状态优先级：superseded > blocked > frozen > not_payable > payable。
// 已进入付款（closed 批次）的结论不由本引擎改写，只能通过 reversal + replacement 变更（见 store 层）。

import {
  buildDueView,
  type PartyCalendar,
  type Side,
} from "./time.js";
import type {
  ConfirmationFact,
  DeliverableFact,
  MappingFact,
  MilestoneFact,
  ObjectionFact,
  ReceiptFact,
  Snapshot,
  SplitFact,
} from "./types.js";

export const RULE_VERSION = "rules-1.0.0";

export type ReasonCode =
  | "mapping_not_confirmed"
  | "milestone_version_missing"
  | "calendar_missing"
  | "missing_deliverable_list"
  | "partial_delivery"
  | "duplicate_receipt_ignored"
  | "extraneous_receipt_ignored"
  | "whole_package_receipt_ignored"
  | "role_not_confirmed"
  | "role_rejected"
  | "dependency_unmet"
  | "dependency_cycle"
  | "unknown_dependency"
  | "superseded_by_split"
  | "split_negotiation_open"
  | "split_weight_mismatch"
  | "objection_open"
  | "late_under_governing_calendar"
  | "calendar_views_differ"
  | "holiday_adjusted"
  | "ok";

export interface Reason {
  code: ReasonCode;
  side?: Side;
  detail?: unknown;
}

export interface SideView {
  milestoneCode: string;
  versionId: string | null;
  seq: number | null;
  title: string | null;
  requiredRole: string | null;
  deliverableVersionId: string | null;
  items: { itemCode: string; title: string; covered: boolean; receiptId: string | null }[];
  acceptedReceipts: { id: string; itemCode: string | null; digest: string; signedAt: string; receivedAt: string }[];
  duplicateReceiptIds: string[];
  roleConfirmation: { id: string; role: string; decision: "confirmed" | "rejected"; recordedAt: string } | null;
  dependencies: string[];
  dependencyStates: { dep: string; satisfied: boolean; satisfiedAt: string | null; reason?: ReasonCode }[];
  satisfied: boolean;
  satisfiedAt: string | null;
  blockReasons: Reason[];
  due: ReturnType<typeof buildDueView> | null;
}

export interface NodeConclusion {
  nodeCode: string;
  status: "payable" | "not_payable" | "blocked" | "frozen" | "superseded";
  amountCents: number | null;
  governingSide: Side;
  reasons: Reason[];
  views: Record<Side, SideView>;
  evidence: Record<string, unknown>;
}

interface DependencyStateMs {
  dep: string;
  satisfied: boolean;
  satisfiedAt: number | null;
  reason?: ReasonCode;
}

interface MilestoneEvaluation {
  key: string;
  side: Side;
  milestoneCode: string;
  versionId: string;
  seq: number;
  title: string;
  requiredRole: string;
  deliverableVersionId: string | null;
  items: SideView["items"];
  acceptedReceipts: SideView["acceptedReceipts"];
  duplicateReceiptIds: string[];
  roleConfirmation: SideView["roleConfirmation"];
  dependencies: string[];
  dependencyStates: DependencyStateMs[];
  satisfied: boolean;
  satisfiedAtMs: number | null;
  blockReasons: Reason[];
  ownReadyAt: number | null;
}

function toSideView(evaluation: MilestoneEvaluation, due: SideView["due"]): SideView {
  return {
    milestoneCode: evaluation.milestoneCode,
    versionId: evaluation.versionId,
    seq: evaluation.seq,
    title: evaluation.title,
    requiredRole: evaluation.requiredRole,
    deliverableVersionId: evaluation.deliverableVersionId,
    items: evaluation.items,
    acceptedReceipts: evaluation.acceptedReceipts,
    duplicateReceiptIds: evaluation.duplicateReceiptIds,
    roleConfirmation: evaluation.roleConfirmation,
    dependencies: evaluation.dependencies,
    dependencyStates: evaluation.dependencyStates.map((d) => ({
      dep: d.dep,
      satisfied: d.satisfied,
      reason: d.reason,
      satisfiedAt: d.satisfiedAt === null ? null : iso(d.satisfiedAt),
    })),
    satisfied: evaluation.satisfied,
    satisfiedAt: evaluation.satisfiedAtMs === null ? null : iso(evaluation.satisfiedAtMs),
    blockReasons: evaluation.blockReasons,
    due,
  };
}

function latestBy<T>(rows: T[], pick: (row: T) => number): T | null {
  let best: T | null = null;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const at = pick(row);
    if (at > bestAt) {
      best = row;
      bestAt = at;
    }
  }
  return best;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 逐方里程碑评估（不含依赖传播），再做依赖不动点与环检测。 */
function evaluateMilestones(snapshot: Snapshot): Map<string, MilestoneEvaluation> {
  const result = new Map<string, MilestoneEvaluation>();

  for (const mv of snapshot.milestones) {
    const key = `${mv.side}:${mv.milestoneCode}`;
    if (result.has(key)) continue; // snapshot.milestones 已去重，防御性跳过

    const side = mv.side;
    const blockReasons: Reason[] = [];

    // 交付清单（R1：最新版本）
    const deliverable =
      latestBy(
        snapshot.deliverables.filter((d) => d.side === side && d.milestoneCode === mv.milestoneCode),
        (d) => d.recordedAt,
      ) ?? null;

    // 回执：duplicate 剔除（R4）
    const allReceipts = snapshot.receipts.filter(
      (r) => r.side === side && r.milestoneCode === mv.milestoneCode,
    );
    const accepted = allReceipts.filter((r) => r.status === "accepted");
    const duplicateIds = allReceipts.filter((r) => r.status === "duplicate").map((r) => r.id);

    const requiredCodes = deliverable ? deliverable.items.map((i) => i.itemCode) : [];
    const covering = new Map<string, ReceiptFact>();
    for (const receipt of accepted) {
      if (receipt.itemCode === null) {
        if (requiredCodes.length > 0) blockReasons.push({ code: "whole_package_receipt_ignored", side, detail: receipt.id });
        continue;
      }
      if (!requiredCodes.includes(receipt.itemCode)) {
        blockReasons.push({ code: "extraneous_receipt_ignored", side, detail: { receiptId: receipt.id, itemCode: receipt.itemCode } });
        continue;
      }
      const prev = covering.get(receipt.itemCode);
      if (!prev || receipt.signedAt > prev.signedAt) covering.set(receipt.itemCode, receipt);
    }

    if (!deliverable) {
      blockReasons.push({ code: "missing_deliverable_list", side });
    }

    const items =
      deliverable?.items.map((item) => {
        const receipt = covering.get(item.itemCode) ?? null;
        return { itemCode: item.itemCode, title: item.title, covered: receipt !== null, receiptId: receipt?.id ?? null };
      }) ?? [];

    if (deliverable) {
      const missing = items.filter((i) => !i.covered);
      if (missing.length > 0) {
        blockReasons.push({
          code: "partial_delivery",
          side,
          detail: { missing: missing.map((i) => i.itemCode) },
        });
      }
    }

    // 角色确认（R4）
    const confirmation =
      latestBy(
        snapshot.confirmations.filter(
          (c) => c.side === side && c.milestoneCode === mv.milestoneCode && c.role === mv.requiredRole,
        ),
        (c) => c.recordedAt,
      ) ?? null;
    if (!confirmation || confirmation.decision !== "confirmed") {
      blockReasons.push(
        confirmation?.decision === "rejected"
          ? { code: "role_rejected", side, detail: { role: mv.requiredRole, confirmationId: confirmation.id } }
          : { code: "role_not_confirmed", side, detail: { role: mv.requiredRole } },
      );
    }

    const evidenceReady =
      deliverable !== null && items.length > 0
        ? items.every((i) => i.covered)
        : deliverable !== null && items.length === 0
          ? accepted.some((r) => r.itemCode === null) // 空清单需整包回执
          : false;
    if (deliverable !== null && items.length === 0 && !accepted.some((r) => r.itemCode === null)) {
      blockReasons.push({ code: "partial_delivery", side, detail: { missing: ["<whole_package>"] } });
    }
    const roleReady = confirmation?.decision === "confirmed";
    const ownReadyAt =
      evidenceReady && roleReady
        ? Math.max(
            ...[
              ...[...covering.values()].map((r) => r.signedAt),
              ...(deliverable !== null && items.length === 0
                ? accepted.filter((r) => r.itemCode === null).map((r) => r.signedAt)
                : []),
              confirmation ? confirmation.recordedAt : 0,
            ],
          )
        : null;

    const view: MilestoneEvaluation = {
      key,
      side,
      milestoneCode: mv.milestoneCode,
      versionId: mv.versionId,
      seq: mv.seq,
      title: mv.title,
      requiredRole: mv.requiredRole,
      deliverableVersionId: deliverable?.versionId ?? null,
      items,
      acceptedReceipts: accepted
        .filter((r) => r.itemCode === null || requiredCodes.includes(r.itemCode))
        .map((r) => ({
          id: r.id,
          itemCode: r.itemCode,
          digest: r.digest,
          signedAt: iso(r.signedAt),
          receivedAt: iso(r.receivedAt),
        })),
      duplicateReceiptIds: duplicateIds,
      roleConfirmation: confirmation
        ? {
            id: confirmation.id,
            role: confirmation.role,
            decision: confirmation.decision,
            recordedAt: iso(confirmation.recordedAt),
          }
        : null,
      dependencies: mv.dependencies,
      dependencyStates: [],
      satisfied: false,
      satisfiedAtMs: null,
      blockReasons,
      ownReadyAt,
    };
    result.set(key, view);
  }

  // 依赖不动点 + 环检测（R5）
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const cycleNodes = new Set<string>();

  const dfs = (key: string, stack: string[]): void => {
    color.set(key, GRAY);
    const view = result.get(key);
    for (const dep of view?.dependencies ?? []) {
      if (!result.has(dep)) continue; // unknown_dependency 在逐节点处记录
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) {
        const start = stack.indexOf(dep);
        for (const k of stack.slice(start)) cycleNodes.add(k);
        cycleNodes.add(dep);
      } else if (c === WHITE) {
        dfs(dep, [...stack, dep]);
      }
    }
    color.set(key, BLACK);
  };
  for (const key of result.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE) dfs(key, [key]);
  }

  // 自底向上传播满足状态（环上节点一律 blocked，环内不传播满足时刻）
  const computed = new Set<string>();
  const visiting = new Set<string>();
  const resolve = (key: string): void => {
    if (computed.has(key)) return;
    if (visiting.has(key)) return; // 环回边：等 DFS 标记统一处理
    visiting.add(key);
    const view = result.get(key)!;
    for (const dep of view.dependencies) {
      if (result.has(dep)) resolve(dep);
    }

    if (cycleNodes.has(key)) {
      view.dependencyStates = view.dependencies.map((dep) => {
        if (!result.has(dep)) {
          view.blockReasons.push({ code: "unknown_dependency", side: view.side, detail: { dep } });
          return { dep, satisfied: false, satisfiedAt: null, reason: "unknown_dependency" as const };
        }
        const depView = result.get(dep)!;
        return { dep, satisfied: depView.satisfied, satisfiedAt: depView.satisfiedAtMs };
      });
      view.blockReasons.push({
        code: "dependency_cycle",
        side: view.side,
        detail: { cycle: [...cycleNodes].sort() },
      });
      view.satisfied = false;
      view.satisfiedAtMs = null;
    } else {
      view.dependencyStates = view.dependencies.map((dep) => {
        if (!result.has(dep)) {
          view.blockReasons.push({ code: "unknown_dependency", side: view.side, detail: { dep } });
          return { dep, satisfied: false, satisfiedAt: null, reason: "unknown_dependency" as const };
        }
        const depView = result.get(dep)!;
        if (!depView.satisfied) {
          view.blockReasons.push({
            code: depView.blockReasons.some((b) => b.code === "dependency_cycle")
              ? "dependency_cycle"
              : "dependency_unmet",
            side: view.side,
            detail: { dep },
          });
        }
        return { dep, satisfied: depView.satisfied, satisfiedAt: depView.satisfiedAtMs };
      });
      const depsMet = view.dependencyStates.every((s) => s.satisfied);
      view.satisfied = view.ownReadyAt !== null && depsMet;
      view.satisfiedAtMs = view.satisfied
        ? Math.max(view.ownReadyAt!, ...view.dependencyStates.map((s) => s.satisfiedAt ?? 0))
        : null;
    }
    visiting.delete(key);
    computed.add(key);
  };
  for (const key of result.keys()) resolve(key);

  return result;
}

function calendarOf(snapshot: Snapshot, side: Side): PartyCalendar | null {
  const c = snapshot.calendars[side];
  if (!c) return null;
  return { side, ianaTimezone: c.ianaTimezone, weekendDays: c.weekendDays, overrides: c.overrides };
}

function latestSplitsByPair(splits: SplitFact[]): SplitFact[] {
  // 同一 (parent,child) 折叠后只取最新状态行（foldSplits 已保证每个 pair 一条）
  const latest = new Map<string, SplitFact>();
  for (const s of splits) {
    const k = `${s.parentNode}→${s.childNode}`;
    const prev = latest.get(k);
    if (!prev || s.proposedAt > prev.proposedAt) latest.set(k, s);
  }
  return [...latest.values()];
}

/** 按快照重算全部结算节点结论。 */
export function recompute(snapshot: Snapshot): NodeConclusion[] {
  const evaluations = evaluateMilestones(snapshot);

  // 每个父节点的拆分协商状态：proposed（未决）/ confirmed（已共同确认）；rejected 视为无此拆分
  const pendingByParent = new Map<string, SplitFact[]>();
  const confirmedByParent = new Map<string, SplitFact[]>();
  for (const s of latestSplitsByPair(snapshot.splits)) {
    const target = s.status === "proposed" ? pendingByParent : s.status === "confirmed" ? confirmedByParent : null;
    if (!target) continue;
    const list = target.get(s.parentNode) ?? [];
    list.push(s);
    target.set(s.parentNode, list);
  }

  // 已确认映射（R2），同一 node 取最新一行
  const mappings = new Map<string, MappingFact>();
  for (const m of snapshot.mappings) {
    const prev = mappings.get(m.nodeCode);
    if (!prev || m.proposedAt > prev.proposedAt) mappings.set(m.nodeCode, m);
  }
  const confirmed = [...mappings.values()].filter((m) => m.status === "confirmed");

  const openObjections = new Map<string, ObjectionFact[]>();
  for (const o of snapshot.objections) {
    if (o.status === "open" && o.openedAt <= snapshot.asOf && (o.withdrawnAt === null || o.withdrawnAt > snapshot.asOf)) {
      const list = openObjections.get(o.nodeCode) ?? [];
      list.push(o);
      openObjections.set(o.nodeCode, list);
    }
  }

  const conclusions: NodeConclusion[] = [];

  const allocate = (totalCents: number, splits: SplitFact[]): Map<string, number> => {
    const weights = splits.map((s) => s.weight);
    const sumWeight = weights.reduce((a, b) => a + b, 0);
    const exact = weights.map((w) => ({ w, value: (totalCents * w) / sumWeight }));
    const floors = exact.map((x) => Math.floor(x.value));
    let remainder = totalCents - floors.reduce((a, b) => a + b, 0);
    const order = exact
      .map((x, i) => ({ i, frac: x.value - Math.floor(x.value) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (const { i } of order) {
      if (remainder <= 0) break;
      floors[i] += 1;
      remainder -= 1;
    }
    return new Map(splits.map((s, i) => [s.childNode, floors[i]]));
  };

  for (const mapping of confirmed) {
    const pendingSplits = pendingByParent.get(mapping.nodeCode) ?? [];
    const confirmedSplits = confirmedByParent.get(mapping.nodeCode) ?? [];
    const confirmedWeight = confirmedSplits.reduce((sum, s) => sum + s.weight, 0);

    // R3-a：拆分协商未决（存在未响应/未拒绝的提议）→ 父节点 blocked，不出子节点
    if (pendingSplits.length > 0) {
      conclusions.push(blockedSplitConclusion(mapping, "split_negotiation_open", {
        pending: pendingSplits.map((s) => ({ childNode: s.childNode, weight: s.weight, proposedBy: s.proposedBy })),
        confirmedWeight,
      }));
      continue;
    }

    // R3-b：存在已确认拆分但权重不足 10000（其余被拒绝且未补提议）→ blocked
    if (confirmedSplits.length > 0 && confirmedWeight !== 10000) {
      conclusions.push(blockedSplitConclusion(mapping, "split_weight_mismatch", {
        confirmedWeightBasisPoints: confirmedWeight,
        children: confirmedSplits.map((s) => ({ childNode: s.childNode, weight: s.weight })),
      }));
      continue;
    }

    // R3-c：拆分齐备（已确认权重恰为 10000）→ 父节点 superseded，子节点按最大余数法分摊
    if (confirmedSplits.length > 0) {
      conclusions.push({
        nodeCode: mapping.nodeCode,
        status: "superseded",
        amountCents: mapping.amountCents,
        governingSide: mapping.governingSide,
        reasons: [{ code: "superseded_by_split", detail: { children: confirmedSplits.map((s) => s.childNode) } }],
        views: emptyViews(mapping),
        evidence: { mappingId: mapping.id, splitIds: confirmedSplits.map((s) => s.id) },
      });
      const allocations = allocate(mapping.amountCents, confirmedSplits);
      for (const split of confirmedSplits) {
        conclusions.push(buildChildConclusion(snapshot, evaluations, mapping, split, allocations.get(split.childNode) ?? 0, openObjections));
      }
      continue;
    }

    conclusions.push(buildNodeConclusion(snapshot, evaluations, mapping, mapping.amountCents, openObjections, null));
  }

  return conclusions.sort((a, b) => a.nodeCode.localeCompare(b.nodeCode));
}

function blockedSplitConclusion(mapping: MappingFact, code: ReasonCode, detail: unknown): NodeConclusion {
  return {
    nodeCode: mapping.nodeCode,
    status: "blocked",
    amountCents: mapping.amountCents,
    governingSide: mapping.governingSide,
    reasons: [{ code, detail }],
    views: emptyViews(mapping),
    evidence: { mappingId: mapping.id },
  };
}

function emptyViews(mapping: MappingFact): Record<Side, SideView> {
  const blank = (code: string): SideView => ({
    milestoneCode: code,
    versionId: null,
    seq: null,
    title: null,
    requiredRole: null,
    deliverableVersionId: null,
    items: [],
    acceptedReceipts: [],
    duplicateReceiptIds: [],
    roleConfirmation: null,
    dependencies: [],
    dependencyStates: [],
    satisfied: false,
    satisfiedAt: null,
    blockReasons: [],
    due: null,
  });
  return { A: blank(mapping.sideACode), B: blank(mapping.sideBCode) };
}

function buildChildConclusion(
  snapshot: Snapshot,
  evaluations: Map<string, MilestoneEvaluation>,
  parent: MappingFact,
  split: SplitFact,
  amountCents: number,
  openObjections: Map<string, ObjectionFact[]>,
): NodeConclusion {
  // 子节点沿用父节点的 governing_side 与映射状态，但使用拆分时共同确认的双方里程碑码
  const childMapping: MappingFact = {
    ...parent,
    nodeCode: split.childNode,
    sideACode: split.sideACode,
    sideBCode: split.sideBCode,
    amountCents,
  };
  return buildNodeConclusion(snapshot, evaluations, childMapping, amountCents, openObjections, {
    parentNode: split.parentNode,
    splitId: split.id,
    weight: split.weight,
  });
}

function buildNodeConclusion(
  snapshot: Snapshot,
  evaluations: Map<string, MilestoneEvaluation>,
  mapping: MappingFact,
  amountCents: number,
  openObjections: Map<string, ObjectionFact[]>,
  splitInfo: { parentNode: string; splitId: string; weight: number } | null,
): NodeConclusion {
  const reasons: Reason[] = [];
  const views = {} as Record<Side, SideView>;

  for (const side of ["A", "B"] as Side[]) {
    const code = side === "A" ? mapping.sideACode : mapping.sideBCode;
    const evaluation = evaluations.get(`${side}:${code}`);
    const calendar = calendarOf(snapshot, side);
    if (!calendar) reasons.push({ code: "calendar_missing", side });

    if (!evaluation) {
      reasons.push({ code: "milestone_version_missing", side, detail: { milestoneCode: code } });
      views[side] = {
        milestoneCode: code,
        versionId: null,
        seq: null,
        title: null,
        requiredRole: null,
        deliverableVersionId: null,
        items: [],
        acceptedReceipts: [],
        duplicateReceiptIds: [],
        roleConfirmation: null,
        dependencies: [],
        dependencyStates: [],
        satisfied: false,
        satisfiedAt: null,
        blockReasons: [{ code: "milestone_version_missing", side, detail: { milestoneCode: code } }],
        due: null,
      };
      continue;
    }

    const mv = snapshot.milestones.find((m) => m.side === side && m.milestoneCode === code)!;
    const due = calendar
      ? buildDueView({
          declaredDueDate: mv.localDueDate,
          holidayPolicy: mv.holidayPolicy,
          calendar,
          completedAt: evaluation.satisfiedAtMs,
          now: snapshot.asOf,
        })
      : null;
    if (due?.adjustedDueDate !== due?.declaredDueDate) {
      reasons.push({
        code: "holiday_adjusted",
        side,
        detail: { from: due!.declaredDueDate, to: due!.adjustedDueDate },
      });
    }
    if (!evaluation.satisfied) reasons.push(...evaluation.blockReasons);

    views[side] = toSideView(evaluation, due);
  }

  const blocked = reasons.some((r) =>
    [
      "calendar_missing",
      "milestone_version_missing",
      "missing_deliverable_list",
      "partial_delivery",
      "role_not_confirmed",
      "role_rejected",
      "dependency_unmet",
      "dependency_cycle",
      "unknown_dependency",
    ].includes(r.code),
  );

  // R6：双视图逾期分歧
  const gov = mapping.governingSide;
  const other: Side = gov === "A" ? "B" : "A";
  const govDue = views[gov]?.due ?? null;
  const otherDue = views[other]?.due ?? null;
  if (!blocked && govDue?.overdue === true) {
    reasons.push({
      code: "late_under_governing_calendar",
      side: gov,
      detail: { deadline: govDue.deadline, completedAt: govDue.completedAt },
    });
  }
  if (govDue?.overdue === false && otherDue?.overdue === true) {
    reasons.push({
      code: "calendar_views_differ",
      detail: {
        governing: { side: gov, overdue: false },
        other: { side: other, overdue: true, otherDeadline: otherDue.deadline, otherCompletedAt: otherDue.completedAt },
      },
    });
  }

  // R7：异议冻结
  const objections = openObjections.get(mapping.nodeCode) ?? [];
  const frozen = objections.length > 0;
  if (frozen) reasons.push({ code: "objection_open", detail: { objectionIds: objections.map((o) => o.id) } });

  // R9
  let status: NodeConclusion["status"];
  if (blocked) status = "blocked";
  else if (frozen) status = "frozen";
  else if (govDue?.overdue === true) status = "not_payable";
  else status = "payable";

  if (status === "payable") reasons.push({ code: "ok" });

  return {
    nodeCode: mapping.nodeCode,
    status,
    amountCents,
    governingSide: gov,
    reasons,
    views,
    evidence: {
      mappingId: mapping.id,
      split: splitInfo,
      asOf: iso(snapshot.asOf),
      ruleVersion: RULE_VERSION,
      objectionIds: objections.map((o) => o.id),
      milestoneVersions: (["A", "B"] as Side[]).map((side) => {
        const code = side === "A" ? mapping.sideACode : mapping.sideBCode;
        const ev = evaluations.get(`${side}:${code}`);
        return { side, milestoneCode: code, versionId: ev?.versionId ?? null, seq: ev?.seq ?? null };
      }),
    },
  };
}
