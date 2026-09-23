-- 002 证据对账：双方里程碑版本、跨方映射、依赖、时区日历、
-- 交付清单、签收回执、异议、结论、冲正、结算批次与审计事件。
-- 约定：业务记录追加优先；更正以 fact_corrections 追加表达；
-- 结论（conclusions）一经形成不可改写，变更只能通过冲正+替代记录。

PRAGMA foreign_keys = ON;

-- 参与方：A=境内团队，B=境外伙伴
CREATE TABLE parties (
    party_code   TEXT PRIMARY KEY,
    side         TEXT NOT NULL UNIQUE CHECK (side IN ('A', 'B')),
    display_name TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE cooperations (
    cooperation_ref TEXT PRIMARY KEY,
    home_party      TEXT NOT NULL REFERENCES parties(party_code),
    partner_party   TEXT NOT NULL REFERENCES parties(party_code),
    currency        TEXT NOT NULL DEFAULT 'CNY',
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    CHECK (home_party <> partner_party)
);

-- 工作日历：可归属一方，也可属于合作级（party_code 为空）
CREATE TABLE calendars (
    id              TEXT PRIMARY KEY,
    cooperation_ref TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    party_code      TEXT REFERENCES parties(party_code),
    calendar_code   TEXT NOT NULL,
    iana_timezone   TEXT NOT NULL,
    work_mon INTEGER NOT NULL DEFAULT 1 CHECK (work_mon IN (0, 1)),
    work_tue INTEGER NOT NULL DEFAULT 1 CHECK (work_tue IN (0, 1)),
    work_wed INTEGER NOT NULL DEFAULT 1 CHECK (work_wed IN (0, 1)),
    work_thu INTEGER NOT NULL DEFAULT 1 CHECK (work_thu IN (0, 1)),
    work_fri INTEGER NOT NULL DEFAULT 1 CHECK (work_fri IN (0, 1)),
    work_sat INTEGER NOT NULL DEFAULT 0 CHECK (work_sat IN (0, 1)),
    work_sun INTEGER NOT NULL DEFAULT 0 CHECK (work_sun IN (0, 1)),
    valid_from_date TEXT NOT NULL,
    valid_to_date   TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (cooperation_ref, calendar_code)
);

-- 假日与调休上班日：workday_override=1 表示该假日被调为工作日
CREATE TABLE calendar_holidays (
    id               TEXT PRIMARY KEY,
    calendar_id      TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    holiday_date     TEXT NOT NULL CHECK (holiday_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    name             TEXT NOT NULL,
    workday_override INTEGER NOT NULL DEFAULT 0 CHECK (workday_override IN (0, 1)),
    created_at       TEXT NOT NULL,
    UNIQUE (calendar_id, holiday_date)
);

-- 里程碑版本：追加写。revision 从 1 起；version_kind 标注初始/修订/拆分
CREATE TABLE milestone_versions (
    id                TEXT PRIMARY KEY,
    cooperation_ref   TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    side              TEXT NOT NULL CHECK (side IN ('A', 'B')),
    milestone_code    TEXT NOT NULL,
    revision          INTEGER NOT NULL CHECK (revision >= 1),
    version_kind      TEXT NOT NULL CHECK (version_kind IN ('initial', 'revision', 'split')),
    parent_version_id TEXT REFERENCES milestone_versions(id),
    title             TEXT NOT NULL,
    planned_date      TEXT NOT NULL, -- 约定日期，带偏移 ISO 8601
    amount            REAL NOT NULL DEFAULT 0 CHECK (amount >= 0),
    weight            REAL,          -- 拆分权重；同批子节点之和须为 1
    calendar_id       TEXT NOT NULL REFERENCES calendars(id),
    required_roles    TEXT NOT NULL DEFAULT '[]', -- 约定确认角色 JSON 数组
    recorded_by       TEXT NOT NULL,
    recorded_at       TEXT NOT NULL, -- 入库时刻：迟到证据判定锚点
    UNIQUE (cooperation_ref, side, milestone_code, revision)
);

-- 跨方映射：需双方各确认一次才生效（status 派生自确认数）
CREATE TABLE milestone_mappings (
    id              TEXT PRIMARY KEY,
    cooperation_ref TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    side_a_version_id TEXT NOT NULL REFERENCES milestone_versions(id),
    side_b_version_id TEXT NOT NULL REFERENCES milestone_versions(id),
    relation        TEXT NOT NULL CHECK (relation IN ('equivalent', 'split')),
    note            TEXT,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    voided_at       TEXT,
    UNIQUE (side_a_version_id, side_b_version_id)
);

CREATE TABLE mapping_confirmations (
    id          TEXT PRIMARY KEY,
    mapping_id  TEXT NOT NULL REFERENCES milestone_mappings(id) ON DELETE CASCADE,
    party_code  TEXT NOT NULL REFERENCES parties(party_code),
    confirmed_at TEXT NOT NULL,
    UNIQUE (mapping_id, party_code)
);

-- 依赖：finish_to_start 要求被依赖版本已达成可付款条件
CREATE TABLE milestone_dependencies (
    id                    TEXT PRIMARY KEY,
    cooperation_ref       TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    version_id            TEXT NOT NULL REFERENCES milestone_versions(id),
    depends_on_version_id TEXT NOT NULL REFERENCES milestone_versions(id),
    kind                  TEXT NOT NULL DEFAULT 'finish_to_start'
                              CHECK (kind IN ('finish_to_start')),
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (version_id, depends_on_version_id),
    CHECK (version_id <> depends_on_version_id)
);

-- 交付清单行（本方申报自己版本的应有交付物）
CREATE TABLE delivery_items (
    id           TEXT PRIMARY KEY,
    version_id   TEXT NOT NULL REFERENCES milestone_versions(id),
    item_code    TEXT NOT NULL,
    title        TEXT NOT NULL,
    required_qty REAL NOT NULL DEFAULT 1 CHECK (required_qty > 0),
    recorded_by  TEXT NOT NULL,
    recorded_at  TEXT NOT NULL,
    UNIQUE (version_id, item_code)
);

-- 交付事件：同一清单行同一摘要只计一次（R1 去重）
CREATE TABLE delivery_events (
    id            TEXT PRIMARY KEY,
    item_id       TEXT NOT NULL REFERENCES delivery_items(id),
    evidence_digest TEXT NOT NULL,
    local_ref     TEXT,
    delivered_at  TEXT NOT NULL, -- 声称交付时刻（带偏移）
    qty           REAL NOT NULL DEFAULT 1 CHECK (qty > 0),
    duplicate_of  TEXT REFERENCES delivery_events(id),
    recorded_by   TEXT NOT NULL,
    recorded_at   TEXT NOT NULL,
    UNIQUE (item_id, evidence_digest)
);

-- 签收回执：同一版本同一回执号只计一次（R1 去重）
CREATE TABLE receipts (
    id              TEXT PRIMARY KEY,
    version_id      TEXT NOT NULL REFERENCES milestone_versions(id),
    receipt_no      TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    local_ref       TEXT,
    signed_at       TEXT NOT NULL, -- 签收地时刻（带偏移）
    receiving_party TEXT NOT NULL REFERENCES parties(party_code),
    duplicate_of    TEXT REFERENCES receipts(id),
    recorded_by     TEXT NOT NULL,
    recorded_at     TEXT NOT NULL,
    UNIQUE (version_id, receipt_no)
);

-- 本方事实更正：追加写；kind='withdraw' 撤回本方证据/清单行
CREATE TABLE fact_corrections (
    id          TEXT PRIMARY KEY,
    fact_table  TEXT NOT NULL CHECK (fact_table IN ('delivery_events', 'receipts', 'delivery_items')),
    fact_id     TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('withdraw')),
    reason      TEXT,
    recorded_by TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE (fact_table, fact_id, kind)
);

-- 异议材料
CREATE TABLE disputes (
    id                TEXT PRIMARY KEY,
    cooperation_ref   TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    subject_version_id TEXT REFERENCES milestone_versions(id),
    mapping_id        TEXT REFERENCES milestone_mappings(id),
    reason            TEXT NOT NULL,
    evidence_digest   TEXT,
    local_ref         TEXT,
    raised_by         TEXT NOT NULL,
    raised_at         TEXT NOT NULL, -- 异议声称时刻
    recorded_at       TEXT NOT NULL, -- 入库时刻
    status            TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'withdrawn', 'resolved')),
    resolved_at       TEXT,
    resolution_note   TEXT,
    CHECK (subject_version_id IS NOT NULL OR mapping_id IS NOT NULL)
);

