// 规则引擎纯函数测试：快照 → 结论。固定输入必须得到固定输出（重放确定性的核心）。

import assert from "node:assert/strict";
import test from "node:test";
import { recompute, RULE_VERSION, type NodeConclusion } from "./rules.js";
import type {
  CalendarSnapshot,
  MappingFact,
  MilestoneFact,
  ObjectionFact,
  ReceiptFact,
  Snapshot,
  SplitFact,
} from "./types.js";
import type { Side } from "./time.js";

const T = Date.parse("2026-09-20T00:00:00Z");
const DIGEST_A = "sha256:" + "a".repeat(64);
const DIGEST_B = "sha256:" + "b".repeat(64);

function calendar(side: Side, tz: string, overrides: CalendarSnapshot["overrides"] = {}): CalendarSnapshot {
  return { side, ianaTimezone: tz, weekendDays: [0, 6], overrides };
}

interface ReceiptDef {
  itemCode: string | null;
  digest: string;
  signedAt?: string;
  status?: "accepted" | "duplicate";
  duplicateOf?: string | null;
}

interface FixtureOptions {
  dueA?: string;
  dueB?: string;
  items?: { itemCode: string; title: string }[];
  receipts?: ReceiptDef[];
  roleConfirmed?: boolean;
  completedAt?: string;
  confirmedAt?: string;
  holidayOverridesA?: CalendarSnapshot["overrides"];
  depsA?: string[];
  depsB?: string[];
  amount?: number;
  governing?: Side;
  policy?: "as_is" | "next_workday";
  objections?: ObjectionFact[];
  splits?: SplitFact[];
  mappingStatus?: MappingFact["status"];
  extraMilestones?: MilestoneFact[];
  tzA?: string;
  tzB?: string;
}

function fixture(opts: FixtureOptions = {}): Snapshot {
  const signedAt = opts.completedAt ?? "2026-09-14T10:00:00Z";
  const items = opts.items ?? [{ itemCode: "D1", title: "文档" }];
  const receiptsDefs: ReceiptDef[] = opts.receipts ?? items.map((i) => ({ itemCode: i.itemCode, digest: DIGEST_A, signedAt }));
  const receipts: ReceiptFact[] = receiptsDefs.map((r, i) => ({
    id: `r${i}`,
    side: "A",
    milestoneCode: "M1",
    itemCode: r.itemCode,
    digest: r.digest,
    sourceRef: `src-${i}`,
    signedAt: Date.parse(r.signedAt ?? signedAt),
    receivedAt: Date.parse(r.signedAt ?? signedAt),
    status: r.status ?? "accepted",
    duplicateOf: r.duplicateOf ?? null,
    recordedAt: Date.parse(r.signedAt ?? signedAt),
  }));
  // B 方镜像同结构回执
  for (const [i, r] of receiptsDefs.entries()) {
    receipts.push({
      id: `rb${i}`,
      side: "B",
      milestoneCode: "X1",
      itemCode: r.itemCode,
      digest: r.digest === DIGEST_A ? DIGEST_B : r.digest,
      sourceRef: `srcb-${i}`,
      signedAt: Date.parse(r.signedAt ?? signedAt),
      receivedAt: Date.parse(r.signedAt ?? signedAt),
      status: r.status ?? "accepted",
      duplicateOf: null,
      recordedAt: Date.parse(r.signedAt ?? signedAt),
    });
  }

  const mv = (side: Side, code: string, due: string, deps: string[]): MilestoneFact => ({
    versionId: `mv-${side}`,
    seq: 1,
    side,
    milestoneCode: code,
    title: `${side}-${code}`,
    localDueDate: due,
    dependencies: deps,
    requiredRole: "approver",
    holidayPolicy: opts.policy ?? "next_workday",
    recordedAt: Date.parse("2026-09-01T00:00:00Z"),
  });

  const milestones: MilestoneFact[] = [
    mv("A", "M1", opts.dueA ?? "2026-09-15", opts.depsA ?? []),
    mv("B", "X1", opts.dueB ?? "2026-09-15", opts.depsB ?? []),
    ...(opts.extraMilestones ?? []),
  ];

  const mapping: MappingFact = {
    id: "map-1",
    nodeCode: "N1",
    sideACode: "M1",
    sideBCode: "X1",
    amountCents: opts.amount ?? 10000,
    governingSide: opts.governing ?? "A",
    proposedBy: "A",
    proposedAt: Date.parse("2026-09-02T00:00:00Z"),
    status: opts.mappingStatus ?? "confirmed",
    respondedBy: "B",
    respondedAt: Date.parse("2026-09-03T00:00:00Z"),
    events: [],
  };

  return {
    cooperationRef: "COOP-T",
    asOf: T,
    calendars: {
      A: calendar("A", opts.tzA ?? "Asia/Shanghai", opts.holidayOverridesA ?? {}),
      B: calendar("B", opts.tzB ?? "Europe/Berlin"),
    },
    milestones,
    deliverables: [
      { versionId: "dv-A", version: 1, side: "A", milestoneCode: "M1", items, recordedAt: Date.parse("2026-09-01T00:00:00Z") },
      { versionId: "dv-B", version: 1, side: "B", milestoneCode: "X1", items, recordedAt: Date.parse("2026-09-01T00:00:00Z") },
    ],
    receipts,
    confirmations:
      opts.roleConfirmed === false
        ? []
        : [
            { id: "cf-A", side: "A", milestoneCode: "M1", role: "approver", actorRef: "a-approver", decision: "confirmed", note: null, recordedAt: Date.parse(opts.confirmedAt ?? signedAt) },
            { id: "cf-B", side: "B", milestoneCode: "X1", role: "approver", actorRef: "b-approver", decision: "confirmed", note: null, recordedAt: Date.parse(opts.confirmedAt ?? signedAt) },
          ],
    mappings: [mapping],
    splits: opts.splits ?? [],
    objections: opts.objections ?? [],
  };
}

