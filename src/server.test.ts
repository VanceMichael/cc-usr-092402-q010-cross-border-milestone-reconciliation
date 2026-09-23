
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import type { AddressInfo } from "node:net";
import { createServer } from "./server.js";

const HOLIDAYS_2026_CN = ["10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07"];

let base: string;
let server: ReturnType<typeof createServer>;
let seq = 0;

async function api(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => null)) as any;
  return { status: response.status, json };
}

const HOME = { "x-actor-party": "HOME", "x-actor-role": "lead" };
const PARTNER = { "x-actor-party": "PARTNER", "x-actor-role": "lead" };
const PM = { "x-actor-party": "HOME", "x-actor-role": "project_owner" };

function digest(seed: string): string {
  // 64 位十六进制占位摘要（测试不校验真实性，只校验格式）
  return `sha256:${Buffer.from(seed, "utf8").toString("hex").padEnd(64, "0").slice(0, 64)}`;
}

async function bootstrapCoop(): Promise<{ ref: string; calA: string; calB: string }> {
  seq += 1;
  const ref = `COOP-T${seq}`;
  const r = await api("POST", "/admin/cooperations", {
    cooperation_ref: ref,
    home_party: "HOME",
    partner_party: "PARTNER",
    currency: "CNY",
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const calA = await api("POST", `/admin/cooperations/${ref}/calendars`, {
    calendar_code: `CN-${seq}`,
    iana_timezone: "Asia/Shanghai",
    work_mon: 1, work_tue: 1, work_wed: 1, work_thu: 1, work_fri: 1, work_sat: 0, work_sun: 0,
    valid_from_date: "2026-01-01",
  });
  const calB = await api("POST", `/admin/cooperations/${ref}/calendars`, {
    calendar_code: `DE-${seq}`,
    iana_timezone: "Europe/Berlin",
    work_mon: 1, work_tue: 1, work_wed: 1, work_thu: 1, work_fri: 1, work_sat: 0, work_sun: 0,
    valid_from_date: "2026-01-01",
  });
  for (const md of HOLIDAYS_2026_CN) {
    await api("POST", `/admin/calendars/${calA.json.data.id}/holidays`, {
      holiday_date: `2026-${md}`,
      name: "国庆假期",
    });
  }
  return { ref, calA: calA.json.data.id, calB: calB.json.data.id };
}

async function recordMilestone(
  ref: string,
  headers: Record<string, string>,
  calendarId: string,
  code: string,
  planned: string,
  amount = 1000,
  roles: string[] = [],
): Promise<string> {
  const r = await api(
    "POST",
    `/cooperations/${ref}/milestones`,
    { milestone_code: code, title: code, planned_date: planned, amount, calendar_id: calendarId, required_roles: roles },
    headers,
  );
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.data.id;
}

async function addItem(ref: string, versionId: string, headers: Record<string, string>, code: string, qty = 1) {
  const r = await api("POST", `/cooperations/${ref}/versions/${versionId}/items`, {
    item_code: code, title: code, required_qty: qty,
  }, headers);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.data.id as string;
}

async function deliver(ref: string, versionId: string, headers: Record<string, string>, itemCode: string,
  deliveredAt: string, seed: string, qty = 1) {
  const r = await api("POST", `/cooperations/${ref}/versions/${versionId}/deliveries`, {
    item_code: itemCode, evidence_digest: digest(seed), delivered_at: deliveredAt, qty,
  }, headers);
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
  return r.json.data as { id: string; duplicate: boolean };
}

async function receipt(ref: string, versionId: string, headers: Record<string, string>,
  receiptNo: string, signedAt: string, seed: string) {
  const r = await api("POST", `/cooperations/${ref}/versions/${versionId}/receipts`, {
    receipt_no: receiptNo, evidence_digest: digest(seed), signed_at: signedAt,
  }, headers);
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json));
  return r.json.data as { id: string; duplicate: boolean };
}

