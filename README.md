# LP Atlas

LP Atlas 是链上集中流动性扫描与过滤看板。本仓库的 `docs/` 与 [LP Atlas 项目标准](https://cursor.com/canvas/store-228dc691-956a-4bc2-a808-727d3a2b74e5/e5325002-b925-4eb0-a1cd-0e6aa760e873) 是项目标准的分类归档，不是讨论记录。

- 产品仓库在本机 `D:\Axiangmu\LP Atlas`，代码更新与后台扫描直接在此运行。
- 主系统：TypeScript。后端 Node.js + Fastify（看板 `/api/v2/board`，健康和刷新 `/api/v1`），前端 React + Vite，共享类型在 `src/shared`。包管理用 pnpm，推荐 Node 24.11.1（见 `.nvmrc`）；最低兼容范围见 `package.json`。
- 当前阶段：Elysium 与 Robinhood 的 Uniswap V3/V4 已启用同一五分钟续接采集；方案13报价纠错已按范围验收，未估值记录与精确手续费限制见唯一清单，不连接钱包、不提交交易。
- 所有 AI 先读 [AGENTS.md](AGENTS.md)

现有 Python 仓库 `D:\Axiangmu\流动性LP` 只作对照，不要往那里加产品代码。不要把 CJ 的公开仓库当作产品边界去抄。

## 怎么跑

在仓库根目录：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

这会同时启动 API（默认 `http://127.0.0.1:3001`）和看板（`http://127.0.0.1:5173`）。前端把 `/api` 代理到 API，浏览器不会直接请求官方索引、节点、The Graph、Alchemy、区块浏览器或 Uniswap。

其它脚本：

```bash
pnpm test    # Vitest 单元测试
pnpm check   # Biome + 后端、前端、研究脚本 TypeScript
pnpm build   # 后端、SQL 迁移文件和前端构建
pnpm start   # 运行编译后的 API；PC 开发看板仍用 pnpm dev:web
```

API 启动后先扫描一次，此后每五分钟按链检查；同链忙则跳过，其他空闲链正常采集，不排队叠跑。也可在看板点「刷新」，与后台任务共用管线和互斥状态，由服务端拉工厂级池清单、自建已定窗口并计算 fees APR。关闭浏览器不影响扫描，电脑与 API 须保持运行。每个小时累计提交后推进各链发布版本，前端按五秒状态轮询自动载入；浏览器轮询只读API，不触发扫描。

## 环境变量

复制 `.env.example` 为 `.env`。不要把密钥提交进仓库，也不要发到聊天里。

| 变量 | 说明 |
| --- | --- |
| `ELYSIUM_RPC_URL` | Elysium 主 RPC；未配置时使用临时公开源。本轮整理不迁移节点，历史状态能力取决于实际节点 |
| `ELYSIUM_RPC_URL_BACKUP` | 可选备用 RPC |
| `ROBINHOOD_RPC_URL` / `ROBINHOOD_RPC_URL_BACKUP` | Robinhood 主/备用 RPC；当前采集使用本地已配置归档源，不提交实际 URL 或密钥 |
| `USD_QUOTES_ENABLED` | 默认启用 RedStone Push；设为 `false` 停用美元报价，不恢复已知错误的旧报价规则 |
| `PORT` / `HOST` | API 监听地址，默认 `127.0.0.1:3001` |
| `DATABASE_PATH` | 本地 SQLite 路径，默认 `./data/lp-atlas.db` |
| `AUTO_SCAN_ENABLED` | 默认 `true`；设为 `false` 并重启 API 可停用定时扫描 |
| `SCAN_MAX_DATABASE_MB` | 默认 `2048` MiB，库和 SQLite 旁文件达到阈值时跳过定时扫描 |
| `SCAN_MIN_FREE_DISK_MB` | 默认 `512` MiB，磁盘剩余不足时跳过定时扫描 |

如果没有设置 `ELYSIUM_RPC_URL`，服务仍可启动，并临时使用官方公共节点 `https://rpc.elysium.kinetiq.xyz`。界面须标明这是临时公开源（`public_temporary`），不能当作生产或验收主源。公共节点不是归档节点，历史日志或状态不足时会报错或标出缺口，不会用其它窗口冒充已定窗口，也不会把过期表当成新数据。

办理 Alchemy 的步骤见 [docs/05-operations/04-prepare.md](docs/05-operations/04-prepare.md)。

扫描状态见 `/api/v1/health` 的 `autoScan` 和 `refresh`，包含下次触发时间、最近结果及跳过/失败原因。资源保护、小时批次、停止与回退见 [运行说明](docs/05-operations/03-runtime.md)。

## 第一期范围

- 当前启用 Elysium（chain ID `99901`）与 Robinhood（chain ID `4663`）的 Uniswap V3/V4 扫描看板；其他场所保持占位。数据接入、过滤、筛选和排序必须做扎实。
- fees APR 只用该窗口内实际归 LP 的手续费年化，不用费率档乘成交量。
- 默认统一 1H 过滤：TVL ≥ 1,000 美元、1H 成交量 ≥ 100 美元、1H 普通 LP 核心手续费 ≥ 10 美元，不设 APR 门槛；各窗口使用同一批 1H 达标池，默认按 1 小时 fees APR 从高到低排序。
- 已定窗口为 1 小时、2 小时、4 小时、6 小时、24 小时、3 天；按真实小时档计算，缺档如实留空，不得用其他窗口冒充。3D 与 4 天保留的实施状态见统一方案。
- 同一交易对在 V3 与 V4 分行展示。当前未结束的小时会标成未完成。缺档显示为空。
- 手动刷新与后台五分钟续接采集共用管线；不连接钱包、不提交交易、不另做登录。提醒、Fee 对 IL 列、自动开仓与默认自动重挂仍暂缓。
- 钱包、只读仓位和开仓页的完整设计见 `docs/01-product/`（开仓页交互见 `docs/01-product/04-entry.md`），实现等扫描验收通过后再做。

## 目录

| 路径 | 内容 |
| --- | --- |
| `docs/01-product` | 产品标准 |
| `docs/02-architecture` | 架构标准 |
| `docs/03-data` | 数据标准 |
| `docs/04-standards` | 协作、验收、代码、迭代 |
| `docs/05-operations` | 运行与安全 |
| `src/adapters/` | RPC、RedStone 报价、协议读数；`venues/<chain>/<protocol>.ts` 按场所适配 |
| `src/normalize/` | 统一模型、定价、刷新流水线 |
| `src/store/` | SQLite 与可重放迁移 |
| `src/metrics/` | fees APR、过滤与排序 |
| `src/server/` | Fastify API 进程（不是新的产品层） |
| `src/web/` | React 看板 |
| `src/shared/` | 前后端共用类型与常量 |
| `test/` | 计算、存储、适配器及 API 回归测试 |
| `research/` | 离线历史研究与报告模板，不由生产扫描调用 |

阅读顺序见 [docs/README.md](docs/README.md)。

## 上传与本地数据边界

提交源码、测试、`docs/`、配置模板及 `pnpm-lock.yaml`。`.gitignore` 排除 `.env` 和其他本地环境文件、`data/`、`outputs/`、依赖、构建产物及缓存；`.env.example` 保留。约 1.15GB 的研究输出和运行材料仍留在本机，不随源码上传。文档中的 `outputs/` 链接是本地运行证据，克隆后不会自带这些文件；离线研究需另行准备输入数据。

上传前运行 `pnpm check`、`pnpm test`、`pnpm build`，并核对实际暂存文件。现有检查可能报告非阻塞建议，不能把通过解释成没有任何技术债。服务启动会自动采集；仅核对代码时保持服务关闭，或通过本地环境变量关闭自动采集。远程仓库为 https://github.com/ls569333469/LP-Atlas ，主分支为 `main`；2026-11-20已完成首次源码上传，不包含本地业务数据和密钥。
