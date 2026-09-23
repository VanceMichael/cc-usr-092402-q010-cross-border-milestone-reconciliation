# 领域约定

跨境合作里程碑对照台记录双方里程碑映射、交付证据与争议中的本地业务事实。主体使用不含真实身份的引用编号，时间字段采用带偏移量的 ISO 8601 字符串，文件或正文只保存 `sha256` 摘要及本地引用。

`contracts/entities.json` 列出交换字段，字段名称是稳定的接口约定。无效输入在 HTTP 边界返回结构化错误（`400/403/404/409`，载荷为 `{error, message, details}`），不能通过修改样例数据绕过校验。SQLite 文件由 `DATABASE_PATH` 决定，开发环境默认写入 `data/app.sqlite3`。

## 角色与事实主权

调用身份由请求头模拟：`x-actor-ref`（操作者编号）、`x-actor-side`（`A`=境内 / `B`=境外）、`x-actor-role=owner`（项目负责人）。

- 一方成员只能登记、更正**本方**事实（本方档案、本方日历日、本方里程碑版本、本方交付清单、本方回执、本方角色确认、本方异议）；写入他方事实返回 `403 fact_ownership_denied`。
- **跨方映射**（双方里程碑码 → 统一结算节点）与**里程碑拆分**不属于任何一方：一方 `propose`，必须由**另一方** `confirm` 或 `reject`；提议方自行确认返回 `409 cross_confirmation_required`。
- 项目负责人不开立业务事实，但可以创建合作项目、开关结算批次、冲正、重放，并查看任意节点的差异溯源。

## Append-only 与更正

所有事实表只追加、不更新、不物理删除：

- 里程碑、交付清单、双方档案通过插入更大 `seq/version` 的新版本行更正；
- 映射/拆分/异议是事件流（`propose/confirm/reject`、`open/withdraw`），状态由事件按 `(event_at, rowid)` 全序折叠得出；
- 任何时点结论只取 `recorded_at <= T` 的最新事实（见 R1），因此历史结论可以按任意时点复现。

## 时区与日历

- 每方档案固定一个 IANA 时区（如 `Asia/Shanghai`、`Europe/Berlin`）与本地周末集合；档案更正也是版本化事实。
- 日历日按方登记：`holiday`（假日）或 `workday`（补班）。判定顺序：**显式登记覆盖优先，其次周末规则**。
- 里程碑到期日是各方本地日期。`holiday_policy=next_workday`（默认）时，到期日落在非工作日则顺延到最近工作日；`as_is` 不顺延。
- 逾期上界 = 调整后到期日的**次日本地 00:00**（排他）。完成时刻早于该瞬间为按期。
- A、B 双方各自得到一个到期视图（`views.A.due`、`views.B.due`），分歧在结论原因中以 `calendar_views_differ` 留痕；是否逾期以映射上共同确认的 `governing_side` 为准。

## 确定的重算规则（rules-1.0.0）

规则版本固定在结算批次上（`rule_version`），同一份时点快照 + 同一版本规则必然得到同一结论。

- **R1 版本选取/迟到证据**：各类事实只取 `recorded_at <= T` 的最新版本；之后登记的事实一律不参与。批次重放会列出被剔除的迟到证据清单。
- **R2 跨方映射**：仅 `confirmed` 映射形成结算节点；`proposed/rejected` 不产生付款结论。已确认映射允许任一方在付款前重新提议修订（金额、管辖方或里程碑码），状态回到 `proposed` 并须经对方再次确认，修订期间该节点不产生结论；已有未终结拆分的节点不得修订映射。
- **R3 里程碑拆分**：按 `(父节点, 子节点)` 折叠最新状态。
  - 存在未决提议（`proposed`）→ 父节点 `blocked/split_negotiation_open`，不出子节点结论；
  - 无未决提议但已确认权重之和 ≠ 10000 基点 → 父节点 `blocked/split_weight_mismatch`；
  - 已确认权重恰为 10000 → 父节点 `superseded`，子节点按权重以**最大余数法**分摊金额（余分按小数部分从大到小、序号从小到大分配）。
  - 写入侧只拦截确认后权重超过 10000 的请求（`409 split_weight_exceeded`），允许逐条共同确认。
- **R4 完成条件（逐方）**：交付清单（整版版本化）的**每个交付项**都有一张 `accepted` 签收回执，且约定角色（`required_role`）的最新决定为 `confirmed`。缺一即 `blocked`：缺项为 `partial_delivery`，角色缺认为 `role_not_confirmed`/`role_rejected`。空清单需一张整包回执。完成时刻 = max(各覆盖回执 `signed_at`, 角色确认 `recorded_at`)。
- **R5 依赖**：依赖用限定码（`A:M1`、`B:X2`）表达，全部满足后本方才满足；依赖满足时刻并入完成时刻。依赖成环 → `blocked/dependency_cycle`，环内不传播满足。
- **R6 时区日历**：双方各按自己的 IANA 时区与本地日历计算到期日（显式假日/补班覆盖优先于周末），双视图同时保留，`holiday_adjusted` 记录顺延事实，`calendar_views_differ` 记录双方逾期结论分歧；最终以 `governing_side` 为准（R8）。
- **R7 异议冻结**：节点存在 `open` 异议（未撤回）→ `frozen`，金额保留但不进入付款；冻结**只影响本节点**，无关节点照常得出结论。撤回异议后重算即恢复。
- **R8 逾期认定**：以管辖方视图为准。管辖方逾期 → `not_payable/late_under_governing_calendar`；仅非管辖方视角逾期时仍 `payable`，但记录 `calendar_views_differ`；发生假日顺延时记录 `holiday_adjusted`。
- **R9 状态优先级**：`superseded` > `blocked` > `frozen` > `not_payable` > `payable`。

### 重复回执

同一节点、同一交付项（整包回执为 NULL 项）、同一 `sha256` 摘要：第一张登记为 `accepted`，其后自动标记 `duplicate` 并记录 `duplicate_of`；重复回执不参与覆盖判定，只在视图 `duplicateReceiptIds` 中留痕。同交付项不同摘要的多张回执均为 `accepted`，完成时刻取最晚的覆盖回执。

### 迟到证据

证据"迟到"是相对于结论时点，而非签收时刻：批次在 T 关闭后登记的回执（即便其 `signed_at` 很早）不改变关闭时结论，只出现在重放的迟到证据清单中。

## 结算批次与不可变性

- 批次由负责人 `open`，建批时固定 `rule_version`；open 期间可反复重算，每次为每节点追加一行更大 `recompute_seq` 的结论（历史行全部保留）。
- `close` 时以同一瞬间作为最终证据截止时刻写入末轮结论与 `closed_at`；关闭后结论**不可变**，重算返回 `409 batch_closed`。
- 已经进入付款的结论只能通过**冲正**（`reversals`，记录原因与操作人）加一条**替代结论**（`replacement_conclusions`，按当前证据与规则重算）变更；原结论行不删除、不改写，批次视图同时呈现原值与替代值。
- **重放**（任意批次）：closed 批次严格按 `closed_at` 取证据快照重算并逐节点比对固化结论（`matches_original`）；open 批次按当前时刻重放。重放记录保存当时使用的证据截止时刻、规则版本、逐节点比对与迟到证据。

## 差异溯源

`GET /cooperations/{ref}/nodes/{node}/trace`（仅负责人）返回：映射/拆分/异议完整事件时间线、当前重算结论（含双方视图、依赖状态、逾期判定与所用事实版本 id）、该节点在各批次中的全部结论版本以及冲正/替代记录，用于回答"差异从何产生"。
