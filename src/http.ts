// HTTP 边界：JSON 解析、身份头解析、路由与结构化错误响应。
// 业务规则全部在 store/domain 内，本文件不做业务判定。

import type http from "node:http";
import type { AddressInfo } from "node:net";
import { DomainError } from "./errors.js";
import { actorFromHeaders } from "./auth.js";
import type { Store } from "./store.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: HandlerContext) => Promise<unknown> | unknown;
}

interface HandlerContext {
  req: http.IncomingMessage;
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
  store: Store;
}

function json(status: number, payload: unknown, res: http.ServerResponse): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new DomainError(413, "body_too_large", "请求体超过 1 MiB 限制"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError(400, "invalid_json", "请求体必须为合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createRouter(store: Store): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const routes: Route[] = [
    { method: "POST", pattern: /^\/cooperations$/, handler: (c) => store.createCooperation(actorFromHeaders(headerMap(c.req)), asObject(c.body)) },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/parties$/,
      handler: (c) => store.registerParty(actorFromHeaders(headerMap(c.req)), asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/calendar-days$/,
      handler: (c) => store.upsertCalendarDay(actorFromHeaders(headerMap(c.req)), asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/milestones$/,
      handler: (c) => store.recordMilestone(actorFromHeaders(headerMap(c.req)), c.params.ref!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/deliverables$/,
      handler: (c) => store.recordDeliverables(actorFromHeaders(headerMap(c.req)), c.params.ref!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/receipts$/,
      handler: (c) => store.recordReceipt(actorFromHeaders(headerMap(c.req)), c.params.ref!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/confirmations$/,
      handler: (c) => store.recordConfirmation(actorFromHeaders(headerMap(c.req)), c.params.ref!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/mappings$/,
      handler: (c) => store.proposeMapping(actorFromHeaders(headerMap(c.req)), c.params.ref!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/mappings\/(?<node>[^/]+)\/respond$/,
      handler: (c) => store.respondMapping(actorFromHeaders(headerMap(c.req)), c.params.ref!, c.params.node!, actionOf(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/splits$/,
      handler: (c) => store.proposeSplit(actorFromHeaders(headerMap(c.req)), c.params.ref!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/splits\/(?<parent>[^/]+)\/(?<child>[^/]+)\/respond$/,
      handler: (c) =>
        store.respondSplit(actorFromHeaders(headerMap(c.req)), c.params.ref!, c.params.parent!, c.params.child!, actionOf(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/objections$/,
      handler: (c) => store.openObjection(actorFromHeaders(headerMap(c.req)), c.params.ref!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/objections\/(?<id>[^/]+)\/withdraw$/,
      handler: (c) => store.withdrawObjection(actorFromHeaders(headerMap(c.req)), c.params.ref!, c.params.id!),
    },
    {
      method: "GET",
      pattern: /^\/cooperations\/(?<ref>[^/]+)\/nodes\/(?<node>[^/]+)\/trace$/,
      handler: (c) => store.traceNode(actorFromHeaders(headerMap(c.req)), c.params.ref!, c.params.node!),
    },
    {
      method: "GET",
      pattern: /^\/cooperations\/(?<ref>[^/]+)$/,
      handler: (c) => store.cooperationView(actorFromHeaders(headerMap(c.req)), c.params.ref!, c.query.get("asOf") ?? undefined),
    },
    { method: "POST", pattern: /^\/batches$/, handler: (c) => store.openBatch(actorFromHeaders(headerMap(c.req)), asObject(c.body)) },
    {
      method: "POST",
      pattern: /^\/batches\/(?<id>[^/]+)\/recompute$/,
      handler: (c) => store.recomputeBatch(actorFromHeaders(headerMap(c.req)), c.params.id!),
    },
    {
      method: "POST",
      pattern: /^\/batches\/(?<id>[^/]+)\/close$/,
      handler: (c) => store.closeBatch(actorFromHeaders(headerMap(c.req)), c.params.id!),
    },
    {
      method: "POST",
      pattern: /^\/batches\/(?<id>[^/]+)\/reverse$/,
      handler: (c) => store.reverseConclusion(actorFromHeaders(headerMap(c.req)), c.params.id!, asObject(c.body)),
    },
    {
      method: "POST",
      pattern: /^\/batches\/(?<id>[^/]+)\/replay$/,
      handler: (c) => store.replayBatch(actorFromHeaders(headerMap(c.req)), c.params.id!),
    },
    { method: "GET", pattern: /^\/batches\/(?<id>[^/]+)$/, handler: (c) => store.getBatch(actorFromHeaders(headerMap(c.req)), c.params.id!) },
  ];

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === "/health") {
        json(200, { status: "ok" }, res);
        return;
      }
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) {
        json(404, { error: "not_found", message: `没有匹配的路由：${req.method} ${url.pathname}` }, res);
        return;
      }
      const match = route.pattern.exec(url.pathname)!;
      const body = req.method === "GET" ? {} : await readBody(req);
      const result = await route.handler({
        req: req,
        body,
        params: (match.groups ?? {}) as Record<string, string>,
        query: url.searchParams,
        store,
      });
      json(200, { data: result }, res);
    } catch (error) {
      if (error instanceof DomainError) {
        json(error.status, { error: error.code, message: error.message, details: error.details ?? null }, res);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      json(500, { error: "internal_error", message }, res);
    }
  };
}

function headerMap(req: http.IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  return headers;
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError(400, "invalid_body", "请求体必须为 JSON 对象");
  }
  return body as Record<string, unknown>;
}

function actionOf(body: unknown): "confirm" | "reject" {
  const action = asObject(body).action;
  if (action !== "confirm" && action !== "reject") {
    throw new DomainError(400, "invalid_action", "action 必须为 confirm 或 reject");
  }
  return action;
}

export type { AddressInfo };