before(async () => {
  server = createServer({ databasePath: ":memory:" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const [code, side, name] of [
    ["HOME", "A", "境内团队"],
    ["PARTNER", "B", "境外伙伴"],
  ] as const) {
    const r = await api("POST", "/admin/parties", { party_code: code, side, display_name: name });
    assert.ok(r.status === 201 || r.json?.error?.code === "duplicate");
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("健康接口返回服务状态", async () => {
  const r = await api("GET", "/health");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { data: { status: "ok" } });
});

test("假日调整与时区：同一完成时刻，境内未逾期、境外按当地日历逾期", async () => {
  const { ref, calA, calB } = await bootstrapCoop();
  // 双方约定日同为 10/01；境内该周为国庆假期，顺延至 10/08
  const aId = await recordMilestone(ref, HOME, calA, "M1", "2026-10-01T12:00:00+08:00");
  const bId = await recordMilestone(ref, PARTNER, calB, "M1", "2026-10-01T12:00:00+02:00");
  await addItem(ref, aId, HOME, "doc");
  await addItem(ref, bId, PARTNER, "doc");
  // 物理同一时刻完成：10/08 10:00 北京 = 10/08 04:00 柏林
  await deliver(ref, aId, HOME, "doc", "2026-10-08T10:00:00+08:00", "a-deliver");
  await receipt(ref, aId, PARTNER, "RCV-A-1", "2026-10-08T10:30:00+08:00", "a-receipt");
  await deliver(ref, bId, PARTNER, "doc", "2026-10-08T10:00:00+08:00", "b-deliver");
  await receipt(ref, bId, HOME, "RCV-B-1", "2026-10-08T10:30:00+08:00", "b-receipt");
  // 建立双方共同确认的映射
  const map = await api("POST", `/cooperations/${ref}/mappings`, {
    side_a_version_id: aId, side_b_version_id: bId, relation: "equivalent",
  }, HOME);
  assert.equal(map.status, 201);
  await api("POST", `/cooperations/${ref}/mappings/${map.json.data.id}/confirm`, {}, PARTNER);

  const diff = await api("GET", `/cooperations/${ref}/versions/${aId}/diff`, undefined, HOME);
  assert.equal(diff.status, 200);
  assert.equal(diff.json.data.self.is_overdue, 0, "境内因假日顺延不逾期");
  assert.equal(diff.json.data.mappings[0].counterpart.is_overdue, 1, "境外按当地日历逾期");
  const adjustment = diff.json.data.self.planned.holiday_adjustment;
  assert.equal(adjustment.adjusted_date, "2026-10-08");
  assert.equal(adjustment.shifted_days, 7);
});

test("R1 重复回执与重复交付事件只计一次", async () => {
  const { ref, calA } = await bootstrapCoop();
  const id = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00");
  await addItem(ref, id, HOME, "doc");
  await deliver(ref, id, HOME, "doc", "2026-10-19T10:00:00+08:00", "dup-ev");
  const again = await deliver(ref, id, HOME, "doc", "2026-10-19T11:00:00+08:00", "dup-ev");
  assert.equal(again.duplicate, true);
  await receipt(ref, id, PARTNER, "RCV-DUP", "2026-10-19T12:00:00+08:00", "rcp-1");
  const r2 = await receipt(ref, id, PARTNER, "RCV-DUP", "2026-10-19T13:00:00+08:00", "rcp-2");
  assert.equal(r2.duplicate, true);

  const state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.is_overdue, 0);
  const conclusions = await api("GET", `/cooperations/${ref}/versions/${id}/conclusions`, undefined, HOME);
  const details = conclusions.json.data.at(-1).details;
  assert.equal(details.delivery.complete, true);
  assert.equal(details.receipts.duplicates.length, 0, "重复回执不进入证据基");
  assert.equal(details.delivery.duplicate_events.length, 0, "重复交付事件不进入证据基");
});

test("显式重复标注：不同回执号/摘要但实物同一，落库且不计入", async () => {
  const { ref, calA } = await bootstrapCoop();
  const id = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00");
  await addItem(ref, id, HOME, "doc");
  const ev = await deliver(ref, id, HOME, "doc", "2026-10-19T10:00:00+08:00", "orig-ev");
  const rcp = await receipt(ref, id, PARTNER, "RCV-ORIG", "2026-10-19T11:00:00+08:00", "orig-rcp");
  // 用不同编号与摘要再报一次，但显式标注为重复
  const dupEv = await api("POST", `/cooperations/${ref}/versions/${id}/deliveries`, {
    item_code: "doc", evidence_digest: digest("dup-ev-2"), delivered_at: "2026-10-19T12:00:00+08:00",
    duplicate_of_event_id: ev.id,
  }, HOME);
  assert.equal(dupEv.status, 201);
  assert.equal(dupEv.json.data.duplicate, true);
  const dupRcp = await api("POST", `/cooperations/${ref}/versions/${id}/receipts`, {
    receipt_no: "RCV-DUP2", evidence_digest: digest("dup-rcp-2"), signed_at: "2026-10-19T13:00:00+08:00",
    duplicate_of_receipt_id: rcp.id,
  }, PARTNER);
  assert.equal(dupRcp.status, 201);
  assert.equal(dupRcp.json.data.duplicate, true);

  const conclusions = await api("GET", `/cooperations/${ref}/versions/${id}/conclusions`, undefined, HOME);
  const details = conclusions.json.data.at(-1).details;
  assert.equal(details.delivery.duplicate_events.length, 1);
  assert.equal(details.receipts.duplicates.length, 1);
  assert.equal(details.delivery.complete, true);
});

test("R3 部分交付：数量未达标不形成可付款结论", async () => {
  const { ref, calA } = await bootstrapCoop();
  const id = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00");
  await addItem(ref, id, HOME, "doc", 3);
  await deliver(ref, id, HOME, "doc", "2026-10-19T10:00:00+08:00", "p1", 1);
  await deliver(ref, id, HOME, "doc", "2026-10-19T11:00:00+08:00", "p2", 1);
  let state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.payment_eligible, 0);
  assert.ok(state.json.data.reasons.includes("客观门未全部满足"));

  await deliver(ref, id, HOME, "doc", "2026-10-19T12:00:00+08:00", "p3", 1);
  await receipt(ref, id, PARTNER, "RCV-P", "2026-10-19T13:00:00+08:00", "pr");
  state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.payment_eligible, 1);
});

