// 证据对账时点快照类型。
// store 层负责按 asOf(T) 从 append-only 事实表取出“当时的最新版本”，规则引擎只消费快照，
// 因此同一份快照 + 同一规则版本必然得到同一结论（可重放）。

import type { DayKind, Side } from "./time.js";

export type ConclusionStatus = "payable" | "not_payable" | "blocked" | "frozen" | "superseded";
export type MappingStatus = "proposed" | "confirmed" | "rejected";
export type SplitStatus = MappingStatus;

export interface MilestoneFact {
  versionId: string;
  seq: number;
  side: Side;
  milestoneCode: string;
  title: string;
  localDueDate: string;
  dependencies: string[]; // 限定码 "A:M1"
  requiredRole: string;
  holidayPolicy: "as_is" | "next_workday";
  recordedAt: number;
}

export interface DeliverableItem {
  itemCode: string;
  title: string;
}

export interface DeliverableFact {
  versionId: string;
  version: number;
  side: Side;
  milestoneCode: string;
  items: DeliverableItem[];
  recordedAt: number;
}

export interface ReceiptFact {
  id: string;
  side: Side;
  milestoneCode: string;
  itemCode: string | null;
  digest: string;
  sourceRef: string;
  signedAt: number;
  receivedAt: number;
  status: "accepted" | "duplicate";
  duplicateOf: string | null;
  recordedAt: number;
}

export interface ConfirmationFact {
  id: string;
  side: Side;
  milestoneCode: string;
  role: string;
  actorRef: string;
  decision: "confirmed" | "rejected";
  note: string | null;
  recordedAt: number;
}

export interface MappingFact {
  id: string; // 最新一次 propose 事件的 id
  nodeCode: string;
  sideACode: string;
  sideBCode: string;
  amountCents: number;
  governingSide: Side;
  proposedBy: Side;
  proposedAt: number;
  status: MappingStatus;
  respondedBy: Side | null;
  respondedAt: number | null;
  events: { id: string; action: "propose" | "confirm" | "reject"; actorSide: Side; eventAt: number; recordedAt: number }[];
}

export interface SplitFact {
  id: string; // 最新一次 propose 事件的 id
  parentNode: string;
  childNode: string;
  weight: number; // 基点，10000=100%
  sideACode: string;
  sideBCode: string;
  proposedBy: Side;
  proposedAt: number;
  status: SplitStatus;
  respondedBy: Side | null;
  respondedAt: number | null;
}

export interface ObjectionFact {
  id: string; // open 事件 id
  nodeCode: string;
  side: Side;
  reasonDigest: string;
  detailRef: string | null;
  status: "open" | "withdrawn";
  openedAt: number;
  withdrawnAt: number | null;
}

export interface CalendarSnapshot {
  side: Side;
  ianaTimezone: string;
  weekendDays: number[];
  overrides: Record<string, DayKind>;
}

export interface Snapshot {
  cooperationRef: string;
  asOf: number;
  calendars: Record<Side, CalendarSnapshot | null>;
  milestones: MilestoneFact[];
  deliverables: DeliverableFact[];
  receipts: ReceiptFact[];
  confirmations: ConfirmationFact[];
  mappings: MappingFact[];
  splits: SplitFact[];
  objections: ObjectionFact[];
}
