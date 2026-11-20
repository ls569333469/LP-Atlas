# 零手续费核查（2026-11-12）

2026-11-13 最新处理决定：用户确认暂缓跨 tick 精确复算；无法正常获取证据的三类 Hook 独立分配不再追查，也不再阻塞本轮采集修复验收。下文调查结果和未验证结论保留为证据范围，不能理解为继续执行要求。现有核心 LP 费用采集、统一 1H 手续费 ≥ $10 准入不变，未知独立收益不计入。

用户后续纠正：撤销费用修复时额外加入的「估算」「已确认」「待核验」前端展示和对应表格说明，缺失值恢复显示「—」。下文标签描述为当时验证记录，当前展示以此纠正为准；后台费用修复保留。

范围：用户截图内 16 个有 TVL、有成交而手续费为 0 的 V4 池，以及同类历史数据。查询使用 Elysium 官方公开 RPC，仍属于临时联调源。不能把局部抽查当成整期验收。

## 已发现原因

1. 当前采集只解析 PoolManager Swap，未适配 Hook 独立收费与收益分配。交易费为 0 与 Hook 收费同时存在，不能把后者未经归属验证计为 LP 收益。
2. V4 输入方向解析错误：应是负数输入，旧代码复用了 V3 正数输入。此错误影响非零费交易的计费币种和金额；不是截图中 fee=0 的直接原因。
3. 旧小时档没有费用可信度，零、未采集和估算混在一起。已结束的不完整小时也会参与窗口合并，缺口不够明确。

## 链上证据

截图金额可对上库内 14:00 起两档（15 点档仅扫描至 15:05:16）；对照区块 5172197–5198602。保存逐池 id、事件数量、事件费率、StateView feeGrowthGlobal 两币累计值：`outputs/fee-investigation/screenshot-audit.json`。该证据只覆盖这段区块，不推广到所有历史或未来交易。

逐项复核文件合计为 **400 条 Swap 事件，其中 399 条非零成交**（不是交接摘要中的 499 条）。16 池的事件 fee 均为 0，区间前后两个币种的 feeGrowthGlobal 均为 0。16 池全部带 Hook：`0x6b12…f8EC` 9 个，`0xe0dE…a8eC` 6 个，`0x4CAc…c5C7` 1 个。因此本批可以确认核心 LP 费用未增长，但不能把尚未核验的 Hook 收益当成已确认的总收益为 0。

- HYPE/BTRFLY，交易 `0x01d921087139c9b0ddc3a7e806a18e98679ee1ad1a17b18b13fbf232be0c30fa`：14:41:56，Swap fee=0；PoolManager 给 Hook 铸记 0.002585215890185484 HYPE 的 ERC-6909 claim。
- WHYPE/POCKET，交易 `0x6e35b93fcea66ffcfc1cec316b3e14c41ec07fd53cf60badc43ce6f4315acf58`：14:01:59，Swap fee=0；Hook 获得 0.001391569243851975 WHYPE 的 ERC-6909 claim。
- 上述两池区间前后 feeGrowthGlobal0/1 均为 0：已观测的核心 LP 费用累计没有增长，不是简单漏算一个非零 Swap fee。
- Hook `0x6b12…f8EC` 有可读的 `pendingCreator`、`pendingProtocol`、`recipientOf`；`0xe0dE…a8eC` 有 `creatorOwedQuote`、`STAKERS_BPS`、treasury 等接口。选择器数据库仅作寻找接口的线索，成功读值不等于完成源码验证，不足以证明全部收费最终归谁。状态样本见 `outputs/fee-investigation/hook-state.json`。

Uniswap 官方源码依据：`v4-core/src/libraries/Pool.sol` 的 swapDelta 输入为负、输出为正；PoolManager 将该 delta 原样写入 Swap。手续费在 swap step 中取整，因此只用事件金额乘实际 fee 仍是重建估算，不是逐步精确重放。

## 尚未解决

### 继续调查授权与请求规则