test("R2 本方撤回更正立即生效，且只能更正本方事实", async () => {
  const { ref, calA } = await bootstrapCoop();
  const id = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00");
  await addItem(ref, id, HOME, "doc");
  const ev = await deliver(ref, id, HOME, "doc", "2026-10-19T10:00:00+08:00", "w1");
  await receipt(ref, id, PARTNER, "RCV-W", "2026-10-19T11:00:00+08:00", "wr");
  let state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.payment_eligible, 1);

  // 境外方不能撤回境内方事实
  const forbidden = await api("POST", `/cooperations/${ref}/facts/delivery_events/${ev.id}/withdraw`,
    { reason: "误报" }, PARTNER);
  assert.equal(forbidden.status, 403);

  const w = await api("POST", `/cooperations/${ref}/facts/delivery_events/${ev.id}/withdraw`,
    { reason: "误登记" }, HOME);
  assert.equal(w.status, 201);
  state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.payment_eligible, 0, "撤回后交付门不再满足");
});

test("映射需双方共同确认才过门；跨方映射不能由单方创建生效", async () => {
  const { ref, calA, calB } = await bootstrapCoop();
  const aId = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00");
  const bId = await recordMilestone(ref, PARTNER, calB, "M1", "2026-10-20T12:00:00+02:00");
  for (const [id, h, seed] of [[aId, HOME, "am"], [bId, PARTNER, "bm"]] as const) {
    await addItem(ref, id, h, "doc");
    await deliver(ref, id, h, "doc", "2026-10-19T10:00:00+08:00", seed);
    await receipt(ref, id, h, `RCV-${seed}`, "2026-10-19T11:00:00+08:00", `${seed}r`);
  }
  const map = await api("POST", `/cooperations/${ref}/mappings`, {
    side_a_version_id: aId, side_b_version_id: bId,
  }, HOME);
  let state = await api("GET", `/cooperations/${ref}/versions/${aId}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.payment_eligible, 0, "单方确认的映射不过门");

  await api("POST", `/cooperations/${ref}/mappings/${map.json.data.id}/confirm`, {}, PARTNER);
  state = await api("GET", `/cooperations/${ref}/versions/${aId}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.payment_eligible, 1);
});

