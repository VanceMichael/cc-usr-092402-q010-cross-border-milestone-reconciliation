// 调用身份（无外部身份提供方，用请求头模拟）：
//   x-actor-ref   操作者引用编号（必填）
//   x-actor-side  A / B：一方成员，只能写本方事实
//   x-actor-role  owner：项目负责人，可查看差异、开关批次、冲正与重放
import type { Side } from "./domain/time.js";
import { forbidden, badRequest } from "./errors.js";

export type ActorRole = "party" | "owner";

export interface Actor {
  ref: string;
  side: Side | null;
  role: ActorRole;
}

export function actorFromHeaders(headers: Record<string, string | undefined>): Actor {
  const ref = headers["x-actor-ref"]?.trim();
  if (!ref) throw badRequest("actor_required", "缺少请求头 x-actor-ref");
  const rawSide = headers["x-actor-side"]?.trim().toUpperCase();
  const rawRole = headers["x-actor-role"]?.trim().toLowerCase();

  if (rawRole === "owner") {
    return { ref, side: null, role: "owner" };
  }
  if (rawSide === "A" || rawSide === "B") {
    return { ref, side: rawSide, role: "party" };
  }
  throw badRequest("actor_invalid", "需提供 x-actor-side=A|B 或 x-actor-role=owner");
}

export function requireParty(actor: Actor, side: Side): void {
  if (actor.role !== "party" || actor.side !== side) {
    throw forbidden("fact_ownership_denied", `该事实只能由 ${side} 方登记或更正`, {
      actor: actor.ref,
      requiredSide: side,
    });
  }
}

export function requireOwner(actor: Actor): void {
  if (actor.role !== "owner") {
    throw forbidden("owner_only", "该操作仅限项目负责人", { actor: actor.ref });
  }
}
