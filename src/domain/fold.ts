// 事件流折叠：把 append-only 的 propose/confirm/reject 与 open/withdraw 事件
// 折叠为 asOf(T) 时点的状态。折叠只依赖事件内容，因此结果确定、可重放。
//
// 语义约定：
//  - 事件按 (event_at, rowid 序号) 全序排列，同毫秒内先插入者在先；recorded_at 仅用于迟到证据剔除（store 先按 recorded_at<=T 过滤）；
//  - 新的 propose 会携带新的金额/编码/权重，重置此前的 confirm/reject；
//  - confirm/reject 必须由非提议方发出，且只能作用于当前最新 propose（store 层做状态冲突校验）。

import type { MappingFact, ObjectionFact, SplitFact } from "./types.js";
import type { Side } from "./time.js";

export interface RawMappingEvent {
  id: string;
  seq: number; // 插入全序（rowid），event_at 相同时以此为准
  nodeCode: string;
  action: "propose" | "confirm" | "reject";
  sideACode: string;
  sideBCode: string;
  amountCents: number;
  governingSide: Side;
  actorSide: Side;
  eventAt: number;
  recordedAt: number;
}

export interface RawSplitEvent {
  id: string;
  seq: number;
  parentNode: string;
  childNode: string;
  weight: number;
  sideACode: string;
  sideBCode: string;
  action: "propose" | "confirm" | "reject";
  actorSide: Side;
  eventAt: number;
  recordedAt: number;
}

export interface RawObjectionEvent {
  id: string;
  seq: number;
  nodeCode: string;
  action: "open" | "withdraw";
  openObjectionId: string | null;
  side: Side;
  reasonDigest: string | null;
  detailRef: string | null;
  eventAt: number;
  recordedAt: number;
}

function ordered<T>(rows: T[], pickAt: (r: T) => number, pickSeq: (r: T) => number): T[] {
  return [...rows].sort((a, b) => pickAt(a) - pickAt(b) || pickSeq(a) - pickSeq(b));
}

export function foldMappings(events: RawMappingEvent[]): MappingFact[] {
  const groups = new Map<string, RawMappingEvent[]>();
  for (const e of events) {
    const list = groups.get(e.nodeCode) ?? [];
    list.push(e);
    groups.set(e.nodeCode, list);
  }
  const facts: MappingFact[] = [];
  for (const [nodeCode, list] of groups) {
    let current: MappingFact | null = null;
    for (const e of ordered(list, (x) => x.eventAt, (x) => x.seq)) {
      if (e.action === "propose") {
        current = {
          id: e.id,
          nodeCode,
          sideACode: e.sideACode,
          sideBCode: e.sideBCode,
          amountCents: e.amountCents,
          governingSide: e.governingSide,
          proposedBy: e.actorSide,
          proposedAt: e.eventAt,
          status: "proposed",
          respondedBy: null,
          respondedAt: null,
          events: [],
        };
      } else {
        if (current !== null) {
          const base: MappingFact = current;
          current = {
            ...base,
            status: e.action === "confirm" ? "confirmed" : "rejected",
            respondedBy: e.actorSide,
            respondedAt: e.eventAt,
          };
        }
      }
    }
    if (current) {
      current.events = ordered(list, (x) => x.eventAt, (x) => x.seq).map((e) => ({
        id: e.id,
        action: e.action,
        actorSide: e.actorSide,
        eventAt: e.eventAt,
        recordedAt: e.recordedAt,
      }));
      facts.push(current);
    }
  }
  return facts;
}

export function foldSplits(events: RawSplitEvent[]): SplitFact[] {
  const groups = new Map<string, RawSplitEvent[]>();
  for (const e of events) {
    const key = `${e.parentNode}→${e.childNode}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const facts: SplitFact[] = [];
  for (const list of groups) {
    let current: SplitFact | null = null;
    for (const e of ordered(list[1], (x) => x.eventAt, (x) => x.seq)) {
      if (e.action === "propose") {
        current = {
          id: e.id,
          parentNode: e.parentNode,
          childNode: e.childNode,
          weight: e.weight,
          sideACode: e.sideACode,
          sideBCode: e.sideBCode,
          proposedBy: e.actorSide,
          proposedAt: e.eventAt,
          status: "proposed",
          respondedBy: null,
          respondedAt: null,
        };
      } else {
        if (current !== null) {
          const base: SplitFact = current;
          current = {
            ...base,
            status: e.action === "confirm" ? "confirmed" : "rejected",
            respondedBy: e.actorSide,
            respondedAt: e.eventAt,
          };
        }
      }
    }
    if (current) facts.push(current);
  }
  return facts;
}

export function foldObjections(events: RawObjectionEvent[]): ObjectionFact[] {
  // 以 open 事件为单位分组：withdraw 事件带 open_objection_id
  const opens = new Map<string, ObjectionFact>();
  for (const e of ordered(events, (x) => x.eventAt, (x) => x.seq)) {
    if (e.action === "open") {
      opens.set(e.id, {
        id: e.id,
        nodeCode: e.nodeCode,
        side: e.side,
        reasonDigest: e.reasonDigest ?? "",
        detailRef: e.detailRef,
        status: "open",
        openedAt: e.eventAt,
        withdrawnAt: null,
      });
    } else if (e.action === "withdraw" && e.openObjectionId && opens.has(e.openObjectionId)) {
      const target = opens.get(e.openObjectionId)!;
      target.status = "withdrawn";
      target.withdrawnAt = e.eventAt;
    }
  }
  return [...opens.values()];
}