test("R9 依赖门：被依赖里程碑可付款后，下游才满足", async () => {
  const { ref, calA } = await bootstrapCoop();
  const m1 = await recordMilestone(ref, HOME, calA, "M1", "2026-10-10T12:00:00+08:00");
  const m2 = await recordMilestone(ref, HOME, calA, "M2", "2026-10-20T12:00:00+08:00");
  await addItem(ref, m1, HOME, "d1");
  await addItem(ref, m2, HOME, "d2");
  const dep = await api("POST", `/cooperations/${ref}/dependencies`, {
    version_id: m2, depends_on_version_id: m1,
  }, HOME);
  assert.equal(dep.status, 201);
  await deliver(ref, m2, HOME, "d2", "2026-10-18T10:00:00+08:00", "m2d");
  await receipt(ref, m2, PARTNER, "RCV-M2", "2026-10-18T11:00:00+08:00", "m2r");
  let s2 = await api("GET", `/cooperations/${ref}/versions/${m2}/payable`, undefined, HOME);
  assert.equal(s2.json.data.conclusion.payment_eligible, 0, "上游未付款，依赖门不满足");

  await deliver(ref, m1, HOME, "d1", "2026-10-09T10:00:00+08:00", "m1d");
  await receipt(ref, m1, PARTNER, "RCV-M1", "2026-10-09T11:00:00+08:00", "m1r");
  s2 = await api("GET", `/cooperations/${ref}/versions/${m2}/payable`, undefined, HOME);
  assert.equal(s2.json.data.conclusion.payment_eligible, 1);
});

test("约定角色确认齐备后才可付款", async () => {
  const { ref, calA } = await bootstrapCoop();
  const id = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00", 500,
    ["HOME:lead", "PARTNER:lead"]);
  await addItem(ref, id, HOME, "doc");
  await deliver(ref, id, HOME, "doc", "2026-10-19T10:00:00+08:00", "role-d");
  await receipt(ref, id, PARTNER, "RCV-ROLE", "2026-10-19T11:00:00+08:00", "role-r");
  let state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.conclusion.payment_eligible, 1, "客观门满足");
  assert.equal(state.json.data.payable, false, "角色未确认，不可付款");

  const conclusionId = state.json.data.conclusion.id;
  const c1 = await api("POST", `/cooperations/${ref}/conclusions/${conclusionId}/confirm`,
    { role: "HOME:lead" }, HOME);
  assert.equal(c1.status, 201);
  const c2 = await api("POST", `/cooperations/${ref}/conclusions/${conclusionId}/confirm`,
    { role: "PARTNER:lead" }, PARTNER);
  assert.equal(c2.status, 201);
  state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.payable, true);
  assert.equal(state.json.data.conclusion.payment_amount, 500);
});

test("R6 争议冻结相关金额但不阻塞无关节点", async () => {
  const { ref, calA } = await bootstrapCoop();
  const m1 = await recordMilestone(ref, HOME, calA, "M1", "2026-10-10T12:00:00+08:00");
  const m2 = await recordMilestone(ref, HOME, calA, "M2", "2026-10-20T12:00:00+08:00");
  for (const [id, code, seed] of [[m1, "i1", "m1"], [m2, "i2", "m2"]] as const) {
    await addItem(ref, id, HOME, code);
    await deliver(ref, id, HOME, code, "2026-10-09T10:00:00+08:00", seed);
    await receipt(ref, id, PARTNER, `RCV-${seed}`, "2026-10-09T11:00:00+08:00", `${seed}r`);
  }
  const dispute = await api("POST", `/cooperations/${ref}/disputes`, {
    subject_version_id: m1, reason: "对签收口径有异议", raised_at: "2026-10-09T12:00:00+08:00",
  }, PARTNER);
  assert.equal(dispute.status, 201);

  const s1 = await api("GET", `/cooperations/${ref}/versions/${m1}/payable`, undefined, HOME);
  assert.equal(s1.json.data.frozen, true);
  assert.equal(s1.json.data.payable, false);
  const s2 = await api("GET", `/cooperations/${ref}/versions/${m2}/payable`, undefined, HOME);
  assert.equal(s2.json.data.frozen, false, "无关节点不被冻结");
  assert.equal(s2.json.data.payable, true);

  // 关闭批次：只有未冻结的 M2 入批
  const batch = await api("POST", `/cooperations/${ref}/batches`, { batch_no: `B-${seq}-1` }, HOME);
  const closed = await api("POST", `/cooperations/${ref}/batches/${batch.json.data.id}/close`, {}, HOME);
  assert.equal(closed.status, 200);
  const included = closed.json.data.entries.map((e: any) => e.version_id);
  assert.deepEqual(included, [m2]);

  // 解决异议后冻结释放
  const resolved = await api("POST",
    `/cooperations/${ref}/disputes/${dispute.json.data.dispute.id}/resolve`, { note: "口径对齐" }, PM);
  assert.equal(resolved.status, 200);
  const s1After = await api("GET", `/cooperations/${ref}/versions/${m1}/payable`, undefined, HOME);
  assert.equal(s1After.json.data.frozen, false);
});