function byNode(rows: NodeConclusion[], code: string): NodeConclusion {
  const found = rows.find((r) => r.nodeCode === code);
  assert.ok(found, `结论中缺少节点 ${code}，实际：${rows.map((r) => r.nodeCode).join(",")}`);
  return found;
}

test("依赖满足、角色确认、回执齐全且未逾期 → payable", () => {
  const result = recompute(fixture());
  const n1 = byNode(result, "N1");
  assert.equal(n1.status, "payable");
  assert.equal(n1.amountCents, 10000);
  assert.equal(n1.views.A.satisfied, true);
  assert.equal(n1.views.A.due?.overdue, false);
});

test("重复回执被剔除但交付仍齐全 → payable，重复 id 留痕", () => {
  const result = recompute(
    fixture({
      receipts: [
        { itemCode: "D1", digest: DIGEST_A, signedAt: "2026-09-14T10:00:00Z" },
        { itemCode: "D1", digest: DIGEST_A, signedAt: "2026-09-15T10:00:00Z", status: "duplicate", duplicateOf: "r0" },
      ],
    }),
  );
  const n1 = byNode(result, "N1");
  assert.equal(n1.status, "payable");
  assert.deepEqual(n1.views.A.duplicateReceiptIds, ["r1"]);
  assert.equal(n1.views.A.acceptedReceipts.length, 1);
});

test("部分交付（清单两项只签收一项）→ blocked/partial_delivery", () => {
  const result = recompute(
    fixture({
      items: [
        { itemCode: "D1", title: "文档" },
        { itemCode: "D2", title: "样品" },
      ],
      receipts: [{ itemCode: "D1", digest: DIGEST_A, signedAt: "2026-09-14T10:00:00Z" }],
    }),
  );
  const n1 = byNode(result, "N1");
  assert.equal(n1.status, "blocked");
  assert.ok(n1.reasons.some((r) => r.code === "partial_delivery"));
  assert.deepEqual(n1.views.A.items.find((i) => i.itemCode === "D2")?.covered, false);
});

test("约定角色未确认 → blocked/role_not_confirmed", () => {
  const result = recompute(fixture({ roleConfirmed: false }));
  assert.equal(byNode(result, "N1").status, "blocked");
  assert.ok(byNode(result, "N1").reasons.some((r) => r.code === "role_not_confirmed"));
});

