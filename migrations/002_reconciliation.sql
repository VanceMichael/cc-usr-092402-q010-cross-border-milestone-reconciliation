-- 证据对账数据模型
-- 设计约定：
-- 1) 事实表一律 append-only：更正通过插入新版本行实现，asOf(T) 查询只取 recorded_at <= T 的最新版本；
-- 2) 跨方事实（映射、拆分）走提议-确认，双方确认后生效；
-- 3) 已关闭结算批次的付款结论不可变，只能通过冲正(reversal)+替代结论(replacement)变更；
-- 4) 所有时间字段为带偏移量 ISO 8601，日历日为各方本地日期（YYYY-MM-DD）。

-- 合作项目
CREATE TABLE IF NOT EXISTS cooperations (
    ref          TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    currency     TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

-- 双方档案版本：境内 A / 境外 B，各自带 IANA 时区与本地周末；更正插新版本行
CREATE TABLE IF NOT EXISTS party_versions (
    id            TEXT PRIMARY KEY,
    side          TEXT NOT NULL CHECK (side IN ('A', 'B')),
    seq           INTEGER NOT NULL,
    party_name    TEXT NOT NULL,
    iana_timezone TEXT NOT NULL,
    weekend_days  TEXT NOT NULL DEFAULT '[0,6]', -- JSON 数组，0=周日 … 6=周六
    recorded_at   TEXT NOT NULL,
    recorded_by   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_party_versions_lookup
    ON party_versions(side, recorded_at);

-- 各方本地日历日调整（假日/补班），append-only，asOf 取每个 (side, local_date) 最新一行
CREATE TABLE IF NOT EXISTS calendar_days (
    id           TEXT PRIMARY KEY,
    side         TEXT NOT NULL CHECK (side IN ('A', 'B')),
    local_date   TEXT NOT NULL, -- YYYY-MM-DD
    kind         TEXT NOT NULL CHECK (kind IN ('holiday', 'workday')),
    label        TEXT,
    recorded_at  TEXT NOT NULL,
    recorded_by  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_days_lookup
    ON calendar_days(side, local_date, recorded_at);

-- 双方里程碑版本（本方事实，本方更正）
CREATE TABLE IF NOT EXISTS milestone_versions (
    id               TEXT PRIMARY KEY,
    cooperation_ref  TEXT NOT NULL,
    side             TEXT NOT NULL CHECK (side IN ('A', 'B')),
    milestone_code   TEXT NOT NULL,
    seq              INTEGER NOT NULL, -- 同节点版本序号，单调递增
    title            TEXT NOT NULL,
    local_due_date   TEXT NOT NULL,    -- 各方本地到期日 YYYY-MM-DD
    dependencies     TEXT NOT NULL DEFAULT '[]', -- JSON ["A:M1","B:X2"] 限定码
    required_role    TEXT NOT NULL,    -- 必须确认的约定角色
    holiday_policy   TEXT NOT NULL DEFAULT 'next_workday'
                        CHECK (holiday_policy IN ('as_is', 'next_workday')),
    recorded_at      TEXT NOT NULL,
    recorded_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestone_versions_lookup
    ON milestone_versions(cooperation_ref, side, milestone_code, recorded_at);

-- 交付清单版本：整版替换，asOf 取最新版本
CREATE TABLE IF NOT EXISTS deliverable_versions (
    id               TEXT PRIMARY KEY,
    cooperation_ref  TEXT NOT NULL,
    side             TEXT NOT NULL CHECK (side IN ('A', 'B')),
    milestone_code   TEXT NOT NULL,
    version          INTEGER NOT NULL,
    items            TEXT NOT NULL, -- JSON [{item_code,title}]
    recorded_at      TEXT NOT NULL,
    recorded_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliverable_versions_lookup
    ON deliverable_versions(cooperation_ref, side, milestone_code, recorded_at);

-- 签收回执：同 digest 先到 accepted，后到自动标记 duplicate，重复回执不参与覆盖判定
CREATE TABLE IF NOT EXISTS receipts (
    id               TEXT PRIMARY KEY,
    cooperation_ref  TEXT NOT NULL,
    side             TEXT NOT NULL CHECK (side IN ('A', 'B')),
    milestone_code   TEXT NOT NULL,
    item_code        TEXT, -- NULL 表示整包签收（清单为空时使用）
    digest           TEXT NOT NULL, -- sha256:<hex>
    source_ref       TEXT NOT NULL,
    signed_at        TEXT NOT NULL, -- 回执签发时刻（带偏移）
    received_at      TEXT NOT NULL, -- 到达本方时刻（带偏移）
    status           TEXT NOT NULL CHECK (status IN ('accepted', 'duplicate')),
    duplicate_of     TEXT,
    recorded_at      TEXT NOT NULL,
    recorded_by      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipts_lookup
    ON receipts(cooperation_ref, side, milestone_code, recorded_at);

-- 约定角色确认；required_role 确认是里程碑完成的必要条件
CREATE TABLE IF NOT EXISTS confirmations (
    id               TEXT PRIMARY KEY,
    cooperation_ref  TEXT NOT NULL,
    side             TEXT NOT NULL CHECK (side IN ('A', 'B')),
    milestone_code   TEXT NOT NULL,
    role             TEXT NOT NULL,
    actor_ref        TEXT NOT NULL,
    decision         TEXT NOT NULL CHECK (decision IN ('confirmed', 'rejected')),
    note             TEXT,
    recorded_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_confirmations_lookup
    ON confirmations(cooperation_ref, side, milestone_code, role, recorded_at);

-- 跨方映射（共同确认）事件流：propose/confirm/reject 全部 append-only；
-- asOf(T) 按事件顺序折叠出当时状态（新 propose 会重置此前的 confirm/reject）。
CREATE TABLE IF NOT EXISTS cross_mapping_events (
    id               TEXT PRIMARY KEY,
    cooperation_ref  TEXT NOT NULL,
    node_code        TEXT NOT NULL,
    action           TEXT NOT NULL CHECK (action IN ('propose', 'confirm', 'reject')),
    side_a_code      TEXT NOT NULL,
    side_b_code      TEXT NOT NULL,
    amount_cents     INTEGER NOT NULL CHECK (amount_cents >= 0),
    governing_side   TEXT NOT NULL CHECK (governing_side IN ('A', 'B')), -- 逾期认定适用方
    actor_side       TEXT NOT NULL CHECK (actor_side IN ('A', 'B')),
    event_at         TEXT NOT NULL,
    recorded_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cross_mappings_lookup
    ON cross_mapping_events(cooperation_ref, node_code, recorded_at);

-- 里程碑拆分（共同确认）事件流：按 (parent_node, child_node) 折叠 propose/confirm/reject
CREATE TABLE IF NOT EXISTS split_events (
    id               TEXT PRIMARY KEY,
    cooperation_ref  TEXT NOT NULL,
    parent_node      TEXT NOT NULL,
    child_node       TEXT NOT NULL,
    weight           INTEGER NOT NULL CHECK (weight > 0 AND weight <= 10000), -- 基点 10000=100%
    side_a_code      TEXT NOT NULL,
    side_b_code      TEXT NOT NULL,
    action           TEXT NOT NULL CHECK (action IN ('propose', 'confirm', 'reject')),
    actor_side       TEXT NOT NULL CHECK (actor_side IN ('A', 'B')),
    event_at         TEXT NOT NULL,
    recorded_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_splits_lookup
    ON split_events(cooperation_ref, parent_node, child_node, recorded_at);

-- 异议事件流：open/withdraw append-only；asOf(T) 折叠出当时仍 open 的异议。
-- open 期间冻结对应节点金额；只影响本节点，不波及其它节点。
CREATE TABLE IF NOT EXISTS objection_events (
    id               TEXT PRIMARY KEY,
    cooperation_ref  TEXT NOT NULL,
    node_code        TEXT NOT NULL,
    action           TEXT NOT NULL CHECK (action IN ('open', 'withdraw')),
    open_objection_id TEXT, -- withdraw 事件指向所撤回的 open 事件
    side             TEXT NOT NULL CHECK (side IN ('A', 'B')),
    reason_digest    TEXT, -- open 时必填
    detail_ref       TEXT,
    event_at         TEXT NOT NULL,
    recorded_by      TEXT NOT NULL,
    recorded_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_objections_lookup
    ON objection_events(cooperation_ref, node_code, event_at);

-- 结算批次：关闭后结论不可变
CREATE TABLE IF NOT EXISTS settlement_batches (
    id             TEXT PRIMARY KEY,
    cooperation_ref TEXT NOT NULL,
    currency       TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN ('open', 'closed')),
    rule_version   TEXT NOT NULL, -- 建批时固定的规则版本
    note           TEXT,
    opened_at      TEXT NOT NULL,
    closed_at      TEXT
);

-- 付款结论：append-only，每次重算插入新行（recompute_seq 递增），不更新不删除
CREATE TABLE IF NOT EXISTS payment_conclusions (
    id                 TEXT PRIMARY KEY,
    batch_id           TEXT NOT NULL,
    node_code          TEXT NOT NULL,
    recompute_seq      INTEGER NOT NULL,
    status             TEXT NOT NULL
                           CHECK (status IN ('payable', 'not_payable', 'blocked', 'frozen', 'superseded')),
    amount_cents       INTEGER,
    reasons            TEXT NOT NULL,  -- JSON 结构化原因与双视图逾期判定
    evidence_snapshot  TEXT NOT NULL,  -- JSON 本次结论使用的全部事实版本
    evidence_as_of     TEXT NOT NULL,  -- 证据截止时刻（关闭批次=closed_at）
    rule_version       TEXT NOT NULL,
    computed_at        TEXT NOT NULL,
    UNIQUE (batch_id, node_code, recompute_seq)
);
CREATE INDEX IF NOT EXISTS idx_conclusions_batch
    ON payment_conclusions(batch_id, node_code, recompute_seq);

-- 冲正：只能针对已关闭批次中的既有结论
CREATE TABLE IF NOT EXISTS reversals (
    id                     TEXT PRIMARY KEY,
    original_conclusion_id TEXT NOT NULL,
    batch_id               TEXT NOT NULL,
    node_code              TEXT NOT NULL,
    reason                 TEXT NOT NULL,
    recorded_by            TEXT NOT NULL,
    recorded_at            TEXT NOT NULL
);

-- 替代结论：冲正后的新结论，挂在冲正单上，原值不被删除
CREATE TABLE IF NOT EXISTS replacement_conclusions (
    id                 TEXT PRIMARY KEY,
    reversal_id        TEXT NOT NULL,
    batch_id           TEXT NOT NULL,
    node_code          TEXT NOT NULL,
    status             TEXT NOT NULL
                           CHECK (status IN ('payable', 'not_payable', 'blocked', 'frozen', 'superseded')),
    amount_cents       INTEGER,
    reasons            TEXT NOT NULL,
    evidence_snapshot  TEXT NOT NULL,
    evidence_as_of     TEXT NOT NULL,
    rule_version       TEXT NOT NULL,
    computed_at        TEXT NOT NULL,
    UNIQUE (reversal_id)
);

-- 批次重放记录：保存按历史批次重放时使用的证据快照、规则版本与重算结果
CREATE TABLE IF NOT EXISTS replay_runs (
    id                  TEXT PRIMARY KEY,
    batch_id            TEXT NOT NULL,
    evidence_as_of      TEXT NOT NULL,
    rule_version        TEXT NOT NULL,
    request_actor       TEXT NOT NULL,
    conclusions         TEXT NOT NULL, -- JSON 重算结果
    late_evidence       TEXT NOT NULL, -- JSON 截止后到达、重放中被剔除的迟到证据
    matches_original    INTEGER NOT NULL CHECK (matches_original IN (0, 1)),
    ran_at              TEXT NOT NULL
);