test("R7 已付款结论只能冲正+替代，冲正后重新进入付款", async () => {
  const { ref, calA } = await bootstrapCoop();
  const id = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00", 1000);
  await addItem(ref, id, HOME, "doc");
  await deliver(ref, id, HOME, "doc", "2026-10-19T10:00:00+08:00", "rev-d");
  await receipt(ref, id, PARTNER, "RCV-REV", "2026-10-19T11:00:00+08:00", "rev-r");
  const batch = await api("POST", `/cooperations/${ref}/batches`, { batch_no: `B-${seq}-1` }, HOME);
  const closed = await api("POST", `/cooperations/${ref}/batches/${batch.json.data.id}/close`, {}, HOME);
  const entry = closed.json.data.entries[0];
  assert.equal(entry.amount, 1000);

  // 撤回交付事实 -> 新结论不可付款；旧结论不可改写，只能冲正
  const events = await api("GET", `/cooperations/${ref}/audit`, undefined, HOME);
  const eventId = events.json.data.find((e: any) => e.action === "delivery.recorded").entity_id;
  await api("POST", `/cooperations/${ref}/facts/delivery_events/${eventId}/withdraw`,
    { reason: "交付物有误" }, HOME);

  const reversal = await api("POST",
    `/cooperations/${ref}/conclusions/${entry.conclusion_id}/reversals`,
    { reason_code: "factual_error", reason: "交付被撤回" }, PARTNER);
  assert.equal(reversal.status, 201);
  const accepted = await api("POST",
    `/cooperations/${ref}/reversals/${reversal.json.data.id}/accept`, {}, PM);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.data.net_amount, -1000, "无可付款替代结论，净额 -1000");

  // 原批次条目标记为 reversed；原结论仍可查（不可变）
  const batchView = await api("GET", `/cooperations/${ref}/batches/${batch.json.data.id}`, undefined, HOME);
  assert.equal(batchView.json.data.entries[0].status, "reversed");
  const oldConclusion = await api("GET",
    `/cooperations/${ref}/versions/${id}/conclusions`, undefined, HOME);
  const settled = oldConclusion.json.data.find((c: any) => c.id === entry.conclusion_id);
  assert.ok(settled, "入批结论仍然可查");
  assert.equal(settled.payment_eligible, 1, "历史结论保持原样");
  const state = await api("GET", `/cooperations/${ref}/versions/${id}/payable`, undefined, HOME);
  assert.equal(state.json.data.reversed, true);
});

