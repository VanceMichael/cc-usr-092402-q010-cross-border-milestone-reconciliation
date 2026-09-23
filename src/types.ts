
// 数据库行类型：与 migrations/002 的表一一对应。

export interface PartyRow {
  party_code: string;
  side: "A" | "B";
  display_name: string;
  created_at: string;
}

export interface CooperationRow {
  cooperation_ref: string;
  home_party: string;
  partner_party: string;
  currency: string;
  status: string;
  created_by: string;
  created_at: string;
}

export interface CalendarRow {
  id: string;
  cooperation_ref: string;
  party_code: string | null;
  calendar_code: string;
  iana_timezone: string;
  work_mon: number;
  work_tue: number;
  work_wed: number;
  work_thu: number;
  work_fri: number;
  work_sat: number;
  work_sun: number;
  valid_from_date: string;
  valid_to_date: string | null;
  created_by: string;
  created_at: string;
}

export interface HolidayRow {
  id: string;
  calendar_id: string;
  holiday_date: string;
  name: string;
  workday_override: number;
  created_at: string;
}

export interface MilestoneVersionRow {
  id: string;
  cooperation_ref: string;
  side: "A" | "B";
  milestone_code: string;
  revision: number;
  version_kind: "initial" | "revision" | "split";
  parent_version_id: string | null;
  title: string;
  planned_date: string;
  amount: number;
  weight: number | null;
  calendar_id: string;
  required_roles: string; // JSON 数组
  recorded_by: string;
  recorded_at: string;
}

export interface MappingRow {
  id: string;
  cooperation_ref: string;
  side_a_version_id: string;
  side_b_version_id: string;
  relation: "equivalent" | "split";
  note: string | null;
  created_by: string;
  created_at: string;
  voided_at: string | null;
}

export interface MappingConfirmationRow {
  id: string;
  mapping_id: string;
  party_code: string;
  confirmed_at: string;
}

export interface DependencyRow {
  id: string;
  cooperation_ref: string;
  version_id: string;
  depends_on_version_id: string;
  kind: string;
  created_by: string;
  created_at: string;
}

export interface DeliveryItemRow {
  id: string;
  version_id: string;
  item_code: string;
  title: string;
  required_qty: number;
  recorded_by: string;
  recorded_at: string;
}

export interface DeliveryEventRow {
  id: string;
  item_id: string;
  evidence_digest: string;
  local_ref: string | null;
  delivered_at: string;
  qty: number;
  duplicate_of: string | null;
  recorded_by: string;
  recorded_at: string;
  withdrawn?: boolean;
}

export interface ReceiptRow {
  id: string;
  version_id: string;
  receipt_no: string;
  evidence_digest: string;
  local_ref: string | null;
  signed_at: string;
  receiving_party: string;
  duplicate_of: string | null;
  recorded_by: string;
  recorded_at: string;
  withdrawn?: boolean;
}

export interface FactCorrectionRow {
  id: string;
  fact_table: "delivery_events" | "receipts" | "delivery_items";
  fact_id: string;
  kind: "withdraw";
  reason: string | null;
  recorded_by: string;
  recorded_at: string;
}

export interface DisputeRow {
  id: string;
  cooperation_ref: string;
  subject_version_id: string | null;
  mapping_id: string | null;
  reason: string;
  evidence_digest: string | null;
  local_ref: string | null;
  raised_by: string;
  raised_at: string;
  recorded_at: string;
  status: "open" | "withdrawn" | "resolved";
  resolved_at: string | null;
  resolution_note: string | null;
}

export interface ConclusionRow {
  id: string;
  cooperation_ref: string;
  version_id: string;
  rule_version: string;
  gates_met: number;
  is_overdue: number;
  payment_eligible: number;
  payment_amount: number;
  details_json: string;
  inputs_json: string;
  basis_hash: string;
  supersedes_conclusion_id: string | null;
  split_parent_conclusion_id: string | null;
  created_by: string;
  created_at: string;
}

export interface ConclusionConfirmationRow {
  id: string;
  conclusion_id: string;
  role: string;
  party_code: string;
  confirmed_at: string;
}

export interface ReversalRow {
  id: string;
  cooperation_ref: string;
  original_conclusion_id: string;
  replacement_conclusion_id: string | null;
  reason_code: string;
  reason: string;
  evidence_digest: string | null;
  net_amount: number | null;
  status: "proposed" | "accepted" | "rejected";
  raised_by: string;
  created_at: string;
  decided_at: string | null;
}

export interface DisputeFreezeRow {
  id: string;
  dispute_id: string;
  cooperation_ref: string;
  version_id: string;
  amount: number;
  status: "frozen" | "released";
  created_at: string;
  released_at: string | null;
}

export interface SettlementBatchRow {
  id: string;
  cooperation_ref: string;
  batch_no: string;
  rule_version: string;
  status: "open" | "closed";
  cutoff_at: string;
  closed_at: string | null;
  created_by: string;
  created_at: string;
}

export interface SettlementEntryRow {
  id: string;
  batch_id: string;
  version_id: string;
  conclusion_id: string;
  amount: number;
  basis_hash: string;
  status: "included" | "reversed";
  reversal_id: string | null;
  included_at: string;
}

export interface AuditEventRow {
  id: string;
  cooperation_ref: string | null;
  actor_party: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  payload_json: string | null;
  occurred_at: string;
}