-- 结论：不可变快照。同一证据基（basis_hash）重算不产生新行
CREATE TABLE conclusions (
    id                TEXT PRIMARY KEY,
    cooperation_ref   TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    version_id        TEXT NOT NULL REFERENCES milestone_versions(id),
    rule_version      TEXT NOT NULL,
    gates_met         INTEGER NOT NULL CHECK (gates_met IN (0, 1)),
    is_overdue        INTEGER NOT NULL CHECK (is_overdue IN (0, 1)),
    payment_eligible  INTEGER NOT NULL CHECK (payment_eligible IN (0, 1)), -- 1=可付款（含已确认门）
    payment_amount    REAL NOT NULL DEFAULT 0,
    details_json      TEXT NOT NULL, -- 判定轨迹（双方各自口径与每条规则的命中）
    inputs_json       TEXT NOT NULL, -- 完整证据快照
    basis_hash        TEXT NOT NULL,
    supersedes_conclusion_id TEXT REFERENCES conclusions(id),
    split_parent_conclusion_id TEXT REFERENCES conclusions(id),
    created_by        TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    UNIQUE (version_id, basis_hash)
);

-- 结论的角色确认（约定角色齐备后才可付款）
CREATE TABLE conclusion_confirmations (
    id            TEXT PRIMARY KEY,
    conclusion_id TEXT NOT NULL REFERENCES conclusions(id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    party_code    TEXT NOT NULL REFERENCES parties(party_code),
    confirmed_at  TEXT NOT NULL,
    UNIQUE (conclusion_id, role)
);

-- 冲正：已进入付款的结论只能经冲正+替代记录变更（R7）
CREATE TABLE conclusion_reversals (
    id                        TEXT PRIMARY KEY,
    cooperation_ref           TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    original_conclusion_id    TEXT NOT NULL REFERENCES conclusions(id),
    replacement_conclusion_id TEXT REFERENCES conclusions(id),
    reason_code               TEXT NOT NULL CHECK (reason_code IN
                                  ('late_evidence', 'partial_delivery', 'split', 'duplicate_receipt',
                                   'holiday_correction', 'mapping_change', 'factual_error', 'other')),
    reason          TEXT NOT NULL,
    evidence_digest TEXT,
    net_amount      REAL,
    status          TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed', 'accepted', 'rejected')),
    raised_by       TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    decided_at      TEXT
);

-- 争议冻结金额：只冻结争议集群，无关节点照常结算（R6）
CREATE TABLE dispute_freezes (
    id              TEXT PRIMARY KEY,
    dispute_id      TEXT NOT NULL REFERENCES disputes(id),
    cooperation_ref TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    version_id      TEXT NOT NULL REFERENCES milestone_versions(id),
    amount          REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen', 'released')),
    created_at      TEXT NOT NULL,
    released_at     TEXT,
    UNIQUE (dispute_id, version_id)
);

-- 结算批次：关闭时固化规则版本与截止时刻，供按批次重放
CREATE TABLE settlement_batches (
    id              TEXT PRIMARY KEY,
    cooperation_ref TEXT NOT NULL REFERENCES cooperations(cooperation_ref),
    batch_no        TEXT NOT NULL UNIQUE,
    rule_version    TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    cutoff_at       TEXT NOT NULL, -- 纳入证据的截止时刻（关闭时刻）
    closed_at       TEXT,
    created_by      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);

CREATE TABLE settlement_entries (
    id            TEXT PRIMARY KEY,
    batch_id      TEXT NOT NULL REFERENCES settlement_batches(id),
    version_id    TEXT NOT NULL REFERENCES milestone_versions(id),
    conclusion_id TEXT NOT NULL REFERENCES conclusions(id),
    amount        REAL NOT NULL,
    basis_hash    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'included'
                      CHECK (status IN ('included', 'reversed')),
    reversal_id   TEXT REFERENCES conclusion_reversals(id),
    included_at   TEXT NOT NULL,
    UNIQUE (batch_id, version_id)
);

-- 审计事件：只追加
CREATE TABLE audit_events (
    id              TEXT PRIMARY KEY,
    cooperation_ref TEXT,
    actor_party     TEXT,
    action          TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    entity_id       TEXT,
    payload_json    TEXT,
    occurred_at     TEXT NOT NULL
);

-- 便捷视图：每个（合作、方、编号）的当前版本
CREATE VIEW v_current_milestone AS
SELECT mv.*
FROM milestone_versions mv
JOIN (
    SELECT cooperation_ref, side, milestone_code, MAX(revision) AS max_revision
    FROM milestone_versions
    GROUP BY cooperation_ref, side, milestone_code
) cur
  ON cur.cooperation_ref = mv.cooperation_ref
 AND cur.side = mv.side
 AND cur.milestone_code = mv.milestone_code
 AND cur.max_revision = mv.revision;

CREATE INDEX idx_mv_coop ON milestone_versions(cooperation_ref);
CREATE INDEX idx_mv_parent ON milestone_versions(parent_version_id);
CREATE INDEX idx_map_coop ON milestone_mappings(cooperation_ref);
CREATE INDEX idx_deps_version ON milestone_dependencies(version_id);
CREATE INDEX idx_items_version ON delivery_items(version_id);
CREATE INDEX idx_events_item ON delivery_events(item_id);
CREATE INDEX idx_receipts_version ON receipts(version_id);
CREATE INDEX idx_disputes_coop ON disputes(cooperation_ref);
CREATE INDEX idx_conclusions_version ON conclusions(version_id);
CREATE INDEX idx_audit_coop ON audit_events(cooperation_ref, occurred_at);

-- 审计事件与结论禁止修改/删除，以数据库触发器兜底
CREATE TRIGGER trg_conclusions_no_update BEFORE UPDATE ON conclusions
BEGIN
    SELECT RAISE(ABORT, 'conclusions_are_immutable_use_reversal');
END;
CREATE TRIGGER trg_conclusions_no_delete BEFORE DELETE ON conclusions
BEGIN
    SELECT RAISE(ABORT, 'conclusions_are_immutable_use_reversal');
END;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_events
BEGIN
    SELECT RAISE(ABORT, 'audit_events_are_append_only');
END;