test("R10 已付款里程碑拆分前必须先冲正；未付款可直接拆分", async () => {
  const { ref, calA } = await bootstrapCoop();
  const parent = await recordMilestone(ref, HOME, calA, "BIG", "2026-10-20T12:00:00+08:00", 1000);
  await addItem(ref, parent, HOME, "doc");
  await deliver(ref, parent, HOME, "doc", "2026-10-19T10:00:00+08:00", "big-d");
  await receipt(ref, parent, PARTNER, "RCV-BIG", "2026-10-19T11:00:00+08:00", "big-r");
  const batch = await api("POST", `/cooperations/${ref}/batches`, { batch_no: `B-${seq}-1` }, HOME);
  await api("POST", `/cooperations/${ref}/batches/${batch.json.data.id}/close`, {}, HOME);

  const blocked = await api("POST", `/cooperations/${ref}/milestones/${parent}/split`, {
    children: [
      { milestone_code: "BIG-1", title: "部分一", planned_date: "2026-10-21T12:00:00+08:00", amount: 600, weight: 0.6, calendar_id: calA },
      { milestone_code: "BIG-2", title: "部分二", planned_date: "2026-10-22T12:00:00+08:00", amount: 400, weight: 0.4, calendar_id: calA },
    ],
  }, HOME);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, "split_requires_reversal");

  // 未付款里程碑可直接拆分，权重和必须为 1
  const other = await recordMilestone(ref, HOME, calA, "NEW", "2026-11-01T12:00:00+08:00", 800);
  const badWeights = await api("POST", `/cooperations/${ref}/milestones/${other}/split`, {
    children: [
      { milestone_code: "NEW-1", title: "一", planned_date: "2026-11-02T12:00:00+08:00", amount: 500, weight: 0.5, calendar_id: calA },
      { milestone_code: "NEW-2", title: "二", planned_date: "2026-11-03T12:00:00+08:00", amount: 300, weight: 0.4, calendar_id: calA },
    ],
  }, HOME);
  assert.equal(badWeights.status, 409);
  const ok = await api("POST", `/cooperations/${ref}/milestones/${other}/split`, {
    children: [
      { milestone_code: "NEW-1", title: "一", planned_date: "2026-11-02T12:00:00+08:00", amount: 500, weight: 0.5, calendar_id: calA, required_roles: [] },
      { milestone_code: "NEW-2", title: "二", planned_date: "2026-11-03T12:00:00+08:00", amount: 300, weight: 0.5, calendar_id: calA, required_roles: [] },
    ],
  }, HOME);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.data.length, 2);
});

test("R5 迟到证据：批次重放使用截止时刻证据，当前视角标注偏离", async () => {
  const { ref, calA } = await bootstrapCoop();
  const id = await recordMilestone(ref, HOME, calA, "M1", "2026-10-20T12:00:00+08:00");
  await addItem(ref, id, HOME, "doc");
  await deliver(ref, id, HOME, "doc", "2026-10-19T10:00:00+08:00", "early");
  await receipt(ref, id, PARTNER, "RCV-EARLY", "2026-10-19T11:00:00+08:00", "earlyr");
  const batch = await api("POST", `/cooperations/${ref}/batches`, { batch_no: `B-${seq}-1` }, HOME);
  await api("POST", `/cooperations/${ref}/batches/${batch.json.data.id}/close`, {}, HOME);
  const basisAtBatch = (await api("GET", `/cooperations/${ref}/batches/${batch.json.data.id}`, undefined, HOME))
    .json.data.entries[0].basis_hash;

  // 批次关闭后又登记一份新交付证据（迟到证据）
  await deliver(ref, id, HOME, "doc", "2026-10-19T15:00:00+08:00", "late");

  const replay = await api("GET", `/cooperations/${ref}/batches/${batch.json.data.id}/replay`, undefined, HOME);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.data.all_reproduced, true, "内嵌快照按当时规则复现");
  const entry = replay.json.data.entries[0];
  assert.equal(entry.snapshot_reproduced, true);
  assert.equal(entry.current_matches, true, "按批次截止时刻汇聚，迟到证据被排除");
  assert.equal(entry.live_view.differs_from_batch, true, "无截止当前视角证据基已偏离");
  assert.equal(entry.live_view.basis_hash !== basisAtBatch, true);
  assert.equal(entry.live_view.late_events.length, 1);
});

