# 2026 年 11 月对照官方文档

以下是设计依据和对照材料，不能替代正文条款。对照截至 2026 年 11 月的官方文档。教程多是过去半年的材料，不能代替当前官方说明。没有官方 V5。

| 对照点 | 官方情况 | 正文如何落实 |
| --- | --- | --- |
| BSC 上的 Infinity 与 Uniswap V4 | Uniswap V4 已在 BSC 官方部署。Pancake Infinity（原称 V4）2025 年 4 月上线，一周年回顾称首年成交超过 1130 亿美元 | 第一期的门是先跑通 Elysium。轮到 BSC 时仍先跑通两个 V3，再接 Infinity 和 Uniswap V4，适配器分开写 |
| 数据源口径 | Uniswap 公开 subgraph 端点只是示例，不是 Labs 维护的生产索引，须带 The Graph API 密钥或自部署。Pancake V3 在 BSC 仍有官方 subgraph；Infinity 暂未见官方公开索引 | 官方档前提是经验证的部署；社区索引可用但必须标成非官方，挂了要报错，不能拿过期表冒充新数据 |
| 时间窗口 | Meteora Datapi 现有 5 分钟、30 分钟、1、2、4、12、24 小时。Raydium 仍只有 24 小时、7 天、30 天，通常滞后 1 到 5 分钟 | 表里补上 5 分钟，默认仍看 1 小时。Elysium 已定窗口必须自建并如实展示 |
| fees APR 算法 | Uniswap V4 hook、Pancake Infinity、Meteora、Raydium CLMM（2026 年 5 月起）都有动态费。Uniswap 已在部分 V3 池收取约六分之一的协议费 | 只用窗口内实际归 LP 的手续费年化，不用费率档乘成交量；看板上标 hook 类型 |
| Elysium 和其他细节 | Elysium 的 Uniswap V2/V3/V4 已写入官方 SDK（2026-11-10）。Raydium 允许同一对、同一费率开多个池，旧的池内成交量字段已弃用。Meteora 手续费可能只按一种币收 | Elysium 仍自建窗口，生产用带归档的节点，读状态用 StateView。联调可用官方公开节点，须标明临时公开源。Raydium 改读 API，一行一个池。美元换算按实际收费币种。SDK 全部锁定版本。后期协议清单另补 Base 上 Pancake 的现行官方协议与 Meteora DAMM V2 |
