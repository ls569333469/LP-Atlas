# 场所数据路径框架

> 2026-11-16已确认RedStone Push统一报价合同见本文末节及方案13第9/9.10节。涉及主资产报价的旧描述已被该合同取代；报价层及历史纠错已部署，本轮统一验收及未恢复限制以05-roadmap“美元计价修复”为准。

截至 2026-11-12（Asia/Shanghai）。本文件是多链扫描数据路径的分类标准，供 Codex 与后续迭代遵守。产品口径仍以 [LP Atlas 项目标准](https://cursor.com/canvas/store-228dc691-956a-4bc2-a808-727d3a2b74e5/e5325002-b925-4eb0-a1cd-0e6aa760e873) 为准。

## 必须遵守

- 一张看板，一行一个池，一场所一个适配器，同一套 `window_aggregates` / `scanned_hours`。禁止另起第二套拉取器、窗口表或计算管线。
- 目录以 `src/shared/catalog.ts` 为唯一场所清单；数据路径政策以 `src/shared/venue-sources.ts` 为唯一政策源。不要平行再做一份目录。
- 已定窗口：1h、2h、4h、6h、24h、3d。官方索引若只有 1h / 1d，则：1h 用官方 1h；2h / 4h / 6h 只由官方 1h 组成；24h / 3d 优先由完整的官方 1h 组成，仅当窗口恰好是整段 UTC 日时才可用官方 1d。缺小时必须留空，不得用相邻窗口、更短窗口或错位的 1d 冒充。
- fees APR 只用实际归 LP 的手续费。官方 subgraph 的 `feesUSD` 可能含协议费，接入前必须核实或扣除，未核实不得写入 fees APR。
- 浏览器只打本服务 `/api/v1`。Graph、RPC、官方索引客户端只放服务端。
- 新场所默认是 `listed_not_implemented`。标准未宣布启用前，不得改成 `enabled`，不得接入默认刷新，不得拉该链生产数据。第一期验收门仍是 Elysium Uniswap V3 / V4。Robinhood Chain 的启用例外见下文第 6 步和 [08-robinhood-venue.md](08-robinhood-venue.md)。
- 失败隔离：单个场所落后或失败，不得把整张看板打空。
- 公开 RPC 不得当作验收主源，只能标 `public_temporary`。The Graph API 密钥只放服务端环境变量；缺密钥时必须明确失败，不得悄悄改走公开非官方网关。
- Uniswap 文档里的 Explorer subgraph ID 是示例，不是 Labs 生产部署。未确认前不得写成官方 ID。Pancake 开发者 subgraph 页上的 ID 可作为 Pancake 官方来源。

## 当前路径（占位适配器已按统一目录落地，场所尚未启用）

| 链 | 协议 | 计划 ingest | 说明 |
| --- | --- | --- | --- |
| Elysium | Uniswap V3 / V4 | self_built | 已启用。归档 RPC 自建小时档；V4 走官方 StateView。 |
| BSC | Pancake V3 | official_index | 启动 BSC 时的第一批。官方 Exchange V3 subgraph（1h + 1d）。 |
| BSC | Uniswap V3 | self_built | 未发现 Labs 生产索引；默认同自建小时档。 |
| BSC | Pancake Infinity / Uniswap V4 | not_started | 后续再按当时官方协议单独写适配器。 |
| Ethereum | Uniswap V3 / V4 | official_index | 优先 Labs 或官方自托管 subgraph；生产 ID 尚未确认。 |
| Base | Uniswap V3 / V4 | official_index | 与 Ethereum 相同。 |
| Base | Pancake Infinity | not_started | 已列入，轮到再写。 |
| Robinhood Chain | Uniswap V3 / V4 | self_built | The Graph 目前仅 Substreams，无官方托管 subgraph。专用说明见 [08-robinhood-venue.md](08-robinhood-venue.md)。2026-11-14 已授权启用并生产拉数，实现按该说明填充。 |
| Solana | Meteora DLMM / Raydium CLMM / Meteora DAMM V2 | not_started | 轮到再写。Arbitrum 不进正式清单。 |

## 适配器目录结构

一场所一个适配器模块，路径固定为：

`src/adapters/venues/<chain>/<protocol>.ts`

文件名把协议 id 中的下划线改成连字符，例如 `uniswap_v3` 写成 `uniswap-v3.ts`。不要另起第二套目录树。共享辅助函数留在 `src/adapters/` 根目录（如 `official-index.ts`、`abi.ts`、`blocks.ts`），不要大批量搬家。

每个场所文件必须导出同名的 `venueAdapter`，类型见 `src/adapters/venue-adapter.ts`：

- `chain`、`protocol`、`status`、`ingest`、`policy` 与目录和政策一致
- `kind` 只能是 `"ready"` 或 `"placeholder"`
- `assertCanRefresh()`：已启用且 ready 的适配器可以返回；占位适配器和未启用场所必须抛出明确中文错误，说明该场所尚未启用、不得拉取生产数据

注册表在 `src/adapters/registry.ts`，由 `src/adapters/venues/index.ts` 汇总全部适配器。目录里的每个场所必须恰好有一个适配器，每个适配器也必须在目录中。已启用场所必须是 `kind: "ready"`，已列入但未启用的场所必须是 `kind: "placeholder"`。`refreshableVenueBindings()` 只返回已启用的 ready 适配器；占位适配器不得进入默认刷新。

未启用场所必须先有占位文件，再允许后续填充。占位文件调用 `createPlaceholderAdapter(chain, protocol)`，保持短而一致；每个场所仍要有自己的文件，不要把全部占位收进一个大模块。Elysium Uniswap V3 / V4 是目前唯一的 ready 适配器，实现位于 `src/adapters/venues/elysium/`；旧路径 `src/adapters/uniswap-v3.ts` 与 `uniswap-v4.ts` 仅作再导出，方便遗漏的 import。

## 如何新增或真正接入一个场所

1. 在 `src/shared/catalog.ts` 列入场所（先 `listed_not_implemented`）。
2. 在 `src/shared/venue-sources.ts` 写明 ingest、官方窗口、合约地址、环境变量和下一步注意事项。官方地址放 `src/shared/deployments.ts`。
3. 在 `src/adapters/venues/<chain>/<protocol>.ts` 建立占位适配器并导出 `venueAdapter`，同时挂到 `src/adapters/venues/index.ts`。注册表必须保持与目录 1:1。占位适配器必须在场所启用之前就存在。未启用前不得把占位改成 ready，也不得接入默认刷新。
4. 填充占位时，只改该场所文件（及它真正需要的共享辅助函数），不要新建平行适配器目录。官方索引场所扩展 `src/adapters/official-index.ts` 的映射，不要新建平行客户端。自建场所沿用 Elysium 的小时档扫描模式。
5. 计算与展示层保持不动，除非刷新范围已经按目录过滤这种最小钩子。
6. 标准宣布启用后，才把状态改为 `enabled`、把适配器改为 `kind: "ready"`，并接入默认刷新。第一期验收通过前，不得开工后续链的生产拉数。2026-11-14 用户确认的例外：仅 Robinhood Chain 的 Uniswap V3 / V4 可在 Elysium 验收完成前并行生产拉数，规则见 [08-robinhood-venue.md](08-robinhood-venue.md)。其他已列入场所仍不得提前启用。

填充或启用 Robinhood Chain 时，必须同时遵守 [Robinhood Chain 场所接入说明](08-robinhood-venue.md)。该说明已于 2026-11-14 记录用户的启用决定。

## 本地缓存过期清理

本地 SQLite 只是分档缓存。小时级 `window_aggregates` / `scanned_hours` 设计改为保留 4 天，拉数也限制在同一窗口。按看板同一时钟（优先 lastSuccess / 刷新 `block_time`）对齐到整点后删除更早的行。4 天不足以覆盖当前和上一段 3 天；上一段缺档时环比留空，不影响当前可计算指标。刷新日志按同一截止时间清理，但必须保留最近一次成功刷新。不得为省空间删除 `pools` / `tokens` / `meta`。本期不实现 30 天日档归档。清理在每轮刷新记账结束后执行，可重入跳过，幂等，且不得让刷新因清理失败而失败。


## 统一主资产报价与场所采集分工

2026-11-16用户已确认的报价合同见[方案13第9/9.10节](../05-operations/13-dollar-valuation-repair-review-2026-11-16.md#9-统一报价层落地设计本轮方案正文)，取代此前Alchemy作为主源、Hyperliquid作为主源及10分钟有效期的调查建议；原文相关旧计价描述只说明旧生产状态，不作本次实施规则。2026-11-16用户追加授权停采集更新后恢复，RedStone代码与迁移012已部署，17:08补丁加载至API27116；包装映射、完整保留期及本轮真实验收已核，未恢复记录和精确费用限制保留；唯一进度见05-roadmap“美元计价修复”。

- 在现有四层内实现统一报价能力，不另起服务/扫描管线。主源RedStone Push，两条已启用业务链共用ETH/USD、HYPE/USD；报价按资产＋来源＋目标时间共享，池状态、目录及游标按链隔离。各链采集RPC维持实际配置，本方案不自动迁移到Alchemy；Alchemy Prices API仅可选适配，本期不接Chainlink备源，不假设备源资产覆盖对称。
- 接受Push心跳/偏差的最新有效价，如实记录publishedAt；不要求每轮五分钟新价，不混用早期10分钟有效期与六小时心跳，不靠加频读取刷新预言机。源链历史块必须block.timestamp <= targetAt，报价publishedAt也不晚于targetAt；五分钟桶命中仍核时间，禁止跨链套区块号、未来最近块和当前价回填历史。
- 仅已验证1:1包装的WETH/WHYPE同价；本轮仅核定Elysium官方WHYPE和Robinhood官方WETH（地址及相同运行代码证据见13第9.12节），其他映射未启用；同名币、质押衍生币及任意桥接币不得自动串价。根价先锁定，池推导不得回写，同一计算内原生/包装引用同一值。
- 复用原币累计及repair-hour按小时重建价格表，重估旧版本非空错误金额，不重拉全部Swap、不统一倍乘。TVL仍依赖业务链历史储备；修复不得覆盖较新续接，失败保留旧值及旧计价版本。金额、来源引用/计价版本、链发布版本沿小时事务提交。
- 报价失败不得阻止原币成交、费用和覆盖提交；美元缺失不补0、不把陈旧金额标成当前完成。价格使用独立超时与请求资源，不继承360秒日志等待，有限尝试后快速结束，不与日志或另一资产互相阻塞。关闭新报价不得静默恢复已证实错误的旧多跳为正确值。
- 不改变费用算法、窗口、保留期、准入、前端布局或未启用场所。实施/部署授权与文档合同确认分开记录，不因本节写入就标记代码或金额验收完成。