用户已授权继续调查三个 Hook 的独立收费及分配，并修正源码调查请求处理。源码调查为旁路，不把浏览器页面当行情真源，不并入每 30 分钟扫描的关键路径。按链、Hook 地址与部署代码标识复用结果，不按每个池重复请求源码。

普通 HTTP 429 尊重 Retry-After；没有该字段时有限指数退避。Vercel Security Checkpoint 单独识别为访问受限并停止自动重试；404 记录为未找到而非网络故障。连接超时与 HTTP 错误分别记录，限制单次时间与总次数，不通过更换身份绕过安全检查。源码下载成功不等于已验证，仍需对齐部署字节码和分配路径。下述工具仅支持调查，不改变现有费用可信度或生产采集口径。

- Hook 合约源码和分配路径未验证。Sourcify 当前没有这些地址的验证结果；链上 metadata 的 IPFS 拉取超时；官方区块浏览器返回 429。不得把同名或相似开源 Hook 当成已部署版本。
- 非零手续费需历史协议费和逐步取整对账，修正方向不能替代此验收。
- 生产归档 RPC 仍缺；远程 Cursor 项目标准本次访问返回 403，本地标准先记录用户本轮要求，未声称远程已同步。

权威完成状态维护在 `docs/04-standards/05-roadmap.md`。

## 面板修复与验证

费用状态已随 SQLite 小时档、窗口合并、API 和页面传递。未知的手续费、APR、手续费环比返回 null，页面显示「待核验」并解释原因；已确认无 Hook 且固定 LP 费率为 0 的池保留零值；事件重建标为「估算」。极小正数显示 `< US$0.01` / `< 0.01%`，不再舍入成零。旧 V4 档保留原始值并由现有扫描管线逐档重算，没有用当前值批量覆盖历史。

本机 API 在截止 2026-11-12 16:53:44（北京时间）的 1h 默认过滤结果中有 112 池：14 个估算、96 个 Hook 待核验、2 个确认核心零费。后两池为 HYPE/CLU 和 HYPE/SENT；有成交且无 Hook、固定 LP 费率 0。96 个待核验池的手续费和 APR 均为 null。浏览器实际载入后，HYPE/KNTQ 的无 Hook 0.3% 池显示估算金额，带 Hook 池显示待核验。该快照仅是当时的验证结果，不是长期数量。

93 项测试通过；补充协议状态缺失用例后定向 9 项回归及 Biome、前后端 TypeScript 检查通过。检查覆盖 V4 真实日志输入币方向、协议费扣除、存储、窗口合并、全局排序、缺档与页面格式；不能代替 Hook 源码与分配验证、历史逐步精确计费和生产扫描验收。

## 继续调查结果（2026-11-12）

### 请求故障已经分清

- 官方浏览器脚本请求返回 429，正文是 Vercel Security Checkpoint，没有 Retry-After，不能推断官方 QPS。正常浏览器可打开三个地址，但 Contract 页全部明确显示 `Contract source code not verified`。这纠正了早前把 429 简称为限流的表述。
- Sourcify v2 三地址返回 404，match / runtimeMatch / creationMatch 为 null。不是重试未成功，而是该服务未找到验证结果。
- `0x6b12…f8EC` 的 metadata CID 为 `Qma1B59tc6xfTSXESvQqWeqFtEiuseptwbadNatHps8kq6`；`0x4CAc…c5C7` 为 `QmZ6o3Z6t3JK8rP3raJqEN5Fxqe571A5ZYNe2B4STD1rkp`。`0xe0dE…a8eC` 的 CBOR 尾部只有 solc 版本，没有 IPFS CID，不能靠延长 IPFS 超时获取它。
- ipfs.io / dweb.link / filebase 的命令行请求连接超时，Pinata 超过请求时限；正常浏览器访问 ipfs.io 停在安全验证。不能据此认定 CID 内容不存在，也没有绕过验证。
- 公共 RPC 的 `debug_traceTransaction` 对两笔样本均返回 HTTP 401、RPC code -32401、`authenticated API key required for method`。这是权限要求，不是限流。历史 eth_call 与回执仍可用。

