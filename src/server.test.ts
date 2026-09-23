
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "./server.js";

test("健康接口返回服务状态", async () => {
  process.env.NODE_ENV = "test";
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
