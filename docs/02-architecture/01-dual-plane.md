# 双平面与多链

交易平面只做已开仓的头寸监控、决策、风控和上链。旁路平面做全站池发现、过滤展示、指标计算、报表、前端和回放。扫描名单远大于持仓名单；旁路坏了不影响撤池；单协议或单条 RPC 异常要能隔离。

热路径禁止同步写盘、查库、慢 HTTP 和对聚合站重试。扫描给出的是入场候选，不直接触发撤池；撤池只信内存头寸状态和链上行情。要看的是「出区间到广播撤池交易」的 P99 与抖动。

## 多链三条硬规则

先归一、再决策、按链执行。策略只认统一模型，不认具体链的字段。跨链没有原子成交，每条意图在自己的链上独立确认。一条链或一条 RPC 熔断，不能挡住其他链撤池。

统一模型只保留策略真正要用的字段：

| 模型 | 字段 |
| --- | --- |
| `Venue` | 链、协议和池子的地址 |
| `MarketState` | 中间价、流动性、费率、tick 或 bin、链上时间与本地接收时间 |
| `Position` | 头寸编号、区间、库存、未领手续费、是否在区间内 |
| `Intent` | 只有加池、加仓、撤池、领费、销毁这五种 |

EVM 的 tick 和 Solana 的 bin 在归一化时就折成同一套区间表示，后面不要再分叉。EVM 按钱包加链管理 nonce；Solana 单独管 recent blockhash 和优先费。不要用一把全局锁把所有链串成一条队。

## 接入与归一

| 通道 | 做法 | 用途 |
| --- | --- | --- |
| EVM 主通道 | 私有 RPC 订阅 `logs` 与 `newHeads`。热路径只订已开仓的池和 Position Manager | 近实时状态与新鲜度 |
| EVM 兜底 | 断线时用 `eth_getLogs` 补段，用 `eth_call` 读状态 | 校准快照，重连后不丢事件 |
| Solana 主通道 | `accountSubscribe` 订头寸、池和 bin array；`slotSubscribe` 判断新鲜度 | 价格跨 bin、头寸是否还在区间内 |
| Solana 兜底 | `getAccountInfo` / `getMultipleAccounts` 拉快照；不要把全程序 `getProgramAccounts` 当常规热路径 | 重连对账 |

| 原始字段 | 归一后 |
| --- | --- |
| `sqrtPriceX96` / `tick`，或 `activeId` / bin 价格 | `midPrice` |
| `tickLower` / `tickUpper`，或 `minBin` / `maxBin` | `lowerPrice` / `upperPrice` / `inRange` |
| 原始 token 数量 + decimals | `amount0` / `amount1`，保留原始精度 |
| `blockNumber` / slot、`blockTime`、本地接收时间 | 链上时间 + 本地接收时间；新鲜度按该链出块时间算 |

扫描是旁路，观察名单可以有百级到千级池。不要把「扫当前全站池快照」和「索引一条链全部历史交易」混为一谈：后者不做。执行层以后按 `chains/evm`、`chains/solana` 与分协议适配器组包；第一期先把 `src/adapters` 这条扫描路跑通。
