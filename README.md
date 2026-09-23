
# 跨境合作里程碑对照台

本仓库承载双方里程碑映射、交付证据与争议的纯后端服务。服务以 SQLite 文件保存业务
数据，不连接共享数据库、缓存或第三方网络接口；数据库位置由 `DATABASE_PATH` 配置，
监听端口由 `PORT` 配置。

代码按 HTTP 入口（`src/routes.ts`）、领域服务（`src/service.ts`）、确定性重算规则
（`src/engine.ts`）、工作日历（`src/calendar.ts`）与持久化（`src/repo.ts`）组织。
规则与状态机的完整说明见 `docs/domain.md`，字段契约见 `contracts/entities.json`，
`fixtures/example.json` 保存不含真实主体信息的本地样例。

## 开发命令

- `make migrate`：初始化或升级 SQLite 文件（按 `migrations/` 顺序幂等应用）。
- `make test`：运行自动化测试。
- `make run`：启动后端进程。
- `docker compose up --build`：构建并启动容器，宿主机端口可通过 `APP_PORT` 调整。

本地运行和测试不要求固定账号，也不会请求外部业务系统。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 编译或构建：`npm run build`

## 接口速览

身份：除 `/health` 与 `/admin/*` 引导接口外，请求须携带
`x-actor-party`（参与方编号）与 `x-actor-role`（如 `lead`、`project_owner`）。

| 分组 | 接口 |
| --- | --- |
| 引导 | `POST /admin/parties`、`POST /admin/cooperations`、`POST /admin/cooperations/:ref/calendars`、`POST /admin/calendars/:id/holidays` |
| 里程碑 | `POST/GET /cooperations/:ref/milestones`、`POST /cooperations/:ref/milestones/:vid/split` |
| 跨方映射 | `POST /cooperations/:ref/mappings`、`POST .../mappings/:id/confirm`、`POST .../mappings/:id/void`、`GET .../mappings` |
| 依赖 | `POST/GET /cooperations/:ref/dependencies` |
| 交付与签收 | `POST .../versions/:vid/items`、`POST .../versions/:vid/deliveries`、`POST .../versions/:vid/receipts` |
| 本方更正 | `POST /cooperations/:ref/facts/:table/:id/withdraw` |
| 异议 | `POST/GET /cooperations/:ref/disputes`、`POST .../disputes/:id/resolve`、`POST .../disputes/:id/withdraw` |
| 重算与结论 | `POST /cooperations/:ref/recompute`、`POST .../versions/:vid/recompute`、`GET .../versions/:vid/conclusions`、`GET .../versions/:vid/payable`、`POST .../conclusions/:id/confirm` |
| 冲正 | `POST .../conclusions/:id/reversals`、`POST .../reversals/:id/accept`、`POST .../reversals/:id/reject`、`GET .../reversals` |
| 结算批次 | `POST/GET /cooperations/:ref/batches`、`POST .../batches/:id/close`、`GET .../batches/:id`、`GET .../batches/:id/replay` |
| 溯源 | `GET /cooperations/:ref/state`、`GET .../versions/:vid/diff`、`GET /cooperations/:ref/audit` |

典型闭环：登记双方日历与里程碑 → 建立映射并双方确认 → 登记清单、交付与签收 →
（自动重算）结论满足客观门 → 约定角色逐一确认 → 可付款 → 批次关闭纳入结算 →
有异议则冻结相关集群、有变更则冲正+替代 → 任意时刻按批次重放当时证据与规则。