test("历史批次不可变：关闭后的撤回/迟到证据/新依赖不改变按批次重放", async () => {
  const { ref, calA } = await bootstrapCoop();
  const m1 = await recordMilestone(ref, HOME, calA, "M1", "2026-10-10T12:00:00+08:00");
  const m2 = await recordMilestone(ref, HOME, calA, "M2", "2026-10-20T12:00:00+08:00");
  await api("POST", `/cooperations/${ref}/dependencies`,
    { version_id: m2, depends_on_version_id: m1 }, HOME);
  for (const [id, code, seed] of [[m1, "i1", "h1"], [m2, "i2", "h2"]] as const) {
    await addItem(ref, id, HOME, code);
    await deliver(ref, id, HOME, code, "2026-10-09T10:00:00+08:00", seed);
    await receipt(ref, id, PARTNER, `RCV-${seed}`, "2026-10-09T11:00:00+08:00", `${seed}r`);
  }
  const batch = await api("POST", `/cooperations/${ref}/batches`, { batch_no: `B-${seq}-1` }, HOME);
  await api("POST", `/cooperations/${ref}/batches/${batch.json.data.id}/close`, {}, HOME);

  // 批次关闭后：撤回 M1 交付；M2 补迟到证据；新增下游 M3 并挂依赖
  // 精确定位 M1 的交付事件：查结论内嵌输入
  const m1Conclusions = await api("GET",
    `/cooperations/${ref}/versions/${m1}/conclusions?inputs=1`, undefined, HOME);
  const m1EventId = m1Conclusions.json.data.at(-1).inputs.events[0].id;
  await api("POST", `/cooperations/${ref}/facts/delivery_events/${m1EventId}/withdraw`,
    { reason: "批次后撤回" }, HOME);
  await deliver(ref, m2, HOME, "i2", "2026-10-09T15:00:00+08:00", "h2-late");
  const m3 = await recordMilestone(ref, HOME, calA, "M3", "2026-11-01T12:00:00+08:00");
  await api("POST", `/cooperations/${ref}/dependencies`,
    { version_id: m3, depends_on_version_id: m2 }, HOME);

  const replay = await api("GET",
    `/cooperations/${ref}/batches/${batch.json.data.id}/replay`, undefined, HOME);
  assert.equal(replay.json.data.all_reproduced, true);
  for (const entry of replay.json.data.entries) {
    assert.equal(entry.snapshot_reproduced, true);
    assert.equal(entry.current_matches, true, "按批次截止汇聚：撤回/迟到/新依赖全部被排除");
  }
  // 当前视角下 M1 因撤回已偏离批次，M2 因迟到证据偏离
  const byVersion = Object.fromEntries(
    replay.json.data.entries.map((e: any) => [e.version_id, e]),
  );
  assert.equal(byVersion[m1].live_view.differs_from_batch, true);
  assert.equal(byVersion[m2].live_view.differs_from_batch, true);
});

test("非法输入在边界被拒：坏时间、坏摘要、坏时区", async () => {
  const { ref, calA } = await bootstrapCoop();
  const badTime = await api("POST", `/cooperations/${ref}/milestones`, {
    milestone_code: "X", title: "X", planned_date: "2026-10-01", amount: 1, calendar_id: calA,
  }, HOME);
  assert.equal(badTime.status, 400);
  assert.equal(badTime.json.error.code, "invalid_time");
  const id = await recordMilestone(ref, HOME, calA, "M9", "2026-10-20T12:00:00+08:00");
  await addItem(ref, id, HOME, "doc");
  const badDigest = await api("POST", `/cooperations/${ref}/versions/${id}/deliveries`, {
    item_code: "doc", evidence_digest: "not-a-digest", delivered_at: "2026-10-19T10:00:00+08:00",
  }, HOME);
  assert.equal(badDigest.status, 400);
  const badTz = await api("POST", `/admin/cooperations/${ref}/calendars`, {
    calendar_code: "BAD", iana_timezone: "Mars/Olympus", valid_from_date: "2026-01-01",
  });
  assert.equal(badTz.status, 400);
});

test("未认证请求被拒绝；项目负责人可查看全局状态与审计", async () => {
  const r = await api("GET", "/cooperations/NOPE/state");
  assert.equal(r.status, 401);
  const { ref, calA } = await bootstrapCoop();
  const state = await api("GET", `/cooperations/${ref}/state`, undefined, PM);
  assert.equal(state.status, 200);
  const auditView = await api("GET", `/cooperations/${ref}/audit`, undefined, PM);
  assert.equal(auditView.status, 200);
  assert.ok(Array.isArray(auditView.json.data));
  // 非项目负责人不能受理冲正
  const denied = await api("POST", `/cooperations/${ref}/reversals/nope/accept`, {}, HOME);
  assert.equal(denied.status, 403);
});
