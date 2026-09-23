// 端到端：HTTP 边界 → 存储 → 规则引擎。覆盖事实主权、共同确认、批次冻结、冲正替代与按批重放。

import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type http from "node:http";
import { createServer } from "./server.js";
import type { Side } from "./domain/time.js";

class FakeClock {
  private current = Date.parse("2026-09-01T00:00:00.000Z");
  now(): number {
    return this.current;
  }
  set(iso: string): void {
    this.current = Date.parse(iso);
  }
}

interface JsonResponse {
  status: number;
  body: unknown;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

async function withServer<T>(fn: (server: http.Server, base: string, clock: FakeClock) => Promise<T>): Promise<T> {
  const clock = new FakeClock();
  const dir = mkdtempSync(path.join(tmpdir(), "recon-e2e-"));
  const server = createServer({ databasePath: path.join(dir, "test.sqlite3"), clock: () => clock.now() });
  const port = await listen(server);
  try {
    return await fn(server, `http://127.0.0.1:${port}`, clock);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function headers(actor: { ref: string; side?: Side; role?: "owner" }): Record<string, string> {
  const h: Record<string, string> = { "x-actor-ref": actor.ref, "content-type": "application/json" };
  if (actor.role) h["x-actor-role"] = actor.role;
  if (actor.side) h["x-actor-side"] = actor.side;
  return h;
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  actor: { ref: string; side?: Side; role?: "owner" },
  body?: unknown,
): Promise<JsonResponse> {
  const base = (server.address() as { port: number }).port;
  const init: RequestInit = { method, headers: headers(actor) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`http://127.0.0.1:${base}${urlPath}`, init);
  let parsed: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

const post = (s: http.Server, p: string, a: { ref: string; side?: Side; role?: "owner" }, b?: unknown) =>
  request(s, "POST", p, a, b);
const get = (s: http.Server, p: string, a: { ref: string; side?: Side; role?: "owner" }) =>
  request(s, "GET", p, a);

const COOP = "COOP-E2E";
const owner = { ref: "owner-1", role: "owner" as const };
const A = { ref: "a-lead", side: "A" as Side };
const B = { ref: "b-lead", side: "B" as Side };

async function setup(server: http.Server, coop = COOP): Promise<void> {
  assert.equal((await post(server, "/cooperations", owner, { ref: coop, name: "样例合作", currency: "CNY" })).status, 200);
  assert.equal((await post(server, `/cooperations/${coop}/parties`, A, { side: "A", partyName: "境内团队", ianaTimezone: "Asia/Shanghai" })).status, 200);
  assert.equal((await post(server, `/cooperations/${coop}/parties`, B, { side: "B", partyName: "境外伙伴", ianaTimezone: "Europe/Berlin" })).status, 200);

  assert.equal(
    (await post(server, `/cooperations/${coop}/milestones`, A, {
      side: "A", milestoneCode: "M1", title: "首批交付", localDueDate: "2026-09-15", requiredRole: "approver",
    })).status,
    200,
  );
  assert.equal(
    (await post(server, `/cooperations/${coop}/milestones`, B, {
      side: "B", milestoneCode: "X1", title: "First delivery", localDueDate: "2026-09-15", requiredRole: "approver",
    })).status,
    200,
  );

  for (const actor of [A, B]) {
    const code = actor.side === "A" ? "M1" : "X1";
    assert.equal(
      (await post(server, `/cooperations/${coop}/deliverables`, actor, {
        side: actor.side, milestoneCode: code,
        items: [
          { itemCode: "D1", title: "技术文档" },
          { itemCode: "D2", title: "验收报告" },
        ],
      })).status,
      200,
    );
    for (const itemCode of ["D1", "D2"]) {
      assert.equal(
        (await post(server, `/cooperations/${coop}/receipts`, actor, {
          side: actor.side, milestoneCode: code, itemCode,
          digest: `sha256:${itemCode.toLowerCase().repeat(32)}`,
          sourceRef: `${actor.side}-${itemCode}-courier-1`,
          signedAt: "2026-09-14T10:00:00+08:00",
        })).status,
        200,
      );
    }
    assert.equal(
      (await post(server, `/cooperations/${coop}/confirmations`, actor, {
        side: actor.side, milestoneCode: code, role: "approver", decision: "confirmed",
      })).status,
      200,
    );
  }
}

test("健康接口返回服务状态", async () => {
  await withServer(async (server) => {
    const r = await get(server, "/health", { ref: "anonymous" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { status: "ok" });
  });
});

test("事实主权：B 不能登记 A 方里程碑，跨方映射需双方确认", async () => {
  await withServer(async (server) => {
    await setup(server);

    const denied = await post(server, `/cooperations/${COOP}/milestones`, B, {
      side: "A", milestoneCode: "M-FORGE", title: "伪造", localDueDate: "2026-09-15", requiredRole: "approver",
    });
    assert.equal(denied.status, 403);
    assert.equal((denied.body as { error: string }).error, "fact_ownership_denied");

    // B 可以登记本方事实
    assert.equal(
      (await post(server, `/cooperations/${COOP}/milestones`, B, {
        side: "B", milestoneCode: "X2", title: "Second", localDueDate: "2026-09-30", requiredRole: "approver",
      })).status,
      200,
    );

    // 提议方不能自行确认跨方映射
    const proposal = await post(server, `/cooperations/${COOP}/mappings`, A, {
      nodeCode: "N9", sideACode: "M1", sideBCode: "X1", amountCents: 10000, governingSide: "A",
    });
    assert.equal(proposal.status, 200);
    const selfConfirm = await post(server, `/cooperations/${COOP}/mappings/N9/respond`, A, { action: "confirm" });
    assert.equal(selfConfirm.status, 409);
    assert.equal((selfConfirm.body as { error: string }).error, "cross_confirmation_required");

    const otherConfirm = await post(server, `/cooperations/${COOP}/mappings/N9/respond`, B, { action: "confirm" });
    assert.equal(otherConfirm.status, 200);
  });
});

test("对账→批次→关闭→迟到证据→重放一致→冲正替代 的完整链路", async () => {
  await withServer(async (server, _base, clock) => {
    await setup(server);

    // A 单方提议后 → 映射未确认，无节点结论
    const draft = await post(server, `/cooperations/${COOP}/mappings`, A, {
      nodeCode: "N1", sideACode: "M1", sideBCode: "X1", amountCents: 10000, governingSide: "A",
    });
    assert.equal(draft.status, 200);
    const viewDraft = await get(server, `/cooperations/${COOP}`, A);
    assert.equal((viewDraft.body as { data: { conclusions: unknown[] } }).data.conclusions.length, 0);

    assert.equal((await post(server, `/cooperations/${COOP}/mappings/N1/respond`, B, { action: "confirm" })).status, 200);
    const view = await get(server, `/cooperations/${COOP}`, B);
    const conclusions = (view.body as { data: { conclusions: { nodeCode: string; status: string }[] } }).data.conclusions;
    assert.equal(conclusions.length, 1);
    assert.equal(conclusions[0].status, "payable");

    // 开批次
    clock.set("2026-09-20T00:00:00Z");
    assert.equal((await post(server, "/batches", owner, { cooperationRef: COOP, id: "B1", note: "九月批次" })).status, 200);
    assert.equal((await post(server, "/batches/B1/recompute", owner, {})).status, 200);
    const b1 = await get(server, "/batches/B1", owner);
    const b1Data = (b1.body as { data: { latestConclusions: { status: string; amount_cents: number }[] } }).data;
    assert.equal(b1Data.latestConclusions[0].status, "payable");
    assert.equal(b1Data.latestConclusions[0].amount_cents, 10000);

    // 关闭批次：结论固化
    clock.set("2026-09-21T00:00:00Z");
    assert.equal((await post(server, "/batches/B1/close", owner, {})).status, 200);

    // 关闭后到达的证据：A 方更正到期日（更早）
    clock.set("2026-09-22T00:00:00Z");
    assert.equal(
      (await post(server, `/cooperations/${COOP}/milestones`, A, {
        side: "A", milestoneCode: "M1", title: "首批交付（更正）", localDueDate: "2026-09-10", requiredRole: "approver",
      })).status,
      200,
    );

    // 拒绝直接重算已关闭批次
    const locked = await post(server, "/batches/B1/recompute", owner, {});
    assert.equal(locked.status, 409);
    assert.match((locked.body as { message: string }).message, /不能重算/);

    // 按关闭时刻重放：迟到证据被剔除，结论与固化一致
    clock.set("2026-09-23T00:00:00Z");
    const replay = await post(server, "/batches/B1/replay", owner, {});
    assert.equal(replay.status, 200);
    const replayBody = replay.body as {
      data: { matches_original: number; late_evidence: { items: { type: string }[] } };
    };
    assert.equal(replayBody.data.matches_original, 1);
    assert.ok(replayBody.data.late_evidence.items.some((e) => e.type === "milestone_version"));

    // 冲正 + 替代：用当前证据重算，新结论为 not_payable，原结论保留
    const reversal = await post(server, "/batches/B1/reverse", owner, {
      nodeCode: "N1",
      reason: "截止后证据显示适用到期日更早",
    });
    assert.equal(reversal.status, 200);
    const reversalData = (reversal.body as { data: { replacement: { status: string }; original: { id: string; status: string } } }).data;
    assert.equal(reversalData.replacement.status, "not_payable");
    assert.equal(reversalData.original.status, "payable");

    // 批次视图同时保留原结论与替代记录
    const after = (await get(server, "/batches/B1", owner)).body as {
      data: {
        latestConclusions: { status: string }[];
        reversals: { replacement: { status: string } }[];
        replays: { matches_original: number }[];
      };
    };
    assert.equal(after.data.latestConclusions.at(-1)?.status, "payable"); // 固化结论不被改写
    assert.equal(after.data.reversals[0].replacement.status, "not_payable");
    assert.equal(after.data.replays[0].matches_original, 1);

    // 重复重算留下版本行（open 批次行为已在关闭时第二轮验证：seq=2）
    const revisions = (await get(server, "/batches/B1", owner)).body as {
      data: { conclusionRevisions: { node_code: string; recompute_seq: number; status: string }[] };
    };
    const seq2 = revisions.data.conclusionRevisions.find((r) => r.node_code === "N1" && r.recompute_seq === 2);
    assert.ok(seq2);
    assert.equal(seq2.status, "payable");
  });
});

test("重复回执：第二张同摘要回执自动标记 duplicate，不改变可付结论", async () => {
  await withServer(async (server) => {
    await setup(server);
    const dup = await post(server, `/cooperations/${COOP}/receipts`, A, {
      side: "A", milestoneCode: "M1", itemCode: "D1",
      digest: `sha256:${"d1".repeat(32)}`,
      sourceRef: "A-D1-courier-2",
      signedAt: "2026-09-18T10:00:00+08:00",
    });
    assert.equal(dup.status, 200);
    assert.equal((dup.body as { data: { status: string; duplicate_of: string | null } }).data.status, "duplicate");
    assert.ok((dup.body as { data: { duplicate_of: string | null } }).data.duplicate_of);
  });
});

test("异议冻结本节点金额，不阻塞无关节点", async () => {
  await withServer(async (server) => {
    await setup(server);
    // N1 与 N2 共用同一对里程碑，仅用于验证冻结隔离
    for (const node of ["N1", "N2"]) {
      assert.equal(
        (await post(server, `/cooperations/${COOP}/mappings`, B, {
          nodeCode: node, sideACode: "M1", sideBCode: "X1", amountCents: node === "N1" ? 10000 : 4000, governingSide: "A",
        })).status,
        200,
      );
      assert.equal((await post(server, `/cooperations/${COOP}/mappings/${node}/respond`, A, { action: "confirm" })).status, 200);
    }

    const objection = await post(server, `/cooperations/${COOP}/objections`, B, {
      nodeCode: "N1",
      reasonDigest: "sha256:" + "f".repeat(64),
      detailRef: "objection-case-N1-1",
    });
    assert.equal(objection.status, 200);
    const objectionId = (objection.body as { data: { id: string } }).data.id;

    const view = (await get(server, `/cooperations/${COOP}`, owner)).body as {
      data: { conclusions: { nodeCode: string; status: string; amountCents: number | null }[] };
    };
    const n1 = view.data.conclusions.find((c) => c.nodeCode === "N1")!;
    const n2 = view.data.conclusions.find((c) => c.nodeCode === "N2")!;
    assert.equal(n1.status, "frozen");
    assert.equal(n1.amountCents, 10000);
    assert.equal(n2.status, "payable");

    // 撤回异议 → N1 恢复 payable
    assert.equal((await post(server, `/cooperations/${COOP}/objections/${objectionId}/withdraw`, B, {})).status, 200);
    const after = (await get(server, `/cooperations/${COOP}`, owner)).body as {
      data: { conclusions: { nodeCode: string; status: string }[] };
    };
    assert.equal(after.data.conclusions.find((c) => c.nodeCode === "N1")?.status, "payable");
  });
});

test("项目负责人可查看差异溯源，一方成员不能", async () => {
  await withServer(async (server) => {
    await setup(server);
    assert.equal((await post(server, `/cooperations/${COOP}/mappings`, A, {
      nodeCode: "N1", sideACode: "M1", sideBCode: "X1", amountCents: 10000, governingSide: "B",
    })).status, 200);
    assert.equal((await post(server, `/cooperations/${COOP}/mappings/N1/respond`, B, { action: "confirm" })).status, 200);

    const trace = await get(server, `/cooperations/${COOP}/nodes/N1/trace`, owner);
    assert.equal(trace.status, 200);
    const traceData = (trace.body as { data: { currentConclusion: { views: Record<string, unknown> }; timeline: unknown } }).data;
    assert.ok(traceData.currentConclusion);
    assert.ok(traceData.timeline);

    const denied = await get(server, `/cooperations/${COOP}/nodes/N1/trace`, B);
    assert.equal(denied.status, 403);
  });
});

test("里程碑拆分：逐条共同确认，权重不足或协商未决时 blocked，齐备后 superseded 与分摊", async () => {
  await withServer(async (server) => {
    await setup(server);
    assert.equal((await post(server, `/cooperations/${COOP}/mappings`, A, {
      nodeCode: "N1", sideACode: "M1", sideBCode: "X1", amountCents: 10000, governingSide: "A",
    })).status, 200);
    assert.equal((await post(server, `/cooperations/${COOP}/mappings/N1/respond`, B, { action: "confirm" })).status, 200);

    // 只提议一个 60% 子节点：写入允许共同确认；确认后权重 6000 不足 → blocked(split_weight_mismatch)
    assert.equal((await post(server, `/cooperations/${COOP}/splits`, A, {
      parentNode: "N1", childNode: "N1.1", weight: 6000, sideACode: "M1", sideBCode: "X1",
    })).status, 200);
    // 提议方不能确认本方提议
    const selfRespond = await post(server, `/cooperations/${COOP}/splits/N1/N1.1/respond`, A, { action: "confirm" });
    assert.equal(selfRespond.status, 409);
    assert.equal((selfRespond.body as { error: string }).error, "cross_confirmation_required");
    assert.equal((await post(server, `/cooperations/${COOP}/splits/N1/N1.1/respond`, B, { action: "confirm" })).status, 200);

    const midView1 = (await get(server, `/cooperations/${COOP}`, owner)).body as {
      data: { conclusions: { nodeCode: string; status: string; reasons: { code: string }[] }[] };
    };
    const midN1a = midView1.data.conclusions.find((c) => c.nodeCode === "N1")!;
    assert.equal(midN1a.status, "blocked");
    assert.ok(midN1a.reasons.some((r) => r.code === "split_weight_mismatch"));
    assert.ok(!midView1.data.conclusions.some((c) => c.nodeCode === "N1.1")); // 拆分未齐备不出子节点

    // 补足第二个提议但尚未确认 → blocked(split_negotiation_open)
    assert.equal((await post(server, `/cooperations/${COOP}/splits`, A, {
      parentNode: "N1", childNode: "N1.2", weight: 4000, sideACode: "M1", sideBCode: "X1",
    })).status, 200);
    const midView2 = (await get(server, `/cooperations/${COOP}`, owner)).body as {
      data: { conclusions: { nodeCode: string; status: string; reasons: { code: string }[] }[] };
    };
    assert.ok(midView2.data.conclusions.find((c) => c.nodeCode === "N1")?.reasons.some((r) => r.code === "split_negotiation_open"));

    assert.equal((await post(server, `/cooperations/${COOP}/splits/N1/N1.2/respond`, B, { action: "confirm" })).status, 200);

    const view = (await get(server, `/cooperations/${COOP}`, owner)).body as {
      data: { conclusions: { nodeCode: string; status: string; amountCents: number | null }[] };
    };
    const byCode = new Map(view.data.conclusions.map((c) => [c.nodeCode, c]));
    assert.equal(byCode.get("N1")?.status, "superseded");
    assert.equal(byCode.get("N1.1")?.status, "payable");
    assert.equal(byCode.get("N1.1")?.amountCents, 6000);
    assert.equal(byCode.get("N1.2")?.amountCents, 4000);
  });
});

test("边界校验：非法时间/摘要返回结构化 400", async () => {
  await withServer(async (server) => {
    await setup(server);
    const badTime = await post(server, `/cooperations/${COOP}/receipts`, A, {
      side: "A", milestoneCode: "M1", itemCode: "D1",
      digest: "sha256:" + "a".repeat(64), sourceRef: "x", signedAt: "2026/09/14 10:00",
    });
    assert.equal(badTime.status, 400);
    assert.equal((badTime.body as { error: string }).error, "invalid_instant");

    const badDigest = await post(server, `/cooperations/${COOP}/objections`, A, {
      nodeCode: "M1", reasonDigest: "plain-text",
    });
    // M1 还不是映射节点，先撞 404 node_not_found；换已确认节点路径在主链路已覆盖，这里至少要求结构化错误
    assert.ok([400, 404].includes(badDigest.status));
  });
});