调查 HTTP 实现为 `src/adapters/source-http.ts`：最多 3 次、每次 15 秒，普通 429/5xx 按 Retry-After（秒或 HTTP 日期）等待；无有效值时 1/2 秒退避。超过 10 秒的服务端冷却直接返回等待时间，不缩短后抢跑。401/403、安全检查和 404 不重试。网络错误保留原因。没有把这些研究性请求加入生产扫描，也没有调整 RPC 的既有 400/800ms 策略。

可复用核查入口：`node_modules/.bin/tsx outputs/fee-investigation/check-sources.ts`。源码结果以 chainId + Hook 地址 + 保存的代码哈希缓存 1 小时，避免按池重复查询。本轮另以 eth_getCode 核对三个保存的部署字节码均与当前链上相同，见 `code-recheck.json`。工具缓存不代表源码已验证，代码更换后应先更新链上字节码样本。首次请求与缓存复用均已执行；三个未找到与浏览器访问受限均只请求 1 次。源码 HTTP 的 3 项定向测试、Biome 与服务端 TypeScript 通过。

### 三类 Hook 的链上证据

| Hook | 本轮查到 | 不能据此推断 |
| --- | --- | --- |
| `0x6b12…f8EC` | HYPE/BTRFLY 样本块 5189185 中，此池只出现 1 条 Hook 收费事件。前后 eth_call：pendingCreator 从 0 增至 1551129534111291；pendingProtocol 从 0 增至 1034086356074193；合计 2585215890185484 wei，恰等于 Hook 获得的 claim。比例约 60% / 40%。另有 collectProtocol 样本真实 ERC20 Transfer 到 protocolVault 地址 `0x775f…Fa68E` | 函数名仍来自选择器线索；该笔记账支持创建者/协议分配，不能当作所有池、所有历史、所有配置分支均已验证，更不能把 Hook 全部收费加入 LP APR |
| `0xe0dE…a8eC` | WHYPE/POCKET 样本 Hook 获得 1391569243851975 wei WHYPE claim，creatorOwedQuote 前后为 0。独立抽样另一池交易 `0x09964b…b5f3` 出现 Hook 向 PoolManager 转入 WHYPE 及独立 Hook 事件 | 入 PoolManager 可能对应兑换、加仓或其他结算，不能仅凭转账判为 LP 分红。未知事件字段尚未赋予确定业务含义。另一池样本不冒充截图池的分配证明 |
| `0x4CAc…c5C7` | 截图区间读取 4 条 Hook 事件。HYPE/KNTQ 样本 `0xb6feb8…1c96` 事件末字段为 272213436239130171 wei（约 0.272213436239130171 HYPE）；该块 feeRecipient() 返回 `0xaf38105c15617aacbb15a5349a95f874a9d4692d`，getFeeConfig() 可读 | 未验证 ABI 的事件字段不能直接命名为最终 LP 费用；本样本为原生币方向，ERC20 Transfer 不证明原生币转账，需要调用追踪与源码确认实际收款及后续去向 |

原始证据在 `outputs/fee-investigation/`：`historical-fee-deltas.json`、`sample-block-hook-events.json`、两笔 `eth_getTransactionReceipt` 与 `debug_traceTransaction`、`protocol-withdrawal.json`、`kntq-hook-events.json`、`kntq-fee-config.json`、`kntq-sample-receipt.json`、`cohort-event-samples.json`、`cohort-distribution-receipt.json`。

结论：池与成交已匹配，缺的是 Hook 的完整计费及受益人语义。继续完成需要与部署字节码对应的源码/ABI，或先配置支持目标历史区块交易追踪的认证 RPC 后补齐转账和状态变化证据。仅有普通 RPC key 不保证支持 debug trace，需核对供应商套餐与方法。没有足够证据前不升级这些 Hook 的费用可信度；本轮不声称全部分配路径已查清。
