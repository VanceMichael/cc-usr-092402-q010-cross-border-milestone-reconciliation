
# 跨境合作里程碑对照台

本仓库承载双方里程碑映射、交付证据与争议的纯后端服务。服务以 SQLite 文件保存业务数据，不连接共享数据库、缓存或第三方网络接口；数据库位置由 `DATABASE_PATH` 配置，监听端口由 `PORT` 配置。

代码按 HTTP 入口（`src/http.ts`）、领域规则（`src/domain/`：日历换算与确定性重算引擎）、持久化与用例编排（`src/store.ts`）组织。`fixtures/example.json` 保存不含真实主体信息的本地样例。

## 证据对账流程

1. **建档**：负责人创建合作项目；双方各自登记本方时区/周末、假日与补班日。
2. **本方事实**：双方分别登记本方里程碑版本（本地到期日、依赖、约定确认角色）、整版交付清单、签收回执与角色确认。一方只能更正本方事实，跨方写操作返回 `403`。
3. **共同确认**：一方提议双方里程碑的跨方映射（含金额与逾期管辖方），另一方确认后形成结算节点；里程碑拆分走同一提议-确认流程。
4. **确定性重算**：负责人随时可以按当前证据重算全部节点。引擎按规则 `rules-1.0.0` 得出 `payable / not_payable / blocked / frozen / superseded`，双时区日历视图、部分交付、重复回执、假日顺延、依赖、拆分分摊与异议冻结全部在结论与原因码中留痕。
5. **批次结算**：开批次 → open 期间反复重算（保留每个 `recompute_seq` 版本行）→ 关闭固化。已关闭结论只能通过**冲正 + 替代记录**变更，原值不删不改。
6. **争议冻结**：open 异议只冻结对应节点金额，不阻塞任何无关节点；撤回异议后重算恢复。
7. **重放与溯源**：可按任意结算批次（closed 严格按关闭时刻）重放当时证据与规则，逐节点比对是否与固化结论一致并列出迟到证据；节点溯源接口呈现完整事件时间线与各批次结论版本。

完整业务规则见 [`docs/domain.md`](docs/domain.md)，字段约定见 [`contracts/entities.json`](contracts/entities.json)。

## 接口一览

身份通过请求头传递：`x-actor-ref` 必填，成员带 `x-actor-side=A|B`，负责人带 `x-actor-role=owner`。成功响应统一包一层 `{ "data": ... }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/cooperations` | 负责人创建合作项目 |
| POST | `/cooperations/{ref}/parties` | 登记本方档案（时区/周末），版本化 |
| POST | `/cooperations/{ref}/calendar-days` | 登记本方假日/补班日 |
| POST | `/cooperations/{ref}/milestones` | 登记/更正本方里程碑版本 |
| POST | `/cooperations/{ref}/deliverables` | 登记整版交付清单 |
| POST | `/cooperations/{ref}/receipts` | 登记签收回执（重复自动标记 duplicate） |
| POST | `/cooperations/{ref}/confirmations` | 约定角色确认/拒绝 |
| POST | `/cooperations/{ref}/mappings` | 提议跨方映射 |
| POST | `/cooperations/{ref}/mappings/{node}/respond` | 对方 confirm/reject |
| POST | `/cooperations/{ref}/splits` | 提议里程碑拆分 |
| POST | `/cooperations/{ref}/splits/{parent}/{child}/respond` | 对方 confirm/reject |
| POST | `/cooperations/{ref}/objections` | 提出异议（冻结本节点） |
| POST | `/cooperations/{ref}/objections/{id}/withdraw` | 撤回本方异议 |
| GET | `/cooperations/{ref}` | 当前（或 `?asOf=` 时点）全部结论与双视图 |
| GET | `/cooperations/{ref}/nodes/{node}/trace` | 负责人：差异溯源 |
| POST | `/batches` | 负责人开批次 |
| POST | `/batches/{id}/recompute` | open 批次重算留痕 |
| POST | `/batches/{id}/close` | 关闭批次并固化末轮结论 |
| POST | `/batches/{id}/reverse` | 冲正已关闭结论并生成替代记录 |
| POST | `/batches/{id}/replay` | 按批次重放当时证据与规则 |
| GET | `/batches/{id}` | 批次：最新结论、全部版本、冲正、重放记录 |
| GET | `/health` | 健康检查 |

## 开发命令

- `make migrate`：初始化或升级 SQLite 文件（`migrations/` 按文件名顺序应用并记录在 `schema_migrations`）。
- `make test`：运行自动化测试（17 个领域规则单测 + 8 个端到端用例，共 25 个）。
- `make run`：启动后端进程。
- `docker compose up --build`：构建并启动容器，宿主机端口可通过 `APP_PORT` 调整。

本地运行和测试不要求固定账号，也不会请求外部业务系统；身份以请求头模拟（见上）。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 编译或构建：`npm run build`