test("假日调整：到期日落在登记假日内，顺延到下一工作日，不视为逾期", () => {
  // 2026-09-14 周一至 09-18 周五登记为 A 方假日；due=09-14 应顺延至 09-21 周一
  const overrides: CalendarSnapshot["overrides"] = {};
  for (let d = 14; d <= 18; d += 1) overrides[`2026-09-${String(d).padStart(2, "0")}`] = "holiday";
  const result = recompute(
    fixture({ dueA: "2026-09-14", completedAt: "2026-09-16T02:00:00Z", holidayOverridesA: overrides }),
  );
  const n1 = byNode(result, "N1");
  assert.equal(n1.views.A.due?.adjustedDueDate, "2026-09-21");
  assert.equal(n1.views.A.due?.overdue, false);
  assert.ok(n1.reasons.some((r) => r.code === "holiday_adjusted" && r.side === "A"));
});

test("补班覆盖：周末登记为 workday 时不顺延", () => {
  // 2026-09-13 周日被 A 登记为补班日，due 即当日，完成在当晚北京时区仍算按期
  const result = recompute(
    fixture({ dueA: "2026-09-13", completedAt: "2026-09-13T12:00:00Z", holidayOverridesA: { "2026-09-13": "workday" } }),
  );
  const n1 = byNode(result, "N1");
  assert.equal(n1.views.A.due?.adjustedDueDate, "2026-09-13");
  assert.equal(n1.views.A.due?.overdue, false);
});

test("时区双视图分歧：governing=B 认为按期 → payable 但记录 calendar_views_differ", () => {
  // 完成时刻 2026-09-15T18:00Z：北京 09-16 02:00（A 逾期），柏林 09-15 20:00（B 按期）
  const result = recompute(fixture({ completedAt: "2026-09-15T18:00:00Z", confirmedAt: "2026-09-15T18:00:00Z", governing: "B" }));
  const n1 = byNode(result, "N1");
  assert.equal(n1.views.A.due?.overdue, true);
  assert.equal(n1.views.B.due?.overdue, false);
  assert.equal(n1.status, "payable");
  assert.ok(n1.reasons.some((r) => r.code === "calendar_views_differ"));
  assert.ok(!n1.reasons.some((r) => r.code === "late_under_governing_calendar"));
});

test("governing 视角逾期 → not_payable", () => {
  const result = recompute(
    fixture({ completedAt: "2026-09-15T18:00:00Z", confirmedAt: "2026-09-15T18:00:00Z", governing: "A" }),
  );
  assert.equal(byNode(result, "N1").status, "not_payable");
  assert.ok(byNode(result, "N1").reasons.some((r) => r.code === "late_under_governing_calendar"));
});

test("依赖未满足 → blocked/dependency_unmet，完成时刻并入依赖", () => {
  const result = recompute(
    fixture({
      depsB: ["A:M1"],
      // A 方不满足：不给角色确认
      roleConfirmed: false,
    }),
  );
  const n1 = byNode(result, "N1");
  assert.equal(n1.status, "blocked");
  assert.ok(n1.reasons.some((r) => r.code === "dependency_unmet"));
});

test("依赖成环 → blocked/dependency_cycle", () => {
  const result = recompute(
    fixture({
      depsA: ["B:X1"],
      depsB: ["A:M1"],
    }),
  );
  const n1 = byNode(result, "N1");
  assert.equal(n1.status, "blocked");
  assert.ok(n1.reasons.some((r) => r.code === "dependency_cycle"));
});

test("异议只冻结本节点：N1 frozen，无关节点 N2 仍 payable", () => {
  const snap = fixture({
    objections: [
      {
        id: "obj-1",
        nodeCode: "N1",
        side: "B",
        reasonDigest: "sha256:" + "c".repeat(64),
        detailRef: null,
        status: "open",
        openedAt: Date.parse("2026-09-19T00:00:00Z"),
        withdrawnAt: null,
      },
    ],
  });
  snap.mappings.push({
    id: "map-2",
    nodeCode: "N2",
    sideACode: "M1",
    sideBCode: "X1",
    amountCents: 5000,
    governingSide: "A",
    proposedBy: "A",
    proposedAt: Date.parse("2026-09-02T00:00:00Z"),
    status: "confirmed",
    respondedBy: "B",
    respondedAt: Date.parse("2026-09-03T00:00:00Z"),
    events: [],
  });
  const result = recompute(snap);
  assert.equal(byNode(result, "N1").status, "frozen");
  assert.equal(byNode(result, "N1").amountCents, 10000); // 金额保留
  assert.equal(byNode(result, "N2").status, "payable");
  assert.equal(byNode(result, "N2").amountCents, 5000);
});

