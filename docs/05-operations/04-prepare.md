# 第一期你需要准备的东西

> 最新设计：窗口为 1H、2H、4H、6H、24H、3D，小时档保留 4 天；实施状态及旧记录以 [统一方案](../03-data/05-data-repair-and-1h-filter.md) 为准，以下旧描述不代表已按新设计运行。

对照官方文档整理，日期：2026-11-12。第一期只跑 Elysium 主网（chain ID `99901`）上的 Uniswap V3 与 Uniswap V4。你现在只要准备节点，不用准备钱包、不用准备 The Graph 密钥。

合约地址、工厂和 StateView 我按官方部署表写入仓库，你不用抄。

## 现在就要准备

### 1. Alchemy 的 Elysium 主网归档节点（必须）

Elysium 没有官方索引，看板要自己拉历史成交日志、自己汇总已定窗口（1 小时、2 小时、4 小时、6 小时、24 小时、3 天）。官方文档把 [Alchemy](https://dashboard.alchemy.com/) 定为推荐基础设施，并写明：历史读取和索引要用 archive 端点。公共 RPC 是大家共用的，生产验收和稳定刷新不要只用公共节点。

请按下面做：

1. 打开 [Alchemy 控制台](https://dashboard.alchemy.com/)，注册或登录。
2. 新建一个应用，网络选 **Elysium Mainnet**（chain ID `99901`）。
3. 按官方说明使用 **archive** 端点（用于历史状态和日志回溯）。
4. 复制 HTTPS RPC 地址，或复制 API Key。主网地址格式是：`https://elysium-mainnet.g.alchemy.com/v2/{API_KEY}`。
5. 有条件的话再备一个主备端点，避免单点限流或故障。

官方说明在：[Connecting to Elysium](https://elysium.kinetiq.xyz/docs/connecting-to-elysium)（2026-11-09 更新）。

做好后不要把密钥发到聊天里。告诉我「Alchemy 已经建好」，我会用安全表单收取，并只写入服务端环境变量。

### 2. 可选：公共 RPC 仅作联调临时公开源

官方公共节点：`https://rpc.elysium.kinetiq.xyz`。联调阶段可以先用，但必须标明这是临时公开源（public_temporary），不能当作生产或验收主源。区块浏览器：[Elysium explorer](https://elysium.kinetiq.xyz/explorer)。

## 你现在不用准备

- 钱包、私钥、助记词：第一期实现不连钱包、不能开仓。开仓设计已写入标准，实现等扫描验收通过后再做，届时仍不把密钥写入仓库。
- The Graph API 密钥：接到 BSC 的 Uniswap V3 时再准备。
- 登录账号、独立数据库：第一期本地 SQLite，不另做登录。

## 写进仓库的官方地址（你不用申请）

来源：[Uniswap V3 Elysium 部署](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-elysium-deployments)、[Uniswap V4 部署](https://developers.uniswap.org/docs/protocols/v4/deployments)（Elysium: 99901）。

| 用途 | 合约 | 地址 |
| --- | --- | --- |
| V3 工厂 | UniswapV3Factory | `0x1707327F626496A7b5b3872e7E4d2879Df7d7a9f` |
| V3 头寸管理 | NonfungiblePositionManager | `0xF025e0Fe9E331A0eF05c2ad3C4E9C64b625cda6f` |
| V4 池管理 | PoolManager | `0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1` |
| V4 读状态 | StateView | `0x27eD73aE0652fdCf71d6793412A7525f32bE9dfE` |

读 V4 当前状态优先用 StateView，说明见 [StateView 指南](https://developers.uniswap.org/docs/protocols/v4/guides/state-view)。

## 以后才要准备

| 阶段 | 要准备什么 | 去哪里 |
| --- | --- | --- |
| 接到 BSC Pancake V3 / Uniswap V3 | Uniswap 用 The Graph API 密钥或自托管官方 subgraph；Pancake V3 用官方 subgraph | 届时再写操作步骤 |
| 开仓、撤池进入热路径 | 按链的私有 RPC、钱包（仍不把密钥写入仓库） | 未到该阶段，不要提前准备交易私钥。实现须等扫描验收通过 |

原生 Gas 是 HYPE，链从 HyperEVM 结算。第一期看板只读链上数据，不必为此去桥接 HYPE。

## Robinhood Chain 节点准备（2026-11-14）

专用标准见 [08-robinhood-venue.md](../04-standards/08-robinhood-venue.md)。用户已授权并行生产拉数，初期可用官方公开节点，但正式验收仍须归档源。

- 官方连接说明：[Connecting](https://docs.robinhood.com/chain/connecting)。主网 chain ID `4663`，Gas 为 ETH。
- 官方公开端点：`https://rpc.mainnet.chain.robinhood.com`；代码默认连接并标明 `public_temporary`。少量历史读取成功不等于归档覆盖或可用性保证。
- 归档服务办理入口：[Alchemy 控制台](https://dashboard.alchemy.com/)，选择 Robinhood Mainnet；官方连接文档列出的端点格式为 `https://robinhood-mainnet.g.alchemy.com/v2/{API_KEY}`。需按实际套餐核验历史日志、四天内历史状态与调用额度，不能仅凭 URL 宣布归档能力通过。
- 凭据只配服务端 `.env` 中的 `ROBINHOOD_RPC_URL` / `ROBINHOOD_RPC_URL_BACKUP`，不贴进聊天或文档。配置为官方公开地址时仍保留临时公开源标记。
- 浏览器：[Robinhood Chain Blockscout](https://robinhoodchain.blockscout.com)。不使用券商插件作为扫描源。


### 2026-11-14 公共端点历史能力实测（不等于场所验收）

- 官方默认 RPC：USDG `decimals()` 在约 7.8 分钟前的区块仍可读，约 15.6 分钟前、约 1 小时前和约 67 小时前均返回 `historical state ... is not available`。这是抽样，不是固定保留期或精确能力上限；不能说所有历史数据均不可读。区块 `111615973`（北京时间 2026-11-11 18:00）附近 101 区块的 V4 日志请求成功，返回 99 条事件，说明约 74 小时前的日志可读不等于同区块合约状态可读。
- 官方 Connecting 页列出的 Pinax `https://robinhood.rpc.pinax.network`：无需密钥的只读请求确认 `eth_chainId=4663`；区块 `111615973` 与 `114108959` 的 USDG `decimals()` 均返回 6。复用生产 V4 读取器，在 `114108959` 成功读取既有样本 `0x4bb83ba800b88b7e3a1efe7753f8b8ec4c73c672feadf4cb2150bcc2c2ed6f38` 的 slot0、liquidity 与 Lens 储备，返回非零两币数量且无 gap。它是可继续验证的公开候选，尚未配置生产；未确认请求额度、连续历史全覆盖或整轮容量，不标为归档验收通过。
- Alchemy、Chainstack、QuickNode 等均在 Robinhood 官方连接页列出，须按实际端点和套餐核验归档能力。官方页推荐 Alchemy 并给出免费账户入口，但未据此保证免费套餐满足本项目整轮调用量。
- OKX：本轮未取得其 Robinhood 主网 4663 的公开 RPC 支持证据，官方文档站访问失败，不能下结论为已支持或不支持；任意其他链（含 X Layer）的 RPC 不能替代本链节点。

2026-11-14 后续整轮结果：经用户要求继续，Pinax 匿名端点已配置并实际执行第 238 轮；于 20:02:03 因日志请求超时和 HTTP 429 失败，未发布小时。429 正文为 `Free tier rate limit exceeded. Get a free API key at https://app.pinax.network`。可先注册免费 Key 并将完整端点写入本地 `.env`，不需要先购买套餐；需再验证认证后的请求额度与历史能力，不能保证免费套餐足以完成全部负载。没有认证之前不重复撞限流，自动调度继续关闭。


### 2026-11-14 晚：Alchemy 归档节点已写入本机配置

用户已办理 Alchemy Robinhood 主网按量付费档，密钥只写入本机 .env 的 ROBINHOOD_RPC_URL，不得写进文档或聊天。撰写本说明的助手已抽查链 ID 为 4663，且能读取刚结束小时附近的历史状态。官方公开节点和匿名 Pinax 不再作为生产或验收源（第 238 轮匿名 Pinax 已因 429 失败）。恢复拉数的操作步骤见 [08 交接与使用说明](08-codex-handoff-robinhood-alchemy-2026-11-14.md)。