test("已撤回的异议不冻结", () => {
  const result = recompute(
    fixture({
      objections: [
        {
          id: "obj-1",
          nodeCode: "N1",
          side: "B",
          reasonDigest: "sha256:" + "c".repeat(64),
          detailRef: null,
          status: "withdrawn",
          openedAt: Date.parse("2026-09-18T00:00:00Z"),
          withdrawnAt: Date.parse("2026-09-19T00:00:00Z"),
        },
      ],
    }),
  );
  assert.equal(byNode(result, "N1").status, "payable");
});

test("里程碑拆分：父节点 superseded，子节点按最大余数法分摊（10001 分 60/40）", () => {
  const splits: SplitFact[] = [
    { id: "s1", parentNode: "N1", childNode: "N1.1", weight: 6000, sideACode: "M1", sideBCode: "X1", proposedBy: "A", proposedAt: 1, status: "confirmed", respondedBy: "B", respondedAt: 2 },
    { id: "s2", parentNode: "N1", childNode: "N1.2", weight: 4000, sideACode: "M1", sideBCode: "X1", proposedBy: "A", proposedAt: 1, status: "confirmed", respondedBy: "B", respondedAt: 2 },
  ];
  const result = recompute(fixture({ amount: 10001, splits }));
  assert.equal(byNode(result, "N1").status, "superseded");
  assert.equal(byNode(result, "N1.1").amountCents, 6001);
  assert.equal(byNode(result, "N1.2").amountCents, 4000);
  assert.equal(byNode(result, "N1.1").status, "payable");
});

test("拆分协商未决（存在 proposed 子拆分）→ 父节点 blocked，不出子节点结论", () => {
  const splits: SplitFact[] = [
    { id: "s1", parentNode: "N1", childNode: "N1.1", weight: 6000, sideACode: "M1", sideBCode: "X1", proposedBy: "A", proposedAt: 1, status: "confirmed", respondedBy: "B", respondedAt: 2 },
    { id: "s2", parentNode: "N1", childNode: "N1.2", weight: 4000, sideACode: "M1", sideBCode: "X1", proposedBy: "A", proposedAt: 3, status: "proposed", respondedBy: null, respondedAt: null },
  ];
  const result = recompute(fixture({ splits }));
  assert.equal(byNode(result, "N1").status, "blocked");
  assert.ok(byNode(result, "N1").reasons.some((r) => r.code === "split_negotiation_open"));
  assert.ok(!result.some((c) => c.nodeCode === "N1.1"));
});

test("已确认拆分权重不足 10000 且无未决提议 → blocked/split_weight_mismatch", () => {
  const splits: SplitFact[] = [
    { id: "s1", parentNode: "N1", childNode: "N1.1", weight: 6000, sideACode: "M1", sideBCode: "X1", proposedBy: "A", proposedAt: 1, status: "confirmed", respondedBy: "B", respondedAt: 2 },
    { id: "s2", parentNode: "N1", childNode: "N1.2", weight: 4000, sideACode: "M1", sideBCode: "X1", proposedBy: "A", proposedAt: 1, status: "rejected", respondedBy: "B", respondedAt: 2 },
  ];
  const result = recompute(fixture({ splits }));
  assert.equal(byNode(result, "N1").status, "blocked");
  assert.ok(byNode(result, "N1").reasons.some((r) => r.code === "split_weight_mismatch"));
});

test("映射仅 proposed 不产生结算节点", () => {
  const result = recompute(fixture({ mappingStatus: "proposed" }));
  assert.equal(result.length, 0);
});

test("结论快照携带规则版本与截止时刻", () => {
  const n1 = byNode(recompute(fixture()), "N1");
  assert.equal(n1.evidence.ruleVersion, RULE_VERSION);
  assert.equal(n1.evidence.asOf, new Date(T).toISOString());
});
