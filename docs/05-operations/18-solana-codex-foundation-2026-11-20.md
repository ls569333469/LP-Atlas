# 18 · Solana 官方 API 主源接入与统一看板方案

2026-11-22最新复核入口：[19 · Meteora DLMM 指标补齐与问题复核](19-Meteora-DLMM指标补齐与问题复核-2026-11-22.md)。用户要求先整理费用、APR、环比、价格、资金效率与剩余加载问题，交Grok复核；本轮不继续修改产品代码或部署。19为补充材料，未核建议不替代本方案已确认合同，状态仍以05唯一执行清单为准。

初稿：2026-11-20；本次修订：2026-11-22，Asia/Shanghai。现行方案见第0/12节，S0–S3字段复核及生产收尾见第13节；原基础交接、S0/S1及历次证据保留历史归属。方案更新不等于新代码已实施或生产已启用。

## 0. 当前执行口径（2026-11-22）

- **选型已确定**：本期 Meteora DLMM 以有正式文档的 `https://dlmm.datapi.meteora.ag` 为唯一主要采集源，使用 `/pools`、必要时单池详情、`/pools/{address}/volume/history`。不叠加官网未文档化的 pool-discovery API，不抓页面入库，不采购付费历史账户服务作为启动前置。
- **用户已确认的首期结果**：在现有多链页面展示满足 TVL≥$1,000、1H成交≥$100 的 Solana 官方候选；LP手续费、fees APR 未完成归属验证时留空，不要求候选先满足 LP费≥$10。EVM两链原三项准入、计算和排序保持。六窗口仍为1H/2H/4H/6H/24H/3D，有哪些已覆盖小时就计算哪些，缺窗留空，不隐藏整行。
- **小时档仍是唯一记账基础**：每5分钟更新当前小时累计，同小时覆盖写入；长窗口统一从同源小时档累加，不把滚动1H替代整点1H，不拼接上游2H/24H汇总。列表滚动量只用于发现粗筛及诊断。
- **撤销旧阻塞的适用范围**：历史TVL/原币/价格边界缺失，不再阻塞官方美元候选展示；未核源finality与普通LP费用，不再阻塞成交/当前TVL展示，但仍不得伪称链上精确收益。历史逐笔重建、SOL独立根价和精确LP收益属于后续增强。
- **调查与S3代码已完成**：研究依据见12.2，实施与隔离验收见12.9；正式适配、同表发布及页面已接通，开关缺省仍关闭；本轮用户授权部署后已在运行配置显式开启。此前291项离线结果不代替本次新路线验收。
- **本轮交付**：先按用户要求修订方案，随后按S3执行授权更新代码并完成隔离联调；随后用户授权推进部署：已迁移运行库014/015并启动三链自动采集，EVM节点保持；生产观察进行中。实施状态只维护 [05唯一执行清单](../04-standards/05-roadmap.md#方案18--meteora-dlmm-官方-api-主源2026-11-22)。
- 本期只接DLMM；DAMM V2虽做字段研究，仍暂缓；Raydium独立推进，BSC、方案16、钱包和交易不动。完整合同与待改模块见第12节。

## 0A. 原基础交接的范围与证据说明（历史）

> 下文第1–11节、旧S2追加记录保留各自时点的审计证据。与第0/12节冲突的“必须先买历史状态/先核全部费用才可展示候选”“official_usd尚未获准”等句不再是本期执行门；身份、原币精度、禁止填假0、费用不得冒充LP收入等约束继续有效。不要把本次五个费用样本升级为全模式通过。

先读这页：已知、建议、阻塞分开

> 2026-11-21（Asia/Shanghai）实施边界更新：用户明确授权 S0/S1 在助手独立 checkout 离线实施、测试。下列“本轮仅MD”等句均保留为11月20日复审历史，不是永久开发禁令。不含S2采集/新报价源/API破坏性升级/部署/扫描，原始证据仍未独立复现。实际结果见本轮交接，不将计划表的待执行项自动改为通过。

- **用户已决定**：优先 Solana，BSC 暂不动；我们先做好基础，由用户的 Codex 延续基础更新代码。用户随后要求核实 Codex 的八项审计。这里没有替用户批准 API 破坏性升级、报价新供应商或生产扫描。
- **授权纠偏**：方案17第12节“其余条款在未另行反对前，按本文执行”不能作为授权依据。沉默不是批准。本包所有新类型、迁移路线、源选择都是**建议，待 Codex 技术审核、修订标准**；破坏旧接口、切库/重启部署、生产启用要明确确认，不必把每个内部函数都重新问一遍。
- **基础稿已完成**：少量关键文件只读复核；Grok报告两个Meteora DLMM代表池的四天小时/端点边界有界探测；费用/报价规格核对及迁移/验收草案。**本轮复审仅增量更新本机18、只读核对相关代码，没有新API复现。**
- **本轮范围**：仅获准编辑本机本文件18；不改产品代码、17、16、BSC、开关、服务/定时器，不复制仓库/checkout、不读取.env、不安装SDK/插件、不跑产品测试或扫描、不对外发消息。
- **目前不能进排名的门**：Datapi `fees` 的普通LP归属尚未证明；历史TVL/价格/原币字段来源不齐；源截止与 finality 不透明。可以先做公共底座和离线 fixture 开发，**不能把这些缺口填0后宣布 DLMM 已接通**。
- BSC、DAMM V2、Orca、钱包/开仓、自动发送、方案16全部不动。

### 本机文件与助手侧证据：不是本地齐套交付

1. 用户本机仅保存本文件18正文。原始样本、requests.json、manifest-sha256.json、SHA256SUMS.txt、probe-analysis.json、boundary-comparison.json、dlmm-*.json以及SDK/网页摘录仍在助手侧 /workspace/docs-out/solana-foundation-evidence/，未随本文落本机。
2. **全文样本/manifest/证据文件名均指助手侧材料，不是用户仓库内已存在的相对路径，不表示Codex已取得、校验或复现。** 用户明确只要MD，本轮不传ZIP、不复制证据。可按本文官方URL查规格；若需原始返回独立审计，仍待取得或有界复现，不把本地manifest当接手前置已满足。
3. 保留查询参数、数字及有限结论作为Grok报告，Codex尚未独立复现边界1秒金额变化。Codex遇403仅说明访问受阻，既不证伪也不证明该结论；本轮无新API复现，不能声称双方验收或本机证据齐全，更不能据此启用生产。
4. 17与事实包是背景，冲突点建议后续修订；本轮不编辑17/16。身份/存储审核可继续，费用归属、源覆盖/封口等依赖真实源语义的验收门仍未通过。

---

## 1. Codex 八项审计：独立核验结论

| # | 结论 | 具体证据与应落合同 |
|---|---|---|
| 1 小时接口不够整张看板 | **成立** | 官方 `historical-volume.md` 和Grok报告的两个池历史记录，仅有 `timestamp,timestamp_str,volume,fees,protocol_fees`。无历史TVL、原币数量、swapCount、起止价格。见 `meteora-history-doc.md` 与 `dlmm-*-history-96h-boundary.json`。当前TVL不能倒填历史；不存在的原币值不能记0；详见第4节逐字段表。|
| 2 归档交易≠历史账户状态 | **成立** | 官方 `https://solana.com/docs/rpc/http/getaccountinfo` 参数只有地址及 commitment/encoding/dataSlice/minContextSlot，**无任意历史slot选择器**。`minContextSlot` 仅最低求值上下文，不是“读取该slot快照”；`context.slot` 是响应上下文。历史交易服务、历史账户快照服务、交易重建是三种能力，要分别验。普通 archive RPC 标签不能担保小时边界储备。|
| 3 同小时官方累计应覆盖upsert | **成立；实现需更细化** | `/volume/history` 明示 `[start_time,end_time]` inclusive；Grok报告的历史探测中整点端点带末端额外桶。按链＋协议＋池＋小时＋来源/版本幂等覆盖，不能每5分钟把同小时返回再相加。必须保存可证的截止/完整性，HTTP 200不等于整小时完整，晚到修订不得静默丢弃。|
| 4 分账不可只总费减协议费 | **成立；API字段仍待证** | `meteora-formulas.md` 明示MM与limit-order切分、MM LP、LO participant、protocol remainder、host。官方IDL `Swap2Evt` 分列 `mm_fee,protocol_fee,limit_order_fee,host_fee,fees_on_token_x`。**这不能反推Datapi `fees` 的定义**。Raydium `raydium-clmm-fees.md` 明示实际AmmConfig、动态费和CollectFeeOn。详见第5节。|
| 5 字符串身份迁移需旧链兼容 | **成立；具体迁移为建议** | 本次只读真实仓库：`TokenRef.chainId:number`、`BoardRow.chainId:number`；存储类型仍整数；目录Solana的 `evmChainId:null`。`poolIdentity` 已是 `JSON.stringify([chain,protocol,poolId])`，保留大小写。不能全局替换 `toLowerCase()`，也不能直接重写EVM旧主键。见第3节。|
| 6 稀疏存储不能省出假缺档 | **成立** | 是数据覆盖逻辑要求：省略“已确认无成交”与“没有采到”若都映射无行，后续无法区分。需要覆盖账本及其明确适用池集合。官方当前列表全发现≠历史小时全覆盖；不为所有池机械造0行。详见第7节。|
| 7 报价/Token2022/Q96问题 | **成立；可接受源政策待审核** | 历史API美元字段未给价格来源/版本；不得冒充方案13本地估值。Solana官方TransferFeeConfig扣款是转账费，不是LP收入；Raydium数学文档是 `sqrt_price_x64` Q64.64，不是Uniswap Q96。来源见第6节。|
| 8 请求容量与200ms | **容量批评成立；“无官方证据”已补证** | Meteora官方30RPS不代表可每5分钟遍历全目录。需要池数×请求×回访预算。`https://solana.com/upgrades/reduced-slot-times` 官方现页明确 Updated October 2026、epoch1053、2026-10-09主网200ms（由400ms降至）；此前基础研究阶段父级已独立读取官方全文；本轮未重新访问。**不撤回已补证的200ms说明，但撤回由目标slot时间直接推定吞吐、成本或容量通过的含义。** 实际slot/块/请求量须测。直接下载此页遇429，失败响应不是网页证据，WebFetch摘录单列说明。|

**第123行额外意见：成立。** “完整小时加总”只适用于**同口径、非重叠、已覆盖的成交量及归普通LP费用**。TVL是时点量不相加，价格取边界不相加；APR按选定窗口费用、适用时长、TVL口径重算，不相加/不平均官方APR。协议覆盖或计价不兼容时连成交量/费用也不能强加。

---

## 2. Grok报告的有界历史探测：Codex尚未独立复现

本节数字、参数和有限观察保留为Grok于2026-11-20报告的历史探测，不升级为Codex独立复现或双方验收。本轮没有新API请求，原始返回/哈希清单在助手侧未落本机；以下实测、重复、连续等字眼均受此证据归属限制，样本覆盖不等于全站保证。

### 2.1 样本选择与成本

只对 `https://dlmm.datapi.meteora.ag` 发少量GET；两个发现查询各最多5条，未翻全站、未运行扫描。每次超时18秒、响应上限900KB；探测无无限重试。请求精确参数/时间见 `requests.json`。

| 代表性 | 实际池地址 | 实际说明 |
|---|---|---|
| 原生币包装＋稳定币 | `5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6` | SOL-USDC。精确比对mint集合，不只按symbol：WSOL `So11111111111111111111111111111111111111112`、Circle USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`。|
| 活跃长尾 | `7qZPiJ2Lvwh9DV9gUBH2EwConBE3RUrAvGRjpN8vTjtT` | API名称TTWO-SOL，从前5个24h活跃池取非上述mint组合、TVL>1000样本。只是现场代表池，不是池安全/官方标的背书。|

探测时钟：2026-11-20约13:20起（上海），`H=1795150800`，即**上海13:00**时钟小时起点。内部按Unix/UTC对齐；下文显示时区为上海。

### 2.2 Grok报告的四天标签连续性：未独立复现、不是全站保证

对每个池请求：

```text
GET /pools/{pool}/volume/history
  timeframe=1h
  start_time=1794805200  # 上海11月16日13:00
  end_time=1795150800    # 上海11月20日13:00，端点包含
```

- 两池各返回**97行**：前96个整点标签恰为期待四天范围，末端另有H标签；无重复标签、无期待标签缺失。
- 过滤到规范区间 `[H-96h,H)` 后，各有96个**候选**小时记录；这足以证明该请求范围没有被接口硬性截为一天，**不证明金额、indexer finality或小时实际覆盖已验收**。
- 历史接口OpenAPI未列 `page/page_size/cursor`，本次响应也未给分页游标。这是“该端点无文档化分页，样本四天可一次取”，不是“历史永远不限长”。发现列表 `/pools` 才是分页端点。
- 不带start/end、仅 `timeframe=1h` 的SOL-USDC样本返回10个标签（上海04:00到13:00）。**不能把这个默认长度硬编码成服务保证**；生产必须显式界定范围、检查返回范围与缺口。

### 2.3 关键新发现：不能习惯性把 end 写成“整点减1”

同一SOL-USDC池、同一个上海11:00标签，现场结果：

| 请求 | 标签 | volume | fees | 解释 |
|---|---:|---:|---:|---|
| start=1795143600,end=1795147199 | 上海11:00 | 4777.67320142552 | 2.620071369742295 | 响应start/end都归到11:00，返回1行；**不能认定是完整11点小时**。|
| start=1795143600,end=1795147200 | 上海11:00 | 1064262.3261313129 | 444.9549993301968 | 多1秒的查询同时返回12:00标签0行；11:00数值发生巨大变化。|
| start=1795140000,end=1795150800 | 上海11:00 | 1064262.3261313157 | 444.95499933019687 | 11:00作为内部桶时与整点end查询近似一致，差为浮点精度级。|

Grok报告其重发minus1与exact后差异可重复；Codex尚未独立复现。四天minus1版本与整点版本比较，两池均是最后一个候选小时出现实质差异；SOL-USDC上海12:00桶从0变为569054.3381809553成交量。详见 `boundary-comparison.json`。

**有限结论**：timestamp 是整点桶标签，行为与“桶起点＋末端桶按查询端点截取”相容；官方文字没给每一边界细节，不能宣称原因已经完全定位。`end=hourEnd-1` 在本次接口上**不安全**。推荐显式请求到下一整点、丢弃终端标签，以稳定内部桶做封口候选，再做重叠一致性检查；此规则仍待Codex样本回放与上游语义核验后写标准，不是现在上线的修复。

### 2.4 当前小时：有局部数据，但缺真实源watermark

- SOL-USDC请求 `[H,探测now]` 返回H标签**全0**；请求 `[H,H+3600]` 返回H标签 `volume=305231.4509657971,fees=114.75584750813977`，另带未来整点标签0。
- 活跃长尾请求 `[H+60,探测now]` 返回H标签 `volume=418.45281770791695,fees=0.3813087505634663`。
- 这说明**当前小时有局部值、返回受请求边界影响**；不能把某次0当“当前整小时无成交”，也不能把未来end当真实数据截止。
- API没有给这些行的finalized slot、last indexed transaction time或完整水位。`retrievedAt`仅是抓取时间，参数end不是实际源asOf。当前小时一律 `complete=false`；源截止未知就单列unknown，不能假称截至now已完整。
- **禁止**列表滚动1h金额充整点历史、相邻滚动窗作差硬还原、在请求包含当前小时后当整小时封口。不得把API响应中补齐的0直接视为逐笔覆盖证明。

这两个池的样本，只是字段/区间行为证据；没有全站池发现、吞吐或金额验收。

---

## 3. 公共身份与存储迁移草案（建议；不是已批准的API破坏升级）

### 3.1 当前真实合同锚点

2026-11-20本次只读复核了用户机器 `D:\Axiangmu\LP Atlas` 的关键文件，未复制仓库，未读取运行库或`.env`：

- `src/shared/catalog.ts:59,97-99`：链`solana`、`evmChainId:null`，DLMM/CLMM/DAMM V2均listed。
- `src/shared/types.ts:47,74`：TokenRef、BoardRow仍 `chainId:number`。
- `src/store/types.ts:7,20,69`：StoredPool/Token/ScannedHour仍整数链号；createdBlock/fromBlock/toBlock仍EVM措辞。
- `src/shared/pool-identity.ts:1-4`：已有 `JSON.stringify([pool.chain,pool.protocol,pool.poolId])`，保留大小写。
- `src/shared/venue-sources.ts:306-336`：Solana `not_started`、空env/合约；备注还误写“五个窗口”。
- `src/store/migrations/002_venue_keys.sql`：token主键 `(chain_id,address)`；前轮已读001中pools以`pool_id`单列主键、小时行按`pool_id,window_start`。
- **没有全面重审repositories/refresh-pipeline及所有消费者，未读实时数据库结构。** 本轮仅按需核对API、迁移器、目录缓存/发现meta游标及延期回访；其余约束、数据与消费者仍待Codex复核，不能宣称兼容已通过。

此前锚点SHA记录在助手侧 repo-readonly-anchors.json，未附本机，不能当本地已核验附件，也不是commit；本轮新增代码证据直接记在下文，行号对应本次读取版本。

补充现场锚点：src/web/src/api.ts:74已实际调用/api/v2/board；src/store/db.ts:40执行executeMultiple(sql)，41–44再独立INSERT schema_migrations。现有v2兼容及结构/版本登记原子性不能被默认跳过，详见3.3–3.6。

### 3.2 建议规范类型（仅草案，不是可部署源文件）

```text
ChainRef = { chain: string /* catalog id */, evmChainId: number | null }
PoolRef  = ChainRef + { protocol: string, nativePoolId: string }
PoolIdentity = JSON.stringify([chain, protocol, nativePoolId])
TokenRef2 = ChainRef + { address: 原样字符串, decimals: 整数,
  tokenProgram: SPL | TOKEN_2022 | NATIVE | EVM,
  extensions: 已解码版本化列表, metadataStatus }
PriceState =
  { kind: evm_v3_v4, sqrtPriceX96: 十进制整数字符串, tick, ... }
| { kind: solana_dlmm, activeBinId: 有符号整数, binStepBps, ... }
| { kind: raydium_clmm, sqrtPriceX64: 十进制整数字符串, tick, tickSpacing, ... }
NormalizedPrice = { quote: token1_per_token0, value: DecimalString,
  token0Decimals, token1Decimals, atUnix, source, sourceVersion }
```

- Base58验证：只允许Base58字母表，解码**恰好32字节**，重新编码与原文完全相同；不靠长度44正则，不转小写。mint/池/PDA不要求都在Ed25519曲线上（PDA可off-curve）；“32字节合法”不等于该账户是mint/目标程序池，继续核owner、discriminator/布局、mint decimals、网络。
- 交易签名是另一类型：Base58解码64字节；不能复用32字节pubkey校验。
- EVM地址规范化保留现有已验证规则；只在链分派后处理，不能删掉全项目 `toLowerCase()`，也不能把Base58送入它。
- DLMM的bin step不是tickSpacing，Raydium的x64不是x96。归一层给公共价格，原生编码留协议分型，不给DLMM造sqrtPriceX96。

### 3.3 增量迁移路线（保留旧EVM池主键）

**推荐走兼容扩展，再切换读写；不推荐一次破坏性全替换。** 要经Codex核实时表与全部索引后实现迁移，不能编辑已应用001/002：

1. 预检：列出实际schema、索引/外键（即便没有声明FK也查逻辑引用）、迁移版本、表行数、重复pool id、未知整数chain_id、可用磁盘、DB+WAL/SHM。检查备份/恢复所需空间；不在生产直接做实验。
2. 先给tokens/pools/scanned_hours及引用它们的发布/报价/修复身份添加 `chain_key` 字符串；只按既有目录映射99901→elysium、4663→robinhood等已知值，未知值终止迁移，不能猜测Solana数字哨兵。
3. EVM现有 `pools.pool_id` 作为**内部物理主键完全不变**。另存 `native_pool_id`（旧EVM回填旧对外poolId），添加规范唯一约束 `(chain_key,protocol,native_pool_id)`。Solana新行若需内部代理键，采用有版本、不歧义的编码/代理键，外部原始池id独立保存；窗口、修复和计价引用内部键，不用裸Base58当全局主键。
4. tokens最终主键为 `(chain_key,address)`，scanned_hours的venue覆盖身份为 `(chain_key,protocol,window_start,coverage_scope)`。旧整数 `chain_id` 只保留为可空EVM兼容字段，**不是**Solana身份；当前NOT NULL/旧PK约束必须在新迁移中重建表/索引并校验。不要只加新列后向旧NOT NULL整数列插NULL。迁移SQL需由Codex确认FK与事务顺序。
5. 避免双算：旧pool_id→规范身份的alias/唯一映射必须1:1；对已存在无法表示的跨链/跨协议撞id先报告，不能合并。所有windows/coverage/repair/valuation/publication查询同时核链和协议。
6. 官方美元小时的原币缺失要求新增nullable或“度量表示种类”合同；不能为满足 `volume0/lp_fees0 NOT NULL` 而写0。可在同一小时表上区分 `native_amounts` 与 `official_usd` 表示、保留来源，重算路径按能力拒绝。若一行同时保存两种估值，字段必须可辨来源，不覆盖原生数值。**不另建第二套窗口管线。**
7. 迁移在脱离生产的测试副本执行/比较；当前本代理没有创建或复制运行DB。真正部署由Codex在授权后，停止新调度并等在途自然结束、使用一致性备份后操作，不能粗拷活跃db忽略WAL。

**迁移实施前置：结构变更与版本登记原子提交。** 当前 src/store/db.ts:40执行executeMultiple(sql)，41–44再独立登记schema_migrations；不能假设SQL自带BEGIN/COMMIT就覆盖宿主版本登记。实施前按实际安装的libsql客户端/后端能力设计并验证共同事务边界，处理SQL自带事务与迁移宿主冲突，不擅自宣布某transaction API或写法可用。失败/中断须共同回滚，或进入明确的状态检测、校验和安全恢复流程；禁止结构已改而版本未登后盲重放半成品，也不能未校验只补登记。未验证前不得正式迁移。

重建表还要保留rowid关联及未来新增语义，或受控一致重建持久依赖和缓存，详见3.6；只保留pool_id不等于安全。

### 3.4 现有v1与v2共同兼容闸门

- **v1、v2均是已在用合同，都必须兼容。** src/web/src/api.ts:57及67–74序列化poolKeys、search、page/pageSize、snapshotId，74行fetch /api/v2/board；刷新仍走/api/v1/refresh。v2不是可随意改的新接口。
- 内部先用ChainRef不等于对外chainId:number已获准改string或nullable。两版既有字段、旧EVM poolId及语义保持稳定；Solana不能伪造数字或悄悄省required字段。若需新合同，先列消费者/差异再明确版本协商或新版本设计；不得将建议理解为可直接破坏现有v2。
- 保留现有搜索、过滤、全局排序、分页、snapshotId、poolKeys、详情/候选身份及错误语义。src/server/app.ts:234–247处理search/sort/window及poolKeys限制；board-pages.ts:127–129校验快照及条件变化并以409拒绝失效快照，185–200要求snapshotId和1–5个poolKeys并按快照身份筛选。不得变成当前页排序、跨快照混页或绕过校验。
- 前端poolIdentity继续序列化链/协议/原始池id并保留大小写；物理代理键不能泄漏为详情、外链、RPC原始地址。详情全部入口及URL恢复本轮未全面追踪，Codex仍须审查回归，不声称通过。
- 外部破坏性接口/数据切换仍需确认，不必逐内部函数另问；本轮仅补方案，不批准API升级。

### 3.5 回滚与校验

- 启用前仍可只写迁移测试和未接入默认刷新的适配器，所有Solana开关保持关闭。
- 校验：EVM每表行数、按链/协议/小时原币与美元精确汇总、pool/token唯一性、窗口边界、修复队列身份、发布版本、NULL与0语义、原有查询计划及FK检查；同一查询旧/新返回差异必须可解释。
- 目标迁移须先证明结构/版本登记在故障下共同回滚，或有经验证安全恢复（本轮未验证现迁移器具备此能力）；结构已变/版本未登不得盲重放。成功迁移但新代码失败，优先回滚至可读扩展schema的兼容旧代码；已写新身份/计价版本时，不得降回不认识它的二进制。保留版本/兼容矩阵，必要时用一致性备份恢复，不清库/重置游标伪回滚。
- 不自动删除Solana试验数据，不改旧EVM主键，不中断用户现有扫描。部署/切换另候授权。

### 3.6 rowid、目录缓存与meta发现游标：重建表的隐性依赖

**本轮只读源码证据**：

- src/store/repositories.ts:160–175：listPoolAdditions将目录视为append-only，按chain_id及rowid > afterRowId读取，返回rowIds/lastRowId；不是只靠pool_id判断新目录。
- src/normalize/catalog-cache.ts:26–52,59,106：WeakMap按数据库及链/协议缓存，初始lastRowId=0，读新增池、记catalogOrder并更新水位。重建rowid若下降而沿用内存水位，会漏读；重排可能改变顺序/重复读取。
- src/normalize/refresh-pipeline.ts:730–740把catalog.lastRowId交给延期记录catalogRowId；src/store/repositories.ts:786以 added.rowid > d.catalog_rowid 且 added.created_block <= h.to_block 判定新目录能否让历史延期原因失效，804–807保存水位。013_usd_repair_deferrals.sql:7已有持久catalog_rowid。重排可能漏回访或误回访。
- **实际meta键**在refresh-pipeline.ts:1528生成：99901（Elysium）为 v3_discover_block / v4_discover_block；4663（Robinhood）为 4663:v3_discover_block / 4663:v4_discover_block；其他EVM按数字链号前缀。它们是发现区块水位，不是rowid/slot，不代表Solana已有meta键。
- **调用链**：refresh-pipeline.ts:211–218的discovery调用discoverIncremental，220–222随后loadCatalog；1510起函数在1529用getMeta读键（缺失默认0），1531–1540选择V3/V4 discover、persistDiscovered持久化池，再setMeta(key,to)，本轮from=to+1。getMeta/setMeta在src/store/db.ts:48–57。这里只证明读写顺序，不证明池和meta已原子提交，也不把保存值先验解释为下次起点；边界复扫按现行为回归，不顺手改调度。

**迁移要求（待实施验证）**：优先保留EVM旧rowid及关联/新增顺序语义；确需变化时明确旧新映射或代次，将持久catalog_rowid及相关增量水位/排序一致转换，并在受控无在途切换中失效重建进程内目录和相关查询快照。内存不随DB事务自动切换；只清进程缓存不够，持久延期水位也需处理。不能无条件删全部延期记录/清零水位触发回访风暴，不能清meta导致全历史重扫或错前推漏发现。本轮不执行切换，也不改历史修复抢占政策。

**验证（待执行）**：保存迁移前后上述四个现有meta键/值、pool_id/rowid映射、延期catalog_rowid及判定结果；插入新增池，增量恰好读到且不漏不重。构造创建块在小时截止前/后的新桥，只有符合原条件者回访；无新增目录不应误回访。重启/恢复重复提交后发现范围不漏、不无谓回访，比较旧链延期集合和窗口结果。本轮未读运行库，未声称真实水位或测试通过。

---

## 4. 逐字段来源合同：官方小时不足的地方不能“补出来”

| 公共字段 | Datapi历史能给什么 | 建议来源/缺口处理 |
|---|---|---|
| chain/protocol/pool id、tokens/decimals/binStep | 列表/池详情可发现当前元数据 | 校验mint、program与版本；历史可变参数不能拿当前值倒套。元数据发现不证明历史覆盖。|
| hourly volumeUsd | history `volume` | **候选官方美元口径**；需确认计价单位/来源，独立 `valuationKind=official_api`、schema/取样版本与抓取时间。不能标成方案13重估结果。|
| hourly ordinaryLpFeesUsd | history `fees` 和 `protocol_fees` | 费用语义门未过，不得产出已确认LP费用，不得用于1H费用准入/fees APR。|
| volume0/1、lpFees0/1、swapCount | **没有** | 只能额外事件/交易来源提供，当前设null/unknown；NOT NULL schema需迁移，禁止0填充，禁止用当前价格反算原币冒充真实成交。|
| historical TVL | **没有** | 经验证的小时边界账户状态快照、官方历史TVL接口（若另有再核）、或逐笔重建状态；不得当前TVL回填4天历史。|
| 当前asOf TVL | 列表`TVL`是当前索引值 | 单列来源/截止；与历史结束价格、同一时点报价可比性未证。缺真实源asOf时不得声称“已对齐截至当前slot”。|
| priceStart/priceEnd、priceChange | **没有** | 历史bin/tick/储备状态或可靠历史成交边界；不能拿现在current_price补小时起点。无边界留null，遵守既有全null过滤，不悄悄取消规则。|
| complete/asOf/watermark | 没有finalized slot或last-indexed time | 本地HTTP抓取时间≠真实数据截止；记录 `observedAt`、`sourceDataCutoff:unknown`、`finality:unverified`，不能只用墙钟封口。|
| feeTier/实际动态费/收币模式 | current config可见部分 | 展示静态档不代表这小时实际费用；计算必须实际事件与对应配置/模式。|

当前美元金额直用有两种**待审核**路线：

A. 接受官方美元度量为独立来源，明确未知估值方法与重估限制，历史原币仍缺失；不得把官方源与本地根价金额混合成同一比较窗而不标版本。

B. 要求与现有本地“小时原币累计×本小时结束价”一致，则必须补齐原币及历史状态/根价，本接口单独不够。**建议先把源度量模型做清楚，不为了快通看板无声选A。** 如果必须改变原已定金额口径，要把差异作为用户审核项。

普通标准RPC的账户读不能任意历史slot快照。供应商验收清单必须分别回答：①历史签名/交易范围；②账户状态历史快照及其时间/slot；③bin/tick/储备/价格边界；④Token2022扩展在当时epoch的配置；⑤缺失/修剪/延迟/分页行为。仅“能取4天交易”不通过②③。

---

## 5. 费用语义合同：已确认公式与未确认API字段分开

### 5.1 Meteora DLMM

来源：`meteora-formulas.md` Fee Split、`meteora-revenues.md`、`meteora-collect-fee-mode.md`；官方SDK IDL选摘含源码URL、blob SHA与内容SHA。

- 交易费用T可含MM与限价单两份：`T = MM + LO`（程序按每bin流动性来源分配，舍入有规定）。
- MM普通LP：`MM_LP = MM_fee - MM_protocol`。协议份额按实际pool/config，不能把10%或20%固化到所有池所有时点。
- `LO_participant_fee` 属限价单参与者，不是普通MM LP；LO的协议份额另拆。
- host来自适用协议侧，不能在已经含host的协议总额之外再扣一遍；若拿到的仅是protocol remainder，则还需辨认host部分。先核定义再计算。
- 对无LO、协议侧总额已知的交易，`LP=T-protocol_total`才可成立；混合LO时，普通LP应为 `T-protocol_total-LO_participant`（其他排除项若存在还须扣），不能仅减protocol。
- 官方IDL `Swap2Evt` 明确有 `mm_fee`、`protocol_fee`、`limit_order_fee`、`host_fee`、`fees_on_input`、`fees_on_token_x`；IDL的名称/注释**不是Datapi索引实现说明**，也不够证明`mm_fee`是否还需扣protocol。要将程序版本、事件字段和链上样本对账，禁止据名字二次扣。
- `InputOnly=0`，`OnlyY=1`。OnlyY在X→Y方向从输出币Y计费；不能沿用EVM“一律输入币收费”假设。

**Datapi决策表（当前仍unknown）**：

| 已证实字段语义 | 普通LP转换 | 风险 |
|---|---|---|
| `fees`已是ordinary LP | 直接使用，**不再减protocol_fees** | 否则二次扣费。|
| `fees`是交易总费，`protocol_fees`是完整协议侧且无LO/其他收益 | `fees-protocol_fees` | 必须先有模式/版本证据。|
| `fees`总费含LO、`protocol_fees`仅协议侧 | 还要扣LO participant等非普通LP份额 | 仅两个字段可能不够，还需额外事件/索引字段。|
| 任一语义不明（**本次状态**） | ordinaryLpFee=null、不可排名/不可1H费用准入 | 可继续底座，不伪造0、不采用APR。|

本次不以单个比值判定字段含义。协议费用公式成立，不等于API `fees` 已经可安全用。

### 5.2 Raydium CLMM（独立下一片，不抢做）

来源 `raydium-clmm-fees.md`：每step实际交易费用，按实际AmmConfig的protocol/fund分成扣除：

```text
ordinaryLP_step = actual_trade_fee_step
               - floor(actual_trade_fee_step * protocol_fee_rate / 1_000_000)
               - floor(actual_trade_fee_step * fund_fee_rate     / 1_000_000)
```

这里的 `actual_trade_fee_step` 必须来自实际链上事件/可靠重建，**不是feeTier×volume**。动态费路径需要历史配置和实际动态状态；`CollectFeeOn` 有FromInput、Token0Only、Token1Only，要辨认具体收费币。奖励APR/农场、协议费、fund不算普通LP。

API `day.volumeFee` / `feeApr` 是否已净去protocol/fund仍未证实。不能对已净费用再次扣，不能把官方APR复制进本地作为第二套算法。该未决不阻塞身份底座，但阻塞CLMM费用准入/排名。

---

## 6. SOL根价、包装、Token2022、价格精度

### 6.1 候选源与推荐（技术建议，未批准引入）

| 候选 | 已核实能力 | 缺口与代价 |
|---|---|---|
| RedStone现有EVM Push扩SOL | 可复用已有报价抽象，但当前生产合同仅ETH/HYPE | 本次没有核定某个已部署SOL/USD EVM feed及4天历史。不能因为已有ETH feed就宣布SOL支持。|
| RedStone Solana PriceData | 官方文档有 value、decimals、timestamp（ms）、write_timestamp、update_slot；部署文档确认Solana主网程序，feed表已移至官方app | 仅证明结构/程序存在，**未核定SOL/USD实际feed账户和4天历史**。标准RPC当前account不能任意回读历史。旧无key API文档本轮WebFetch500/直接下载TLS证书过期，未绕过TLS，不当可用方案。|
| Pyth历史价格API（建议优先评估） | 官方 `.../api-reference/historical-prices/price`：需认证，Unix微秒、mode=before（默认），响应`feed_update_timestamp`；需用当前catalog确认数值feed id/channel。 | 本次没申请key、没读凭据、没实测SOL四天。成本是新供应商、权限/限流、历史覆盖验证；上游模式需逐响应验时间，不能只信端点名。|
| Pyth旧Hermes timestamp端点 | 文档明确返回“at or after”，Unix秒，需API key | **不能直接拿target请求结果当<=target历史价**。可用严格有界的历史区间找前一有效更新，若无则missing；不允许未来最近价。新接入优先读新API，不默认旧无key接口仍可用。|

建议：先维持报价接口与配置默认关闭；报价源选型审核时优先评估提供明确 `before` 语义的官方历史源，若要坚持RedStone就先提交真实SOL feed与历史样本。**不要向用户反问“用哪家”替代技术核实，也不要未经批准引入Pyth。** 底座可以完成，美元计价/排名门保持关闭。

统一quote草案：`{asset, priceDecimal, source, feedId, publishedAtUnix, retrievedAt, confidence?, sourceVersion, targetAt, evidenceRef}`。毫秒/微秒→Unix秒采用明确转换，仍保留原始精度。必须 `publishedAt <= targetAt` 且符合经批准的有效期；未来、负数、0、指数非法、置信区间超政策均拒绝。不能用现在价回填历史；同一小时的root先锁定，池推导不能回写root。

### 6.2 WSOL与稳定币

官方 `https://solana.com/docs/tokens/basics/sync-native`：Token Program的原生mint `So11111111111111111111111111111111111111112`，SOL精度9；WSOL余额是`amount`，lamports还含rent保留，转SOL后需SyncNative才更新amount。只读扫描不能把vault全部lamports不扣rent当TVL，也不能把mint地址、token account、wallet混为一物。

官方页面另列Token Extension Program原生mint；本轮不据此自动新增第二个包装映射，仍需核owner/decimals/支持路径。不是所有名字叫SOL的币都1:1映射。WSOL同价属建议合约，须审核后在特定程序/mint范围启用。

Circle官方USDC主网表确认 `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`（本次API元数据为6位）。资产身份已核，不等于用户已批准“任何时候USDC永恒$1”或当前价回填历史。需要显式采用的稳定币计价政策；不按symbol锚定任何桥币，不自动加入USDT/其他同名币。

### 6.3 Token-2022 与定点数

官方 `https://solana.com/docs/tokens/extensions/transfer-fees`：TransferFeeConfig从转账扣费、withheld留在接收token account，可按epoch更新；它是token转账费用，不是普通LP收入，也不是protocol fee。元数据要记录tokenProgram、扩展、历史生效epoch；若未支持transfer fee/hook等扩展，**保留目录与原因，但拒绝生成未经校验的金额/排名**，不能把净余额差全算成swap LP费，不能把拒绝变成0。

统一价格明确 `token1 per token0`，整数原币先保持BigInt/字符串，Decimal计算：

- Raydium：`p_human=(sqrt_price_x64/2^64)^2 * 10^(decimals0-decimals1)`，这是Q64.64，不是Q96。
- EVM原有Q96路径保留自身换算。
- DLMM：官方bin公式是`(1+binStep/10000)^activeBinId`的原子单位比率，再应用decimals方向；负bin id须支持。使用钉版本官方SDK核对方向/舍入，不把bin id当tick。
- 反向展示只在统一价非0且有效时取倒数；两种decimals组合、priceStart/End方向必须相同。金额/费用不得经过JS Number丢整型精度。官方JSON若是浮点数只能记录其来源精度，不能标为链上精确原币。

---

## 7. 续接/覆盖合同：单管线，水位必须是已完整提交

### 7.1 幂等与cursor

- 复用同一套窗口/覆盖逻辑，六窗 `1h/2h/4h/6h/24h/3d`、4天留存、1H集合S、1H准入1000/100/10、不设默认APR门槛不变。
- 五分钟是更新当前**时钟小时**频率，不是新窗口/快照表。按链互斥忙则跳过，不排队追赶、不新开历史修复抢占；保留现有磁盘保护与有限请求超时/重试。
- Cursor源分型：官方小时revision游标 ≠ RPC slot/签名游标。官方累计同小时**覆盖**；事件新段按已去重增量追加。禁止两者复用一个“累加”函数。
- 事件唯一身份建议：`(chain,protocol,signature,outerInstructionIndex,innerInstructionPath,eventOrdinal)`，slot/块哈希作为位置与finality证据（同一个event在重试slot变化不能双记）。若平铺innerIndex，须连同所属outer索引和日志事件序号；一笔路由交易可能多次触发同一池，不能只按signature去重。
- `finalized`作为本地链数据封口候选；processed不入正式小时，confirmed若用于临时观察必须明确暂定，不前推finalized水位。HTTP索引未暴露commitment，不能谎标finalized。
- 每分页批次/每小时成功：事件去重、原币/官方累计、覆盖状态、游标、发布修订在一致事务完成后，才前推 `committedWatermark`。`maxSeenSlot`/下载成功页只算观测，不算覆盖。
- 分页中断、响应截断、解码失败、任一required页缺失：不前推该范围完成水位。可保留暂存/页进度但不能对外标全覆盖；重启能安全重读，重提交不双算。
- 两端inclusive API，统一内部半开 `[start,end)`；请求需按本次端点行为读到边界，过滤/去重末端标签，不用“end-1万用法”。

### 7.2 水位、封口、晚到与revision

建议小时状态：`unobserved | partial | candidate_closed | verified_complete | gap | revised`，另有独立fee语义与估值状态，不能一个complete布尔掩盖所有质量。

- 源行只给timestamp，缺源watermark时保存unknown；本地 `retrievedAt` 单独列，不把它作为已覆盖截止。
- 封口前需：实际范围覆盖证据、无未决页、时钟边界、source finality或经审核的indexer滞后政策、稳定重叠查询；时间过去1h或两次值相同本身不是充分证明。
- 迟到数据/上游修订：允许对已过去小时覆盖新revision，重建其依赖六窗与同一链发布版本；保留来源/计价版本，防旧请求覆盖更新的数据。无法比较源revision时用请求代次＋一致性校验防乱序，不能只按返回速度判新。
- 不以旧值伪装新截止，不把未来end当asOf，不把未知费用置0。源后退/矛盾时保留上次已验证发布并标error/lastSuccess，不强行改成更小水位。

### 7.3 零与稀疏存储

推荐在现有scanned_hours覆盖逻辑扩展**覆盖账本**（是否加新辅助表由Codex审核，禁止另起第二套窗口/5m快照）：记录链、协议、小时、源、发现集合版本/适用范围、覆盖截至、完整性及失败原因；需要按池追踪的官方HTTP源必须有per-pool覆盖，不能一条venue complete代替只查过的两池。

- 有明确完整覆盖并证明池当时存在且无swap：可表示 `covered_zero`；后续组成长窗时合法0。
- 从没查到/页失败/池存在起点未知：`not_covered`，必须null/gap，不能0。
- 新池创建前的小时：显式`not_existed`，不是断档、也不是该池发生过0成交；窗口池龄策略应保留。
- 稀疏窗口行可以不为所有低TVL池铺满96行，但覆盖范围/零证明必须足以让后来起量池追溯。做不到就为相关池补档或留gap，不能只靠省略行制造虚假连续。
- 当前低TVL不是永久淘汰：发现/增量活跃索引应允许池重新进入候选，不能只刷新旧准入S。全发现目录和全部逐小时物化是不同任务，未覆盖池不得悄悄当已扫描。

### 7.4 容量预算（不是通过承诺）

设每5分钟需要更新N个池，每池q次请求，发现D页，修复B次，报价共享Q次，则 `requests = N*q + D + B + Q`；最低串行服务时间约 `requests / effectiveRps`，还要加延迟、重试、下载、解析、数据库和锁时间。官方30RPS是总上限，不是单进程可全吃配额。

示例仅做算术：N=10000、q=1，在30RPS理论下限已333秒，超过300秒；按15RPS保守预算则667秒，尚未算补扫。4天cold backfill若每池一次96h请求，仍是N次，不是“96标签一次拿到=全站免费”。这些数字不是实测池数/已批准限速。

建议服务端共享限流器、上限/并发/超时可配置、按源分页增量发现、按真实活跃/覆盖状态制定有界预算并保留潜在准入池通路。若只能遍历全站发现活跃，需要明确成本，不得用“归档节点”四字承诺低成本全链索引。历史修复保持既有忙则跳过政策，不以性能理由擅自抢占。记录目录池数、请求/响应字节、首次当前小时发布延迟、整轮耗时、429、内存、DB+旁文件、磁盘余量。

---

## 8. 文件影响与依赖次序（检查单，不是补丁）

| 阶段 | 文件/模块 | 要解决的具体合同 | 前置/输出 |
|---|---|---|---|
| S0 审核修订标准 | 方案17、决策/场所路径/架构引用 | 删除默示授权、补字段来源/状态能力/费用/覆盖/预算；“加总”只限可加量 | 逐条采纳/拒绝本审计及理由，不改方案16 |
| S1 身份 | shared/types.ts,catalog.ts,pool-identity.ts | chain字符串/可空evmChainId；原始id与物理键区分；现有v1/v2均兼容 | 类型→全部消费者→破坏变更门 |
| S1 存储 | 新migration、store/types.ts,repositories.ts,db.ts,prune.ts；catalog-cache.ts及发现调用点 | chain_key、旧id/rowid映射、nullable原币、覆盖账本、引用/meta水位一致；结构与版本原子提交 | 离线故障恢复/旧链对照通过，不改已应用迁移 |
| S1 源合同 | `shared/venue-sources.ts`、`adapters/types.ts,venue-adapter.ts,registry.ts` | 不是全源都1h/1d subgraph；官方累计与事件能力分型 | 仍listed、placeholder/默认刷新不变 |
| S2 DLMM | 既有`adapters/venues/solana/meteora-dlmm.ts`及所需服务端HTTP辅助 | endpoint边界、累计upsert、费用模式、pool metadata | 费用/小时覆盖门过后才进入实际指标接入；可先做离线fixtures |
| S2 归一 | `normalize/hour-continuation.ts,refresh-pipeline.ts,windows-from-swaps.ts,repair-hour.ts` | chain非EVM分派、源水位、slot/event幂等、能力缺失null | 不fork扫描管线，不套EVM reader |
| S3 报价 | `shared/usd-quotes.ts,normalize/prices.ts,pricing-policy.ts`及源适配 | official_usd与本地估值、SOL历史、WSOL/稳定币版本 | 新来源/口径审核，报价缺失原币仍保存 |
| S3 配置调度 | `.env.example,server/env.ts,app.ts,auto-scan.ts` | env预留、按源预算、按链互斥、磁盘与有限重试 | 不读取/改`.env`，不自动开生产 |
| S3 指标API | metrics/*,normalize/board.ts,server/board-pages.ts,board-query.ts,app.ts | 六窗S、unknown不排名、身份映射；v1/v2快照/poolKeys/详情合同 | 全局搜索过滤排序分页及失效错误回归 |
| S3 前端最小兼容 | `web/src/api.ts,BoardPage.tsx,BoardTable.tsx`等实际消费者 | 只显示服务端结果、身份大小写、unknown/lastSuccess | 不直连官方、不重算第二套fees APR、不重构布局 |
| S4 Raydium | 既有`adapters/venues/solana/raydium-clmm.ts`及独立fixtures | 无1h官方窗、自建事件/历史状态、x64及动态费 | 独立下一片，不与DLMM同一迭代塞入 |

表里部分模块来自前轮只读事实，Codex须核当前依赖图，不能当完整代码审阅。最小增量：不全站重写、不为本轮泛化包装，不用零或当前值兜底掩盖错误；只改本片实际依赖模块。

---

## 9. 原完整收益路线的切片与停点（本期以第12节为准）

1. **S0先修方案**：将本包审计、边界样本和授权纠偏落入修订稿；列出仍unknown字段。先技术审核，不先改enabled。
2. **S1公共身份/存储兼容底座**：先审结构/版本原子性、rowid/缓存/meta依赖，以现有两条EVM链及v1/v2行为不变为目标，在测试环境做迁移、故障恢复和API契约；未验证不正式迁移，不连生产新链。普通细节连续完成；外部破坏变更在合同门统一确认。
3. **S2 DLMM适配**：先fixture与HTTP契约测试；费用归属、完整小时/源截止、历史状态门没过时可做元数据和能力返回，但LP费/准入/APR路径明确blocked。不能为了“已接通”放行unknown。通过门后再接原管线，不另表另服务。
4. **S3报价/调度/验收**：完成SOL源选择审核、字段来源与估值版本、请求预算、故障/崩溃恢复及旧链回归；只对授权的有界联调范围取证。**部署与生产启用另候明确授权**。
5. **S4 Raydium独立下一片**：先自建1h数据/历史状态成本验证，再谈可用性；不把24h/7d差分冒充1h。

**本包不是要用户为每个函数拍板，也不是所有切片已获生产授权。** Codex应先完成S0并给出S1可执行范围/阻塞清单，按用户在其会话中的具体授权延续。BSC、DAMM V2、钱包/开仓、方案16不在连续实施范围。

---

## 10. 具体测试与验收矩阵

状态约定：P01–P04是Grok报告，Codex待独立复现，不是双方通过记录；原样本/manifest在助手侧未落本机，本轮无新API复现，403只属访问失败。其余产品测试均待Codex执行。E=待取得的助手侧原返回，T=未来日志/fixture，R=未来旧链对照。

| 编号/状态 | 输入 | 预期 | 证据/方法 |
|---|---|---|---|
| P01 Grok报告／待独立复现 | 两代表池，精确4天end整点 | 97标签，截掉末端得96，无重复/缺标签；不宣称全站完整 | `*-history-96h-boundary.json`、`boundary-comparison.json` |
| P02 Grok报告／待独立复现 | 同一池同start，end整点 vs 整点-1 | 观察到同标签金额实质变化，必须阻塞盲目封口 | closed-exact/minus1-repeat/padded |
| P03 Grok报告／待独立复现 | 当前小时end=now vs end=下一整点 | 样本可能0 vs 非0；两者都不得complete/以参数当asOf | current-exact-start/full-boundary与longtail-current-partial |
| P04 Grok报告／待独立复现 | 仅timeframe=1h无范围 | 本次10标签；不可硬编码为SLA | default-range |
| T01 待执行 | 两个都能解码32字节但大小写不同的Base58地址；非法0/O/I/l，31/33字节 | 保持两个不同合法身份；非法拒绝；PDA offcurve不误拒 | T，官方SDK交叉校验，原样往返 |
| T02 待执行 | 同nativePoolId跨chain、同chain跨protocol | 规范身份互不串；旧EVM pool_id不变 | T，唯一约束和alias查询 |
| T03 待执行 | 99901/4663旧整数链请求与结果、未知数字、Solana | 现有v1/v2均不变；未知报错；Solana无伪造整数 | R＋API契约 |
| T04 待执行 | 旧库迁移两次、结构后登记前故障、未知chain | 结构/版本共同提交/回滚或可检测安全恢复；不盲重放、映射不猜 | T，实际libsql故障注入及约束/聚合摘要 |
| T05 待执行 | inclusive重复、错桶、缺一小时、重叠不一致、乱序 | 去重、missing保留、金额不重，旧响应不盖新 | T，取得助手侧边界原样本后回放，取得前待复现 |
| T06 待执行 | 已封口小时晚到修订 | revision变更并重算依赖窗；旧发布可追溯 | T＋发布版本 |
| T07 待执行 | covered_zero vs unobserved vs not_existed | 0/null/创建前区分；不因省行造假连续 | T，coverage ledger |
| T08 待执行 | 费用unknown/LO份额不明、负净费、已净费100再减10 | 不进费用准入/排名；负值报异常；已净100不二扣成90 | T＋源定义fixture |
| T09 待执行 | 同一交易两次swap、同池两条inner instruction、同事件重试 | 两次真实事件各算一次，重试不双算 | T，signature＋instruction path＋ordinal |
| T10 待执行 | >2^53原币、9/6与6/9 decimals、负bin、Raydium x64 | 高精度不丢；方向和倒数符合SDK；不误用Q96 | T，BigInt/Decimal与官方SDK独立值 |
| T11 待执行 | Token2022有transfer fee/未知hook、同名WSOL桥币 | 保留发现但安全拒绝不支持指标，不算LP费，不串根价 | T＋tokenProgram/extension证据 |
| T12 待执行 | finalized头回退、confirmed orphan、HTTP源无finality | 不退正式水位/不标已finalized；异常隔离lastSuccess | T，模拟源响应 |
| T13 待执行 | 第2页超时、提交前/后崩溃、响应下载完未commit | 不前推完整游标；重启幂等；累计/覆盖/发布原子一致 | T，故障注入 |
| T14 待执行 | 历史TVL缺、价格边界缺、原币缺 | null而非当前回填或0；不可按完整金额合成 | T，逐字段合同 |
| T15 待执行 | 报价publishedAt比target晚1秒、ms/μs、缺价、旧估值 | 未来价拒绝；单位正确；原币保留；不覆盖更高版本 | T，报价fixture |
| T16 待执行 | 官方USD与本地估值混窗、TVL/价格/APR加总 | 不允许无版本混合；TVL/价格不加；APR重新算 | T，compose-windows与fees-apr |
| T17 待执行 | 当前1h准入达标池A、长窗有缺；未达标池B | 六窗同集合S；A留行缺指标；B不因24h高入选 | T，既有全null附加过滤一并回归 |
| T18 待执行 | 同链正忙、另一链空闲、磁盘满、429 | 忙则跳过无排队，其他链不受阻；磁盘保护；有限退避 | T，auto-scan/app测试 |
| T19 待执行 | 新池/旧池重新起量、低TVL后达标 | 可通过发现/活跃机制重进候选，历史缺口不伪造0 | T，稀疏存储模拟 |
| T20 待执行 | 大目录/冷补96h/暖轮/跨整点 | 报池数、调用/字节/耗时/内存/DB/首次发布延迟，不能靠理论RPS宣布通过 | T＋真实授权联调报告 |
| T21 待执行 | 两旧链查询/搜索/排序/分页/计价/修复，v1/v2详情/候选身份 | snapshot/poolKeys、旧采集/报价/修复语义不变 | R，黄金fixture及授权部署前对照 |
| T22 待执行 | 所有Solana/DAMM/BSC默认配置，方案16研究输出 | 未授权场所仍listed、默认刷新不可达；研究结果不入生产窗口 | T，registry/refresh scope负向测试 |
| T23 待执行 | DDL/DML后登记前中断、登记失败、重启 | 结构/版本共同提交/回滚或验证安全恢复；不盲重放/补登记 | T，按实际libsql能力故障注入，未实测 |
| T24 待执行 | rowid变化、缓存lastRowId、延期catalog_rowid、小时前/后新桥 | 不漏增量、不漏/误回访，四个发现meta键/值保留且与已存池一致 | T＋R，映射/缓存/持久水位/重启对照 |
| T25 待执行 | v1/v2有效/失效快照、poolKeys、搜索排序分页、详情/URL恢复 | 稳定身份及错误语义不变，不混页，v2非空白新接口 | T＋R，全部消费者回归，本轮未全面审查 |

全量产品测试、构建、类型检查、迁移、容量、费用对账本轮均未运行。仅改正文、只读核代码；Grok历史报告不代替Codex复现或产品验收。

---

## 11. 原完整收益路线的阻塞记录（已由第12节拆分适用范围）

### 阻塞（不等于什么都不能做）

1. Datapi `fees/protocol_fees` 与普通MM LP/LO/host准确映射未证，禁止费用准入/APR；官方事件定义已找到，但索引层语义未找到。
2. Grok报告端点边界反例及96小时标签连续，Codex尚未独立复现；原样本未落本机。源asOf/finality、晚到修订仍未知，不宣称双方或全站完整验收。
3. 历史TVL/原币/价格边界缺少可验来源；历史交易archive不等于历史账户快照。
4. SOL历史根价未选定、未实测；Pyth/RedStone只是候选，official_usd是否接受及估值版本待审核。
5. API/迁移未获破坏变更批准；现有v1/v2均保护。结构/登记原子性、rowid/缓存/延期/meta依赖待验证，Codex须核真实schema和全部消费者。
6. 全站池数与生产预算未测；低成本全链索引不作承诺。

### 旧交接指令（历史，不作为当前执行清单）

> 先读本机18；原始样本/manifest在助手侧未附本机，不当已取得附件；Grok边界报告待独立复现，403不证实也不证伪。可先审核底座，源语义门仍阻塞。在你会话授权内先修标准，再S1：保护旧EVM主键、rowid/缓存/延期/meta发现水位及现有v1/v2搜索排序分页/snapshot/poolKeys/详情身份，先验证结构与schema_migrations原子提交和故障恢复；Base58保留大小写。最小增量，不全站重写、不泛化包装、不用零/当前值掩盖错误。Solana仍listed不入默认刷新，DLMM费用/小时门过后再接，报价/调度/验收随后，Raydium独立下一片；不动BSC、DAMM V2、16、钱包开仓，不开生产。破坏变更/部署另候确认，内部细节不逐函数问。列实际改动/阻塞/真实测试，未跑不说通过。

## 修订记录

- 2026-11-20（北京时间）：四项复审融入0/2证据、3.3–3.6迁移/兼容、8–9实施、10测试、11接手；仅改本机18，未改产品/17/16/BSC/开关/服务，未传ZIP或证据、未新API复现、未跑产品测试。


- 2026-11-21（Asia/Shanghai）：按用户明确授权完成S0/S1离线实施；实际代码、测试、未做及回滚边界见[本轮实施交接](18-solana-s0-s1-implementation-2026-11-21.md)。此前“待实施”保留为11月20日草案历史，不代表生产已启用。

## 2026-11-21 S0/S1 Windows 清理复核与修复计划

记录时间：2026-11-21（Asia/Shanghai）。用户本轮明确授权先记录问题，再在助手独立 checkout 修复 S0/S1；此前“本轮仅 MD”为历史复审边界，不覆盖本次授权。本机现有 Codex 修改及文件命名保持，不改本机源码、Git 信任、服务或运行库。

### 本机只读核实的问题

- `test/migration-014.test.ts:30`、`test/solana-foundation.test.ts:33` 的 afterEach 立即 `rmSync`，无有界重试；`dirs.splice(0)` 在首错前清空跟踪，首错还会中断其余目录清理。force 不会忽略 EPERM。
- migration 测试 `legacy()` 初始化失败缺连接关闭保护；首个测试及崩溃测试在首次连接 close 前也有未保护操作。`src/store/db.ts:15` 的 WAL 初始化在 try 外，失败可能漏关；migrate 失败本来已有 close，迁移事务本来已有 finally close，不误报为缺失。
- 安装的 @libsql/client 0.18.0 close 为同步 API；不能将“加 await close”当成解决方案。源码缺口不证明就是本次 Windows EPERM 的实际根因。
- Codex 历史 Windows 报告为 250 通过 / 8 清理失败，定向重跑仍为清理错误；TS/构建通过。本次 Grok 只读审核未在本机执行测试，不能冒称复现。
- 本机两个测试与 db.ts 为 CRLF，biome.json 为 LF 且未显式设 lineEnding；尚不能把本机格式差异认定为提交内容错误或纯噪音，不全仓转换。

### 本轮待修与验证

1. 在助手分支补齐连接创建后初始化/使用的异常关闭保护，openDatabase 失败保护覆盖 WAL，保留原始错误；不改已应用迁移或业务规则。
2. 临时目录删除采用 recursive:true、force:true、maxRetries:5、retryDelay:100 的有界重试；各目录尽力清理，耗尽重试后保留最终错误，不吞错或因首错遗漏其他目录。
3. 补初始化失败 close、清理重试配置与最终失败传播测试；助手 Linux 定向/全量测试、pnpm check/build 的实际结果另记实施交接，不以 Linux 通过证明 Windows 文件锁已解决。Windows 真实释放与全量回归仍待 Codex 复跑。
4. 保持原 PR #1，新增 commit、不改已推送历史；不启用 Solana/S2、不触碰方案16/BSC/DAMM/Orca/钱包，不扫描、不迁移运行库、不部署。

状态：以上为核实问题及执行前计划，尚不声明修复或本轮测试通过；最终实际结果以同分支实施交接与新增提交为准。本机源码仍需 Codex 后续同步新增 commit。
### 助手修复结果：4362a9d

2026-11-21 21:56（Asia/Shanghai）：助手独立 checkout 已完成上述修复，新增提交 `4362a9dc0ff4f783b0976df7531e3f98df1f4348`，常规 push 一次到原分支 `feat/solana-s0-s1-foundation`，原 PR https://github.com/ls569333469/LP-Atlas/pull/1 保持 OPEN，已核远程分支及 PR head 均为新提交；未 amend/force/merge。

- openDatabase 的 WAL/迁移初始化失败均受关闭保护；初始化与 close 同时出错保留原错/cause。legacy fixture 初始化失败及首次连接操作补齐关闭保护。
- 两个 afterEach 改用小型测试 helper：Node recursive rmSync，maxRetries=5、retryDelay=100；尽力处理所有目录，失败路径保留，最终 AggregateError 明确报错。未用 await 同步 close 冒充释放保证。
- 助手 Linux（Node v20.19.2 / pnpm 10.34.6）：定向4文件/22项通过；全量45文件/267项通过；pnpm check（三组TS）及API/Web构建通过。Biome仍有72 warnings/50 infos，不是零告警；本轮TS文件定向检查通过。
- 已核16df52f的Git原始blob：两个测试和db.ts为LF，本轮保留既有LF；本机CRLF的转换来源未查，不改本机Git/格式配置，不全仓转换。重试测试验证有限参数委托及模拟耗尽后的失败传播，并不证明Windows内部句柄释放或每次重试时序。

本机本轮仅增量修改此MD，未同步源码（此前Codex同步记录为16df52f，本轮未运行本机Git核验）。Codex下一步应先保留本机未提交文档修改，再同步新commit并在Windows复跑定向/全量/check/build，不能用助手Linux通过代替Windows实测。助手分支的方案18及实施交接已记录实际修复与验证范围；本机不要用旧整稿覆盖这些增量记录。

未改已应用迁移，未访问/迁移运行库、未扫描或部署；Solana仍未启用，S2费用归属/源覆盖/历史字段/报价政策阻塞保留；方案16/BSC/DAMM/Orca/钱包及既有五分钟/小时/六窗/准入不变。

## 2026-11-21 Windows EPERM 根因复核及第二次修复

用户授权“修复，然后继续测试”；代码仍仅在助手 checkout 修改，所有运行验证仅Windows，不在助手Linux跑test/check/build。当前Windows HEAD/ref及修复文件确认4362a9d；其真实全量为255通过/12清理失败，不能沿用此前Linux通过结论。

修复前Windows Node v24.11.1、@libsql/client 0.18.0/libsql 0.5.29最小对照证据：普通文件、raw Database只open/exec后close可删除；raw prepare SELECT并保留Statement时close后EPERM，等待50ms及保留Statement时GC仍失败，丢弃Statement并GC后成功。client仅create也产生健康检查SELECT；close后、等待后均EPERM，两次GC/事件循环回合后删除成功，保留已物化ResultSet不妨碍删除；WAL、已commit且close的transaction也相同。不运行Vitest也能复现，因此不是其断言/worker特有的未关闭事务；可定位到未回收prepared-statement原生句柄生命周期，但不推断未读取的原生析构实现，也不声称Node24独有问题。

在Windows独立诊断中，保持5次/100ms删除配置，30组WAL/事务/SELECT/close经过有界GC回合均可删除；活连接负向对照仍EPERM且SELECT仍可用，close后回收才可删除。计划最小修复：仅Vitest forks显式暴露GC，测试清理await两个GC/事件循环回合，再执行原有有界删除；真正仍占用/权限失败继续AggregateError，不吞错、不跳过、不无限重试。清理队列按批消费一次，错误携带失败路径，避免旧失败被后续无关hook反复计算。新增缺GC/真实closed-client覆盖；不改生产openDatabase或依赖。

格式独立问题：本机两测试/helper/db.ts是CRLF，Git原始提交为LF，Biome默认LF；仓库/本机info均无attributes，仓库config没有autocrlf/eol显式项，未读取用户全局Git设置。新增仅格式化源文件扩展名的LF checkout属性，不全仓转换，不覆盖中文MD或本机未提交修改；当前39个默认format错误只有Codex同步并保留内容核对行尾后才能实际复验，CRLF override不是默认通过。

本节记录诊断与修复计划，不声明新提交已在Windows全量验收；最终代码/待同步/测试范围见实施交接。S2、服务、运行库、生产及16/BSC/DAMM/Orca/钱包边界不变。


## Codex Windows 收尾修复（2026-11-21）

范围仅S0/S1测试与既有格式合同，不部署、不迁移运行库、不启用S2。ffa950a复验266/269，仍不能作为Windows验收通过。

已独立复现：触发器RAISE异常被保留时，关闭连接并两次GC仍EPERM；读取异常及cause的惰性stack后，同样两次GC即可删除。故障用例须在保留原错和断言前提下展开堆栈，不能靠延长同步删除等待掩盖句柄引用。GC参数测试通过显式注入回收函数测试，不重定义不可配置的全局gc。仅对静态检查实际报错文件核对LF行尾并保留本机修改，不全仓格式重写。修复后Windows最终全量45文件/270项通过（含真实活连接清理失败负向检查），默认静态检查与三组类型检查通过（72 warnings、50 infos），API/Web隔离目录构建通过。S0/S1代码及离线验证完成，生产部署/运行库迁移未执行，S2仍受阻；详见实施交接“Codex Windows 最终验证”及缓存 node_modules/.cache/lp-atlas-s1-codex-final/。

## S2 官方源复现与原实现合同（2026-11-22，Asia/Shanghai）

> 本节记录新选型前的候选实现与证据，不代表下文每一旧阻塞仍适用；当前官方候选合同以第0/12节为准。

用户已授权按方案18继续S2。只在既有DLMM场所模块、官方索引HTTP辅助、来源合同和小时事务内增量实施；不启用Solana、不进入S3、不部署或读改运行库。本节更新第2节及第10节的证据归属，不把未验证的源语义改成通过。

### 独立证据

本轮Windows对两个原代表池、原时间范围重发11次有界官方GET，池列表仅第一页2池，未遍历全站；每次18秒、900KB上限。两池均返回97标签，过滤到四天范围得96候选小时。原SOL-USDC样本11:00标签：end减1秒为4777.67320142552美元，end整点为1064262.3261313129，作为内部桶为1064262.3261313157。长尾样本同样有显著端点差异。此前“Codex未独立复现”对这两个边界/标签样本已不适用；这仍不是finality或金额覆盖验收。

回归fixture与请求URL/响应原字节摘要见`test/fixtures/meteora/`；JSON按仓库格式落盘，原HTTP字节SHA与格式化fixture SHA分别记录。官方OpenAPI仍只描述fees/protocol_fees，未给普通MM LP净收益定义，也未给真实源截止、finalized slot、历史TVL、原币或交易数。官方公式区分MM LP、LO参与者、protocol与host，不能仅依字段名或比值认定API净费用。文档URL及正文SHA见official-source-contract.json。

T01已用发布版`@solana/web3.js@1.98.4`独立执行PublicKey及findProgramAddressSync：两个大小写不同地址均为不同合法32字节身份，真实off-curve PDA可接受，非法字母与31/33字节拒绝。SDK bundle仅在本机证据缓存执行，未加入产品依赖；版本/URL/SHA及向量见sdk-address-vectors.json。本期不因此宣称账户owner/Token2022扩展已全面核实。

另对公开主网RPC做两次当前getMultipleAccounts小样本读取：两池owner为DLMM程序，WSOL/USDC样本mint owner为SPL Token，池discriminator匹配IDL；完整当前样本见current-accounts.json。仅public_temporary当前状态证据，不是历史快照或生产节点验收，不推断为四天各小时的账户状态。

### S2代码合同

- 仅显式读取一个目录页或最多96小时；HTTP辅助复用official-index.ts，单次独立18秒截止覆盖响应体，900KB限制，错误立即返回，不自动重试/全目录展开。生产预算、限流策略及调度接入仍属S3，未设置为无限请求。
- 请求起止为整点，end取精确边界；校验返回范围、1h标签、数字及身份，丢弃末端桶，等值重复去重、冲突重复拒绝、缺小时明确列出，不造0。不把整点请求规则等同于小时已经封口。
- 元数据保留binStep与collectFeeMode，不塞入tickSpacing或静态费率；API当前TVL仅单列currentTvlUsd，账户核验状态仍unverified，未写成已验证历史元数据。
- 历史只转换为official_usd候选；普通LP费用、原币、交易数、历史TVL和价格边界为NULL，complete=false、finality/feeAttribution=unverified、dataCutoff=null。不得按reported fees减protocol或按费率乘成交量，不审批官方USD替代方案13估值。未接默认刷新/API/看板，不改变原1H准入。
- 复用既有commitHourCheckpoint事务提交候选窗口/池级coverage，不另建表、队列或扫描服务；不发布非EVM链版本（S3合同未做）。写入失败回滚，待提交数组保留；重复累计用覆盖，不相加。
- 官方累计/coverage按同来源同schema版本覆盖；新增可选requestStartedAt只用于本地请求先后排序，不能充当源cutoff。旧格式回退observedAt，旧请求晚返回不得覆盖新请求；真实源修订仍需上游revision/finality政策，不能由本地先后推定权威。EVM原币更新与原游标规则不变。

费用归属、完整源水位、历史状态来源及官方USD口径仍是未解除的金额接入门。已向用户询问是否已有Solana历史交易及小时边界状态供应商；不读取.env、不自行迁移节点。本轮具体进度以05-roadmap顶部S2清单为准。

### 数据源调查（2026-11-22，官方现行资料）

用户回复目前没有Solana历史供应商，要求先调查，并同步请Grok研究。本次未购买、登录或配置供应商，也不把候选源写成已确认选型。以下是文档能力核验，不是付费接口实测验收。

| 候选 | 官方明确能力 | 对本项目的判断 |
| --- | --- | --- |
| Helius Historical Account API（Beta） | getHistoricalAccountInfo按slot或slot+transactionIndex返回任意账户历史状态；覆盖从444959999（2026-09-07）起；Business及以上；Beta期间0 credits/调用，独立100 req/s、burst 100。配合getTransactionsForAddress取历史交易。 | 当前最直接匹配四天交易+池/储备/bin账户历史状态的候选。必须先取得授权套餐与密钥，实测DLMM账户布局、时间边界、空账户、覆盖与索引延迟。未获授权不实现供应商绑定。 |
| Triton Fumarole | 持久gRPC、四天滚动保留、至少一次交付、断线按服务端游标续传；账号更新/交易可筛选；from_slot被忽略，跨区域游标不复制。 | 可作为持续采集与断线补扫候选；“四天保留”不自动证明新订阅可读任意历史小时全部未变账户，更不等于历史accountInfo。初始快照、首次冷补范围和价格待供应商确认。 |
| Helius LaserStream gRPC | 约48小时replay；更早约20分钟之外来自finalized历史块；按流量计费。 | 单独不能满足96小时冷补。若用，仍需历史账户/交易服务补足，不为五分钟采集默认增加gRPC。 |
| Shyft Yellowstone标准replay | 文档明示最早约当前前150 slots。 | 该具体replay能力不足四天；不泛化为Shyft其他产品绝不支持历史状态。 |
| 普通Solana/QuickNode/Alchemy/Chainstack标准RPC | 标准getAccountInfo仍是当前状态；交易archive与状态archive分开。QuickNode索引可见subscribeReplayInfo，但本轮未取得其历史账户产品明确合同。 | 不能据“archive”购买或推定历史池状态可用。未取得产品专用历史状态文档的供应商保持未证实，而不是判定其全产品不支持。 |

Helius官方当前Business价格499美元/月，100M credits/月，标准RPC 200 req/s；历史账户接口单独100 req/s，并非随200叠加为300。Beta历史账户免费计点不等于套餐免费，也不是永久价格。getTransactionsForAddress full模式按每100条10 credits、向上取整、最低10，单次至多1000条；标准archive调用通常1 credit。Business/Professional默认启用超额autoscaling，应在选型/开户时核对支出设置，不在程序里假设预算无限。无密钥历史账户探测返回401，只证明当前未授权，未验证返回布局或性能。

容量只给下界，不承诺性能：若每池每小时至少读池账户+两储备，共K=3、P=100，首次96小时至少28800次历史账户调用，100 req/s下仅限速理论下界288秒；P=1000为288000次、2880秒。实际还可能读bin arrays、mint/Token2022历史扩展及费用配置，需网络/解码/交易/重试时间，K=3不是充分TVL证明。正常五分钟只续接新交易和变化账户，不每轮重拉四天；对账户/小时/目标slot去重。未测最终候选池数和交易量前，不给全站费用、内存、10–20秒或冷补时长承诺。

费用复审（2026-11-22）：用户明确反馈Business起499美元/月过贵，当前不采用该付费路线；上文仅保留能力调查，不是采购或实施选型。继续寻找低成本历史状态来源，与Grok结果交叉复核。不迁移现有EVM RPC，不因候选源存在就跳过费用、完整覆盖与小时边界验证。“从当前开始自存状态、逐小时暖满四天”仅为待确认替代建议，尚未获批，不改变四天历史验收门，不能伪称已补历史。

低成本交易层与历史状态层必须分开核价。Helius现行套餐表有Free（0美元/月、1M credits/月、标准RPC 10 req/s）和Developer（49美元/月、10M credits/月、标准RPC 50 req/s）；其历史资料列出getSignaturesForAddress/getTransaction/getBlock等归档交易方法。该信息只支持低成本交易层候选，不证明低价档包含getHistoricalAccountInfo，也不证明免费额度足够全目录生产采集。未创建账号、未配置密钥、未购买套餐；账户历史状态、实际覆盖与吞吐仍未实测通过。

### 费用与交易样本补查（2026-11-22，尚未通过金额验收）

- 官方SDK `MeteoraAg/dlmm-sdk` 的 `ts-client/src/dlmm/helpers/fee.ts` 中，splitFee将交易费分成MM和LO，再分别计算协议份额，返回fee为交易费减总协议费。因此SDK的用户fee可能包含限价单参与者收入，不等于普通MM LP费用。官方 `limit_order_and_collect_fee_mode.test.ts` 的纯限价单案例将swap.fee与limitOrderData.totalFeeAmountY核对，进一步支持该区别。这是SDK语义证据，不是Datapi历史fees字段的定义证明，不据此给Datapi做减法。
- 官方事件说明建议新索引器优先Swap2Evt，其字段分别包含mm_fee、protocol_fee、limit_order_fee、host_fee及费用币方向。仍需真实Swap样本及协议记账对账，明确这些字段的净额/扣减关系后才可写普通LP收入；不能仅按字段名假设再扣一次协议费。
- 公开RPC有界样本中，池0三条交易为流动性管理，包含ClaimFee/ClaimFee2等；领取不是本小时生成费用，同一次操作的两种兼容事件不能双计。池1五条及程序地址两条样本没有DLMM Swap事件。地址出现在交易账户列表中不证明调用该池或发生Swap，不能按签名数量计算swapCount。此次未获得真实Swap费用对账证据，不将此项勾为通过。
- 现场样本要求maxSupportedTransactionVersion:1；指定0返回-32015，改为1后取得JSON。后续交易读取须对源支持版本与解码能力显式校验，不能默认仅有legacy/v0；本次读取v1 JSON不代表SDK已验证全部v1反序列化或签名能力。
- 原始响应及SDK文件保留于 `node_modules/.cache/lp-atlas-s2-evidence/`（研究缓存，不是生产数据或持久证据依赖）。本轮仅查询公开接口并修订文档，未修改生产源码、测试、运行配置或运行库；此前46文件/291项的结果仍仅证明当时候选代码。

补充官方来源：

- SDK费用实现：https://github.com/MeteoraAg/dlmm-sdk/blob/main/ts-client/src/dlmm/helpers/fee.ts
- SDK限价单测试：https://github.com/MeteoraAg/dlmm-sdk/blob/main/ts-client/src/test/limit_order_and_collect_fee_mode.test.ts
- 事件合同：https://docs.meteora.ag/developer-guides/dlmm/program/events.md
- 低价档与交易历史：https://www.helius.dev/docs/billing/plans.md 、https://www.helius.dev/docs/rpc/historical-data.md

官方资料（本机已成功读取正文，原文及SHA可在本轮缓存核对）：

- Helius历史账户：https://www.helius.dev/docs/rpc/historical-accounts.md
- getHistoricalAccountInfo合同：https://www.helius.dev/docs/api-reference/rpc/http/gethistoricalaccountinfo.md
- 交易与分页：https://www.helius.dev/docs/rpc/gettransactionsforaddress.md
- 套餐/计点/限速：https://www.helius.dev/docs/billing/plans.md 、https://www.helius.dev/docs/billing/credits.md 、https://www.helius.dev/docs/billing/rate-limits.md
- Helius replay：https://www.helius.dev/docs/laserstream/historical-replay.md
- Triton Fumarole：https://docs.triton.one/solana/real-time-streaming/fumarole-persistent-streams.md
- Shyft replay：https://docs.shyft.to/solana-yellowstone-grpc/docs/getting-started/replaying-slots-with-grpc.md

### 本轮验证与未完成

### 后续真实Swap补查（2026-11-22）

此前未获得Swap样本的结论仅适用于当次少量采样；后续公开RPC一次getSignaturesForAddress取池0最新100条（当次20条err=null），有界取回11条交易，其中4条成功交易取得配对的Swap/Swap2Evt。失败交易即使有Swap日志也不能计入。以下是IDL字段研究解码与链上余额交叉证据，尚非官方SDK独立解码验收、全小时完整覆盖或Datapi字段定义确认。

- 签名 `4aPuEJBKjfzBCfRFHhMWpn1cMjqn2rxMwdioEnzjj6RM2g5UyaWN8Z2aqbjPWxzGBgvcjzXEd5UxhJEsnpp4zNdw`、slot472206105、outer1，同一操作同时发旧Swap及新Swap2Evt。旧fee=481811、protocol_fee=48181、host_fee=0；新mm_fee=433630、protocol_fee=48181、limit_order_fee=0、host_fee=0，满足481811=433630+48181。USDC原币储备增加1191296270、WSOL减少16947264492，与事件输入/输出对应。本样本新mm_fee已净去协议份额，不能再减48181。
- 签名 `55gcaVrqWWXEiu19qgaLJfAkWZ7NHnGriSbvzXMPwuScujg7Wa8h5yoJfox9bk2xAKstu9MmZeBFMCjGBWNX87Sk`、slot472206041、outer1，旧fee=2222、protocol_fee=178、host_fee=44；新mm_fee=2000、protocol_fee=178、limit_order_fee=0、host_fee=44，满足2222=2000+178+44。输入5523987，池USDC储备增5523943，差44与host一致。说明本样本protocol_fee是host划出后的协议余量，不可将该字段单独当完整协议侧；也不可在mm_fee上再扣host或protocol。
- 另外两条同池成功样本同样配对出旧/新事件、LO=0，且分别有X/Y费用方向。未取得LO>0、OnlyY或Token-2022实际Swap记账对账；不能将无LO证据推广为全部模式通过。
- 事件幂等须优先采用新事件，并识别同次调用的旧/新兼容事件，不能把两类事件各算一次Swap或两份费用。不能简单按整笔签名去重，因为路由可在同一交易多次调用同池；仍须绑定调用位置与事件序号。
- 研究响应：node_modules/.cache/lp-atlas-s2-evidence/pool0-fee-success-{5,9,13,19}.json；研究解码结果swap-fee-decoded-review.json。未将研究解码脚本放入生产、未改金额、未恢复API fees排名、未前推任何生产覆盖水位。

后续独立解码已完成：官方Meteora SDK提交1532e540db41ac405dbf4c5bb2ddfceaa1f98ff1的package.json（版本1.9.15）钉定Anchor 0.31.0；在node_modules/.cache隔离安装该版本（ignore-scripts，未改项目依赖/锁文件），用BorshEventCoder解码上述四笔成功交易的八个兼容事件，所有字段与研究解码逐一一致。提交固定IDL内容SHA256=045c0f4af044be046b6a14b350077e4242e8ac026b64a855803dab30fcdd8b35，与先前读取IDL相同。解码证据及原交易响应哈希保存在test/fixtures/meteora/swap-fee-sdk-evidence.json；这完成该四笔事件解码交叉核对，不覆盖LO>0、OnlyY、Token-2022、全小时漏页或Datapi fees定义。上段“尚非官方SDK独立解码验收”是补查时点历史，现已由本段补齐该局部证据。

### 隔离实测与代码验证

2026-11-22用户追加授权“先用官方或者公开的数据跑一下测试”：已执行两代表池有界隔离实测，7次官方GET（单页目录、两池元数据、两池24H及当前小时）与1次公开RPC批量读9账户；未读取密钥/运行库，不启停服务或启用生产扫描。最终一次实时读取、解析、迁移新建测试库、两遍小时提交及回读，脚本内端到端1761.9ms（不含tsx启动），DB阶段85.3ms。这是两池样本，不是全目录吞吐、稳态性能或金额验收。

- 两池各返回24个已结束小时及1个当前小时候选，共50行；重复提交后仍50行。缺失的原币成交、LP费、历史TVL保持NULL，complete保持false；未将当前账户余额倒填历史。Elysium/Robinhood测试库查询均无跨链混入，占位适配器仍拒绝刷新。
- finalized当前批量账户样本中，两池owner均为DLMM程序，mint精度、储备token program、储备mint和池authority关联匹配。只核当前身份关联，不证明池内全部字段、历史状态、全量资产安全或可参与性。
- 新发现：TTWO mint `TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo` 为Token-2022，样本含permanentDelegate、pausableConfig、confidentialTransferMint、transferHook（当次programId=null）、scaledUiAmountConfig等扩展。不把“有transferHook扩展”误写为当次有活跃hook，不推断存在转账税；兼容性仍unverified，不能按普通SPL余额差直接生成费用/TVL。目录和官方候选保留，未放行金额。
- 首次检查脚本错误地只接受普通SPL，因此在TTWO处失败，保留原失败记录；修正为身份核对与扩展兼容性分开后，先复用实测响应核对候选存储，再跑上述最终实时全程。不以修正检查器证明Token-2022产品兼容通过。临时脚本及数据均在node_modules/.cache，不改产品源码和测试。
- 最终摘要/测试库：`node_modules/.cache/lp-atlas-s2-public-BC1XQQ/summary.json`、同目录`candidate.db`；原失败采集：`node_modules/.cache/lp-atlas-s2-public-YCLrIY/`，用于定位脚本假设。原始响应和摘要区分实时采集与captureReused回放；不把约102ms的本地回放当网络耗时。

当前账户候选读取合同：在既有DLMM适配器增加公开RPC解析边界，依据显式请求地址与同批context.slot核对池program owner、mint精度、储备mint/authority/token program，保留原币整数余额与Token-2022扩展原始状态。它不解码DLMM bin/池配置、不证明API所报储备与池内字段完全一致、不声明可用历史状态或全量安全；普通SPL只标记当前身份关联匹配，Token-2022保留待审，不把扩展存在当活跃hook或转账税。仍不接默认扫描、不生成LP费/历史TVL。用本轮真实9账户响应作固定夹具，验证地址/精度/owner错配和缺失账户拒绝；不新增供应商绑定或生产RPC配置。

上述解析已实现于既有DLMM适配器，增加reserveX/Y及parseMeteoraCurrentAccounts；真实响应夹具为test/fixtures/meteora/public-current-reserves.json，注明公开临时RPC来源。30项DLMM定向测试通过（新增9项），服务端tsc与改动文件Biome通过；真实已捕获响应经产品解析回放通过。这不是新增网络性能结果，也不把先前291项结果冒称包含新增代码。未改依赖、运行配置、库迁移、前端或默认刷新；历史状态与费用门仍未通过。

Windows Node v24.11.1：全量46文件/291项通过（新增21项），默认npm run check退出0，三组类型检查通过；Biome仍72 warnings、50 infos。API tsc及Web Vite构建通过，输出仅node_modules/.cache/lp-atlas-s2-validation/build，未覆盖运行dist。日志在同目录full.log、check.log、build-web.log。真实HTTP范围只限上述官方小样本及公开账户读取，不把fixture检查当付费源实测。

此为新选型前的停点：现有代码仍是候选适配及事务能力，未完成采集。2026-11-22用户已确认先展示官方候选、接受费用/APR留空，并在本轮确定官方API主源；历史账户、独立SOL根价不再是本期候选启动门。费用模式未覆盖、源finality未知继续如实保存；当前实施顺序与验收以第12节和05顶部为准。


## 12. 官方 API 主源最终合同（2026-11-22）

本节落实用户“先用官方API，能显示就先显示”“官方候选TVL/成交两门槛”“同一页面聚合”“将官方接口作为主要接口”的决定。与旧完整链上重建路线的差别是来源与首期交付边界，不是降低EVM标准，也不是把未知费用改成已核收益。本节是方案，执行状态只见05顶部，不再维护第二份勾选清单。

### 12.1 官方资料与主源边界

| 用途 | 官方入口 | 本期规则 |
|---|---|---|
| 规格/额度 | [Data API Overview](https://docs.meteora.ag/developer-guides/dlmm/api-reference/overview)、[OpenAPI](https://docs.meteora.ag/developer-guides/dlmm/api-reference/openapi.json)、[Swagger](https://dlmm.datapi.meteora.ag/swagger-ui/) | 2026-11-22重新读取，官方写明全部DLMM API合计30 RPS；不把额度当性能承诺或每端点独立额度 |
| 发现/当前资料 | [Pools](https://docs.meteora.ag/api-reference/dlmm/pools/pools)、`GET /pools` | 分页、组合过滤、排序；优先从这一响应复用元数据、当前TVL及代币字段，不逐池重复取相同详情 |
| 必要补充资料 | `GET /pools/{address}` | 仅在列表缺少本期必需字段或定向核对时调用，不每轮固定补一次 |
| 小时累计 | [Historical Volume](https://docs.meteora.ag/api-reference/dlmm/pools/historical-volume)、`GET /pools/{address}/volume/history` | `timeframe=1h`，显式整点起止；保存官方成交及报告费用、协议费的源值 |
| K线 | `GET /pools/{address}/ohlcv` | 可提供OHLC价格；本期按需后续接入，不能冒充历史储备/TVL，不为缺省页另加请求 |
| 官网聚合服务 | `pool-discovery-api.datapi.meteora.ag` | 只保留研究对照；未找到官方文档/稳定合同，本期不依赖，不自动作为主源故障回退 |
| Solana公共RPC | 官方公开RPC/后续获批节点 | 当前身份、Token Program/扩展与费用研究按需读；不是每轮候选展示必经路径，不购买Helius Business或迁移EVM节点 |

“只用一套官方API”指同一文档化数据服务的列表、详情、小时端点；不是每轮只有一个HTTP请求。第一期无需密钥的事实来自本次公开请求成功，不代表官方承诺永久免费或无使用限制。

### 12.2 本轮证据与纠偏（独立API研究，不冒充产品验收）

| 检查 | 本轮事实 | 可采用结论 |
|---|---|---|
| 基础候选 | 正式文档版 `/pools` 按TVL/滚动1H成交筛出292池；另一时点293/294池，不能视为固定池数 | 单一正式源已能发现候选，不需另扫全DLMM目录 |
| 七个滚动窗口 | 同一292池在官网聚合API的5m/30m/1h/2h/4h/12h/24h共2044个池窗口均返回 | 证明官网窗口能力；不是生产必须调用聚合API的理由。正式列表本次实际返回30m至24h六窗，5m未返回 |
| 四天小时 | 正式历史API返回292×96=28032个闭合小时标签，无缺标签、重复或负金额 | 有足够数据推进小时累计；标签齐全不证明每个补0值已经逐笔验证 |
| 结束边界 | 三代表池exact/wide/repeat同小时一致；旧样本minus1对应响应end下对齐至小时起点 | 必须请求到下一整点并丢终端标签；撤销“边界例子证明完整小时不稳定/历史不可用”的泛化。不要端点减1秒 |
| 跨粒度对账 | 三代表池96小时对照2h/4h/24h，主要为浮点尾差；SOL-USDC某日仍差$45.002053成交、$0.016726费用，cbBTC-USDC某日差$0.141691成交，重查仍存在 | 本地只从同一1h档累加全部长窗，不混用上游不同粒度金额；不擅自改源值凑平 |
| 两API当前值 | 1h样本42池TVL、37池成交、35池费用不一致；单池即时重查仍有差异 | 不能拼成一个“同步快照”；选择一个主源，固定本地发布版本，不把差异原因未经证明地全归为缓存 |
| APR字段 | 292池的 `apr` 均等于24h费用÷当前TVL×100 | 数值实测为日费用百分比，不直接当年化百分比；本期LP费/APR留空，后续验证后按本地既定公式重算 |
| OnlyY费用 | SPCX-USDC三个完整5m、各一笔成功交易；API费用/协议费分别与Swap2Evt的mm_fee/protocol_fee按同一USDC/USD换算闭合 | 三样本无LO、host；该模式已得到对应证据，不能再次扣协议份额，也不推广到未见分支 |
| InputOnly费用 | cbBTC-USDC两个完整5m单成交；API费用/成交与mm_fee/amount_in比例误差约1e-15 | 补齐该两样本，仍未核非零LO/host或全部Token-2022真实分配；不据此放开全库LP费用 |
| 字段 | 40个DLMM正式源样本28个顶层字段、聚合源61个；DAMM V2只读研究20池 | 采用12.6字段矩阵；DAMM V2研究不等于启用 |

研究原始响应在本机 `node_modules/.cache/meteora-site-review/`：`complete/summary.json`、`checks.json`、`aggregate-summary.json`、`final-detail.json`、`fee-chain-comparison*.json`、`fields/field-inventory.json`与`filter-controls.json`。这些是可清理缓存，不是运行依赖；本节保留复核参数和结论，后续代码只把必要小夹具纳入既有test/fixtures，不复制全套研究文件进产品。

OnlyY例：链上mm_fee=641、协议费=71（USDC最小单位），API分别为0.000640513842585974美元与0.000070946151050864美元，两者都对应USDC/USD≈0.9992415641；不是用总费712再扣两次。两种兼容Swap事件只计一次；失败交易即使有事件也不能计费。

本次追加现场复核（2026-11-22上海12点所在小时）：官方Overview、OpenAPI均返回200，Overview仍明确全部DLMM API合计30 RPS；OpenAPI列有列表、详情及小时历史端点，历史起止参数均为inclusive。过滤列表单页样本返回200、当时总数284，仍为28个顶层字段；284与前述292是不同观测时点，不能当作固定规模。SOL-USDC暖范围`[H-2h,H+1h]`返回4个标签、冷范围`[H-96h,H]`返回97个标签（本次H=1795320000），丢终端后分别为3/96个小时。此次少量复核支持现行请求合同，没有重跑全池性能或全库金额验收。

### 12.3 发现、准入与按池采集

1. 默认发现请求：`GET /pools?page=1&page_size=1000&filter_by=tvl>=1000 && volume_1h>=100&sort_by=volume_1h:desc`，参数须用URLSearchParams编码；按响应页信息读取后续页。1000为磁盘补丁的页容量，运行进程仍为100，待正常重启加载；仍受900KB响应上限约束，不保证1000池可装入一页。只查DLMM正式源，天然不混DAMM，不遍历十几万全目录。
2. `volume_1h` 是上游滚动1h，只用于发现粗筛。真正本地1H准入与主站一样，以既定当前整点小时累计为准，当前小时可能尚未结束；不得把滚动值标成同一个小时。官方候选模式采用当前TVL≥1000、该1H成交≥100，不应用LP费10门槛。当前小时尚无有效成交值时不以滚动值强行代替。
3. 目录每5分钟重取过滤后的列表，允许新池/旧池重新起量进入；现有元数据按原链+协议+原始地址复用。请求结果本地版本化，身份Base58保持大小写。不得把过滤列表遗漏当池被销毁或全链无成交，也不删除旧业务历史。
4. 页2失败、页间重复/排序变化按源变动或失败记录，不将不完整列表标“全场所覆盖”；保留上次成功发布和已提交池历史，下一轮重新发现。只校验本次可证的分页/地址/金额事实，不宣称上游提供固定快照。
5. 对本轮候选获取小时累计；元数据/当前TVL来自同一正式源列表。默认不额外读取每池储备、bin arrays、mint、根价或单池详情。不反推原币，不执行全程序getProgramAccounts。
6. 列表不返回的必要字段须按12.6能力处理；附加高级筛选留空时不触发额外条件或外部调用。用户选择过窄条件导致0池，页面保持既有清空/重置行为。

### 12.4 小时、首次回补与续接

令 `H=floor(now/3600)*3600`。所有内部时间为Unix秒，展示用上海时间。

- 首次旧档请求 `[H-96h,H]`、timeframe=1h，丢弃H终端标签，得到最多96个闭合小时；新池创建前缺值须与源报告0区分。当前小时另读到 `H+3600`，不能把97小时塞进当前适配器最多96小时的单次范围。冷启动不是每轮重复四天。
- 暖轮每池一次请求 `[H-2h,H+3600]`，丢弃终端 `H+3600` 标签：一次取得前两闭合小时和当前小时，覆盖续接及近期晚到修订。当前小时桶按官方响应保留；未来的请求上界仅选择桶，不是未来源数据或已采到的截止。
- 当前小时 `complete=false`。闭合小时按“官方报告小时已返回、范围/字段校验通过、同事务提交”的累计语义记录覆盖；`finality=unverified`、`dataCutoff=null`仍保留，不能借complete或HTTP200宣称链上最终完整。实现须区分小时可用于官方累计与链上覆盖证据，不能沿用旧complete=false守卫把全部历史永久隐藏，也不能改EVM完整性含义。
- 代码落点须显式区分两种证据：新增官方累计覆盖语义（具体共享字段随实现确定），按池/小时表示报告值已取得并提交；现有`assertSourceCompletion`对“源已最终完整”的要求不放松。官方累计的窗口可用性依据前者，不能为了进入长窗口把`finality`改为finalized、伪造`dataCutoff`或将旧`complete`直接改成true。当前小时与闭合小时的状态仍须区分，页面不把可累计等同已最终封口。
- 当前累计/元数据批次先提交并发布，让候选先可见；新池四天旧档有界补齐，长窗逐步可用。沿用既有按链任务与checkpoint，不新增定时器或第二套修复服务；同链正忙跳过下一拍，不叠跑，不把Solana历史任务锁扩散到EVM。
- 同小时是累计覆盖upsert，不是五分钟增量相加。按链/协议/池/小时定位，源schema作为版本元数据，不额外并存多份同小时有效值，不改EVM物理主键；数据、局部覆盖、发布版本同事务提交。请求开始时间只用于防本地旧响应晚到覆盖，不能冒充源revision。跨轮合法源修订即使金额下降也不能简单取max；保留必要revision及观测时间。
- 冷补只写所请求的旧小时及对应覆盖，不用冷补开始时的列表/TVL覆盖较新的当前元数据，不覆盖已提交的较新小时响应。冷补或定向修复改变六窗口结果后，同事务推进该链发布版本，让网页自动读取更新后的长窗；只更新小时表却不发布不算接通。
- 覆盖范围仅为本次成功查询的池/小时集合，不能用过滤后的候选列表签发全场所覆盖，也不能把未查询池当0。API明确返回0可记官方报告0，源finality仍未核；缺标签/缺字段是NULL，LP费仍未知，不设verified_zero。
- 96小时外回访不在每轮全量重拉。近期两小时自动重读；更旧的已发现差异用既有定向修复能力，不能把同一已归因未知项无限放入热路径。
- 1H/2H/4H/6H/24H/3D全部复用既有 `currentAndPreviousWindows` 和同口径小时累加；不新增5m窗口/快照。缺哪小时就只让依赖它的指标缺值，保留当前准入行。当前TVL是时点量不累加，不填回96个历史TVL；上一窗口无法覆盖则环比留空，四天保留不足以提供完整上一段3D，不自动扩大保留期。

### 12.5 费用、估值与缺失合同

- 官方成交、报告费用及协议费用以 `official_usd` 的独立来源/版本保留。本期用户已接受这种官方美元候选展示，不再要求先采购历史账户服务或接SOL预言机；不标成RedStone本地估值或已核链上金额。
- `reportedFeesUsd`、`reportedProtocolFeesUsd`作为来源字段，与已验证普通LP费用分开；本期通用 `lpFeesUsd`、fees APR仍为空。不得将reported fee直接塞入LP费用、复制上游apr、用费率乘成交量、减未知协议份额，或把未知标verified_zero。未来只对得到充分证据的规则/版本放行，不用五个样本泛化全库。
- TVL、成交量及当前池价格可按官方报告展示；无历史TVL、原币成交/费用、可靠小时Swap数量、价格边界的字段保持NULL。列表滚动统计中的swap_count（聚合版）不能回写成正式小时的交易数。
- 当前代币报价可用于代币资料，不用于反推历史原币、补历史TVL或计算本期尚未确认的价格涨跌。WSOL不按名字映射ETH/HYPE，Token-2022扩展也不能靠官方列表缺少警告宣称安全。
- 原币、源finality、独立SOL报价、精确LP收益、Token-2022实际分配作为后续增强。它们不再阻塞已批准候选的TVL/成交显示，但未验证指标不得改成已完成。

### 12.6 同页聚合与字段矩阵

在现有主站局部扩展，不复制Meteora页面、不新增Solana看板或第三个右侧面板。保留既有搜索、排序常显、中央漏斗、链名列、详情和交易占位及对齐标准；后端统一取数，浏览器只访问本服务。每个字段沿“外部解析→shared类型→同链元数据/小时存储→API→列表/详情/筛选”核对；不把未解析的上游JSON直接穿透到页面。

| 字段组 | 正式DLMM源 | 本期使用及位置 |
|---|---|---|
| 代币/池身份 | address/name；token_x/y的address/name/symbol/decimals；created_at | 主表原字段、详情、搜索与复制；创建时间按接口毫秒转换，缺时间不猜池龄 |
| 当前TVL/池价格 | tvl/current_price | 主表当前TVL、详情；不与历史时点或USD代币报价混名 |
| 成交、报告费、协议费 | volume/fees/protocol_fees及各窗口、cumulative_metrics | 主表成交来自本地小时；报告费/协议费与累计统计可在详情按来源显示，主表LP费仍空 |
| 费率与DLMM配置 | pool_config.bin_step/base_fee_pct/max_fee_pct/protocol_fee_pct/collect_fee_mode/pair_type；dynamic_fee_pct | 保留原费率字段，详情解释基础/动态费与Bin Step。collect_fee_mode是枚举，0 InputOnly/1 OnlyY，保留原值和协议映射，不套EVM pips或tick |
| 代币资料 | token_x/y.price/market_cap/total_supply/holders/is_verified/freeze_authority_disabled | 详情优先；不是安全担保。freeze_authority_disabled与聚合版has_freeze_authority语义相反，不能直接同名拷贝 |
| 储备/奖励 | reserve_x/y、token_x/y_amount、reward_mint_x/y、has_farm/farm_apr/farm_apy | 详情按能力显示；余额是当前API报告值，不是历史链上重建。激励年化不与fees APR相加 |
| 比率/年化 | fee_tvl_ratio、apr、apy | 只保留来源语义供核对；本地资金效率遵守原公式，不把Fee/TVL当资金效率，不把日费用率当年化 |
| 归属/标记 | launchpad/tags/is_blacklisted | 资料与已有风险体系按字段语义展示，不因此擅自新增全站默认过滤 |
| Active TVL/Organic Score | 正式响应未返回数值；实测可用active_tvl/base_token_organic_score筛选 | 不为补数字接第二API。本期默认不增加这些高级门槛；后续专属筛选需说明可筛选但暂不展示数值，不能当完整文档承诺 |
| token age/FDV/集中度/dev余额/warnings | 本次仅聚合版返回这些丰富字段 | 本期标不具备，不反推/不填0/不启用依赖它们的前端条件；为可选扩展留类型能力，不新增主源请求 |
| Swap/LP/资金进出/活跃仓位/波动 | 本次仅聚合版返回swap_count、unique_traders、unique_lps、net_deposits等 | 后续研究，本期不从官网抓取或展示空壳列 |
| DAMM专属配置 | DAMM正式源有集中流动性、动态费、调度、锁定数值；聚合版还给锁定比例等 | 只作字段研究；不可用锁定流动性数值÷TVL臆造百分比，不在DLMM迭代接DAMM |

正式源部分未文档化过滤字段实测有效：active_tvl、base_token_holders、bin_step、base_token_organic_score的极端门槛返回0，非法字段返回400；这不等于所有官网字段都在正式响应中返回。Presets是浏览器筛选预设，不是行情API字段。个别聚合样本Active TVL大于TVL，尚不能证明同一时点/估值基准，禁止拿来覆盖正式源TVL。

字段校验在外部解析入口集中完成：身份、精度和金额等必要字段无效时明确隔离该项；名称、图标、资料或非必需储备字段缺失不应把身份/TVL/成交已可用的整个候选丢掉。当前账户严格校验函数保留在按需研究路径，不强制加入每轮候选采集。

默认主表不新增一排高密度扩展列；先把正式源已具备的资料接到原详情。原有EVM三门槛及默认fees APR排序保持，Solana未知LP费不算0参与收益排序；已有TVL/成交等可用排序仍可操作，空值稳定排序。选择专属字段时，缺能力不等于数值为0。来源/更新时间放详情既有区域，不在顶部或行间插入后台计算备注造成跳动。

### 12.7 请求预算与性能目标

- 本期使用既有HTTP客户端，独立超时18秒、解压后900KB上限、发现分页1000条（官方上限，仍受900KB约束）、有限退避；不继承EVM日志360秒等待。总限流器覆盖列表、历史、详情、回访和重试，官方上限30 RPS不按端点叠加。
- 正式小时API追加实测：4并发/目标8 RPS，16请求2.056秒，全200，P95 389ms；8并发/目标16 RPS，32请求2.116秒，全200，P95 331ms。请求为不同池的`[H-2h,H+1h]`，不是此前官网聚合API59 RPS的缓存短测。只证明本机短样本，不是持续上限或产品整轮验收。
- 因上述正式源样本，候选实施参数为并发8、共享16 RPS，保留官方30额度余量；遇429遵守Retry-After/有限退避并结束本轮失败部分，不提高并发补偿。参数在现有配置内实现，不另引入调度框架。
- 冷补、重试与当前请求共用这一预算；冷补按未补齐池逐批提交并记录可续接进度，失败不使下轮全部池重新冷补。实施时在现有任务配置明确有限重试次数和历史批次预算，并纳入整轮计时；不能把“有界”实现为无限重试或永久占链锁。下一拍忙则跳过的规则不变，不新增抢占式调度。
- `R暖轮≈ceil(N/1000)+N+必要失败重试`；前两小时复核包含在每池同一历史请求内。新池冷补额外每池一次96h请求；不重复取详情/储备/价格。页容量1000时，N=292约293请求/轮，按16 RPS算排程下界18.31秒，尚需网络尾部、校验、提交及发布；绝不能据列表1.23秒承诺整轮1秒。若N=1000约1001请求，下界62.56秒，仍须现场测。
- N=292固定一整天、每5分钟暖轮的算术量约84960请求/天；四天冷补额外292次（当前小时另计在暖轮），不等于每日重拉四天。候选数会变化，记录实际请求/字节而非按固定池数计费。
- 验收报告当前小时首次发布与整轮耗时分别给出，区分首次冷补、正常暖轮、修复与源等待；10–20秒是既有优化目标，当前未证明达到。五分钟窗口内是否容得下按真实池数/失败预算核算，不裁剪候选或改准入去凑速度。

### 12.8 实施依赖与验收范围

| 顺序 | 必要改动 | 当前事实与验收要求 |
|---|---|---|
| A 方案/政策 | 本文、05、决策清单、场所路径、17的现行引用 | 已同步，新路线以本文0/12节为准，旧完整收益阻塞不能挡候选 |
| B 官方适配 | `src/adapters/venues/solana/meteora-dlmm.ts`、既有`official-index.ts`与相关测试 | 通过；完整分页/粗筛、资料复用、小时边界、共享预算、有限重试和单池异常隔离 |
| C 归一/存储/发布 | `src/shared/meteora.ts,types.ts,source-contracts.ts,venue-sources.ts`、`store`迁移015、`normalize/official-refresh.ts,official-board.ts,refresh-pipeline.ts` | 通过；沿用同一小时表/checkpoint/事务，官方报告覆盖独立于finality，原EVM路径保留 |
| D API/同页显示 | 既有`server/app.ts`、board查询/详情、`web/src/BoardPage.tsx,QueryFilterDialog.tsx,SixWindowTable.tsx` | 通过（隔离范围）；缺省开关关闭，12.10已显式启用；字段审计及生产未决项见第13节 |
| E 统一验证 | 既有Vitest、类型/构建、临时库与真实入口 | 通过（代码与隔离范围）；具体事实和未验边界见12.9 |
| F 部署与观察 | 唯一服务版本、配套备份、按链五分钟刷新 | 部署已执行，整体验收未通过；分页补丁待加载、小时缺口诊断待修，见12.10/13。回滚须配套库备份，不能旧程序直接写新库 |

必须覆盖：分页失败保留旧结果；大小写/Token-2022身份；毫秒/秒；整点与minus1反例；当前小时小于整小时、跨整点续接；同累计重读不翻倍；旧响应晚到和源合法下修；NULL与报告0区分；新池/旧池重入；窗口缺档局部留空与3D上一窗口不足；API→页面全字段/搜索/排序/翻页/刷新；EVM采集与原三门槛、费用、报价、分页不退化；429/超时隔离与同链忙则跳过。

本期完成标准是：获批官方候选从真实API进入同一存储/发布路径，现有页面能按链查看并自动更新，已具备的六窗口成交可正确累计，未知LP费/APR不伪造；不再以等待付费历史账户、独立SOL报价或全模式精确收益作为这一结果的前置。完整LP收益归属另有实质证据后再申请启用对应指标，不扩大本期到DAMM、Raydium、BSC或钱包。

### 12.9 S3实施与隔离验收（2026-11-22）

本节记录部署前代码与隔离验证的历史事实；当时生产部署、运行库迁移与生产观察均未执行，随后部署事实见12.10，最新审计见13。任务勾选只在05维护。

- **正式主源接通**：既有适配器/HTTP客户端实现完整发现分页与字段解析，共享8并发/16 RPS、18秒/900KB、最多一次重试并遵守Retry-After。暖请求由8个连续工作线程取任务，避免整批等待最慢请求；全部端点共用预算。单条必要字段损坏隔离该池并记录诊断，分页错误仍整批拒绝，不能以截断列表替换旧发布。
- **存储与发布**：迁移015只追加官方资料/报告费/目录时间字段，不重建或削弱014约束。`official-refresh.ts`复用`commitHourCheckpoint`及原表，目录/代币/资料/小时/覆盖/链发布同事务；当前先发布，历史缺档每轮最多128池、每批8池，240秒后不再启动新请求，在途请求仍受独立超时约束。冷补续用已存覆盖，不每轮重拉四天；官方报告覆盖不等于已核finality，普通LP费仍NULL。
- **同一产品页面**：`official-board.ts`只归一来源差异，沿用现有board API/快照分页/六窗/搜索/排序/中央漏斗。当前TVL和整点1H成交两门槛，长窗不足只留空该窗，未知LP费/APR不造0。正式元数据共用`shared/meteora.ts`，资料接原详情，原交易占位保留；没有新增第三个面板。
- **兼容遗漏修复**：真实临时联调的全站手动刷新也触发了临时Elysium任务，暴露旧`persistDiscovered`批量SQL未写迁移014必需的`chain_key/native_pool_id`。已补这两个字段，保持原EVM外部主键和批量写入；回归改为实际返回V3 PoolCreated/V4 Initialize，覆盖此前预置目录漏验的写入路径。没有修改EVM金额、节点、准入或调度规则；该异常不涉及运行库。

真实API仅写`node_modules/.cache/meteora-site-review/`临时库，临时API/Web端口8797/8798，未启动自动调度；手动刷新走原HTTP入口。实测如下（池集合随市场变化）：

| 样本 | 候选/请求 | 当前首次发布 | 整轮 | 说明 |
|---|---:|---:|---:|---|
| 初始第1轮 | 279 / 410 | 25.7秒 | 42.2秒 | 含128池四天冷补，旧批8排程 |
| 第2轮 | 280 / 411 | 25.5秒 | 42.4秒 | 继续有限冷补，旧批8排程 |
| 第3轮 | 280 / 306 | 25.4秒 | 28.7秒 | 仍有冷补，不能称纯暖轮 |
| 连续worker版 | 282 / 287 | 22.8秒 | 24.1秒 | discovery 1.27秒、warm 21.55秒、history 1.29秒；含2池冷补，无请求缺口 |
| 页面手动刷新 | 287 / 未单独计请求数 | 未单独计时 | 26.4秒 | Solana任务成功，页面自动更新到260个达标池，详情资料同步 |

连续worker样本当时251个达标池，第一页50行有47行具备3D成交，缺长窗行仍保留；随后手动刷新为260行。两组数不是同一时点的固定集合。以上不证明生产稳态、严格五分钟新鲜度或每轮10–20秒。

**验证结果**：48文件311项通过，三套TypeScript检查与隔离API/Web构建通过；默认Biome检查无error，85 warnings/50 infos，未为消除既有提示扩大重构。定向覆盖六窗算术、NULL/报告费区分、同小时下修不重复、跨整点/重启、旧目录晚到、故障原子回滚、空目录、历史延后、HTTP刷新/快照详情及默认禁用。故障SQL测试使用同一libsql迁移与事务的内存库，避开Windows故障语句对象延迟释放文件；跨整点/重启仍用真实临时文件库。页面核搜索6行→清空恢复251行、排序、第二页、切链返回、资料与交易占位、手动刷新后自动载入，末次浏览器无error。日志、临时库和截图`s3-board-final.jpg`保留在上述缓存目录；临时服务已结束。

**部署方式与边界**：新增`SOLANA_DLMM_ENABLED`严格布尔开关，缺省`false`；只有显式开启才把DLMM加入原五分钟定时器及按链互斥。后续部署须先备份运行库并核014/015迁移，再启用唯一服务，核Solana发布与EVM连续采集；未获得部署/恢复授权前保持现有运行配置。回滚恢复配套旧程序及迁移前库，禁止旧程序直接写新结构。源完整水位、普通LP精确收益、历史TVL、独立SOL根价和Token-2022分配仍未验证，不冒充本期已完成能力。


### 12.10 生产部署与观察（2026-11-22，进行中）

用户明确授权推进后，先核原3001/5173均无运行服务，再备份程序、配置及013库/WAL/SHM至`outputs/rollback-solana-s3-20261122-130312`。014/015迁移后`quick_check=ok`，对备份全量比对pools、tokens、window_aggregates、scanned_hours、chain_publications、meta、usd_repair_deferrals七表旧字段及行数一致（182373条小时金额保留）；VACUUM后约1.19GiB，不放宽2GiB准入。回滚必须恢复配套旧程序和备份库，不可用旧程序写新库。

13:07启动唯一API9556/3001与Vite13284/5173，显式`SOLANA_DLMM_ENABLED=true`；同一五分钟调度、按链互斥及原EVM节点保持。日志`outputs/service-api-solana-s3-20261122.stdout.log`。Elysium2647成功88.5秒（停机积压回补）；Robinhood2648仍回补并持续提交。Solana2649因`Duplicate Meteora pool across pages`在2.6秒拒绝目录，未发布截断列表，按12.3合同等待下一轮重新发现。真实发布、后续自动续接和主站观察待完成，不能将隔离通过代替生产结果。

13:12第二次自动触发后，Robinhood2651成功12.4秒；Solana2652成功65.4秒，292候选、12398条小时写入（含首批128池四天冷补），当前189池达标，未出现请求缺口。主站已核切链、六窗、空LP收益、Base58、DLMM资料及原交易占位；API全量189行中812个非空窗口成交与库内小时Decimal累加完全一致，322个缺窗保持NULL，六窗LP费/APR均NULL。Elysium2650部分成功72.4秒：40条缺口，抽样为临时公共RPC的Rate Limit Exceeded（储备读取），不是Meteora调用；原节点未更换。下一轮自动续接仍在观察。

部署观察修正：2649跨页重复、2655候选总数变动，均按合同拒绝且保留旧发布。官方Pools文档明确page_size最大1000；本机使用同一正式适配器实测313池单页633326字节、653ms，无后续页。在不改粗筛、排序、900KB/18秒上限和完整性检查的前提下，发现页容量改1000，以减少当前规模下动态分页漂移；未来超1000仍须逐页校验，超过字节上限仍失败保留旧发布，不承诺源固定快照。此项为已授权S3部署中发现缺陷的必要修正，不改变产品规则。

**收尾受阻**：100→1000发现容量修正已完成，41项受影响测试及后端TypeScript编译通过；官方313池单页实测在原900KB上限内。2026-11-22 13:19后，核三链空闲再重启API的命令被自动审批拒绝，仅返回`blocked by policy`，没有执行停机或启动；未尝试绕过。API仍9556/3001、Vite13284/5173，运行进程仍加载100页旧版，磁盘编译产物已包含补丁。需正常重启API加载后续验自动发布，未标整体验收通过。页面截图`outputs/solana-s3-live-20261122.jpg`为当前已发布189候选，不能冒充补丁上线结果。


## 13. S0–S3字段与生产收尾复核（2026-11-22）

> 后续实施授权：用户已要求按方案与05更新代码、完成S3，并明确要求直接重启3001。下文“只修文档”为上一轮审计边界，本轮代码事实及未完成事项见13.7；S4仍不启用。

本节统一本轮只读代码、运行库、定向复验与官方字段复核结果，不新增第二份任务清单。执行项只在[05顶部](../04-standards/05-roadmap.md#方案18--meteora-dlmm-官方-api-主源2026-11-22)维护。本轮只修订文档，未改产品代码/测试、未重启服务、未重新迁移运行库，不启动S4。第12节合同继续有效，以下补足已证实缺陷和未核字段，不能以旧稿状态覆盖当前部署事实。

### 13.1 阶段结论与验证范围

| 阶段 | 已核结果 | 仍未完成或限制 |
|---|---|---|
| S0 标准与能力合同 | 通过（本轮核查范围）：官方USD候选例外、身份/来源/NULL和覆盖合同已有 | 本节收紧费率/APR语义和缺小时状态；不将原完整收益路线的旧阻塞恢复为候选前置 |
| S1 身份与存储 | 通过（本轮核查范围）：字符串链身份、Base58大小写、可空EVM字段、迁移兼容未发现新缺陷 | 此结论不等于SOL所有业务字段或生产稳态已通过；回滚仍须程序与库成套恢复 |
| S2 官方适配与字段解析 | 主要路径已接通；历史解析能返回missingHours；分页保护会拒绝漂移而保留旧发布 | 发现容量100→1000补丁待加载；dynamic_fee_pct与max_fee_pct语义待核；不放开普通LP费用 |
| S3 存储/发布/API/页面/调度 | 已部署并有真实发布；六窗空值、官方成交和当前TVL链路已有验证 | 确认缺小时未完整计入运行诊断；加载补丁后的自动发布与最终页面验收未完成，不能标整体通过 |

本轮复验既有`solana-foundation`、`migration-014`、`venue-sources`、`compose-windows`四文件29项通过。复用此前分页补丁41项测试及后端编译、S3隔离311项与迁移旧字段对照，不重复制造全量验收。运行库只读检查：SOL有23739条official_usd小时，原币均NULL、LP费均NULL、历史TVL均NULL、complete均未伪置true；SOL非空chain_id/tick_spacing/created_block或native_pool_id与官方address不一致的记录为0。EVM对应小时仍为native_amounts。以上是13:24左右快照，行数会随续接变化，不代表四天已全覆盖。

### 13.2 SOL与EVM同义字段及不可互换字段

| 含义 | EVM现有路径 | Solana DLMM来源及统一结果 | 禁止混用 |
|---|---|---|---|
| 链/池身份 | chain字符串与兼容数字evmChainId；旧EVM主键保持 | chain=solana，数字链字段NULL；原始Base58地址与pool:v1编码存储键分开 | 不小写Base58，不用虚构数字链号，不把内部键当合约地址 |
| 代币顺序/精度 | token0/1与链上decimals | token_x/y依序映射token0/1，保留decimals与地址大小写 | 不按名称重排；已是美元的金额不再次除10^decimals |
| TVL | 业务链储备/状态估美元 | tvl→currentTvlUsd→行tvlUsd，当前官方快照 | 不填回历史小时TVL，不把token price或current_price当TVL |
| 成交量 | 原币Swap累计后估美元 | 小时history.volume→volumeUsd，official_usd | 不再乘报价；列表rolling 1h只发现，不替代整点小时 |
| 原币/笔数 | 原币整数、swap_count | 正式小时无这些能力，原币及笔数NULL | 不由美元反推、不从官网聚合口径拼笔数、不填0 |
| 费用 | 已有lpFeesUsd及feeStatus | fees→reportedFeesUsd；protocol_fees→reportedProtocolFeesUsd | 不直接当外部LP收益、不按名称认定两者需相减；lpFeesUsd/APR继续NULL |
| 六窗/覆盖 | 同整点小时累加及业务链游标 | 同小时累加；每池成功请求的小时覆盖与请求版本 | 缺小时整窗NULL，不把observedAt当源截止，不伪造区块/slot或finality |
| 时间 | 区块/报价时间秒 | created_at毫秒转秒；history起止与timestamp为秒；observedAt为读取时间 | 不把本地读取时间当源发布或最终完整水位 |
| 池结构/费率 | tickSpacing、固定feeTierPips、Hook权限 | binStep独立；base/dynamic/max及协议比例保留来源字段；固定feeTierPips为NULL | 分箱不是tickSpacing；DLMM不是EVM Hook，动态费不能冒充固定费率档 |
| 资金效率/涨跌 | 对应窗volumeUsd/当前TVL；历史价格边界计算涨跌 | 资金效率沿用同一公式；价格边界不足，涨跌NULL | Fee/TVL不是资金效率；current_price是池内兑换比例，不是美元价格 |
| 来源APR/APY | 本地用窗口LP费用按实际时长年化，内部比值、页面转百分比 | 官方apr/apy仅保留原值，详见13.3实测 | 同名不代表同单位/窗口/收益归属，不直接参与本地APR排序 |
| 代币权限/配置 | EVM合约与Hook语义 | freeze_authority_disabled为冻结权限已禁用；collect_fee_mode按协议枚举 | 不与has_freeze_authority同向映射；缺字段不宣称安全 |

**前端条件边界**：全站共用漏斗/搜索/排序，但当前准入不完全相同：EVM原三门槛，SOL已获准只用TVL/当前整点1H成交两门槛。SOL的LP费/APR/涨跌未知时，不满足针对该空字段的数值条件；固定费率筛选不拿base/dynamic自动代入。上游已有TVL≥1000及滚动1H成交≥100的发现粗筛，降低前端门槛不会扩大尚未发现的候选集合。不能为让筛选有结果填0或暗改上游门槛。搜索的忽略大小写匹配不改变地址身份存储规范。

### 13.3 APR实测：复用必须先证明单位、窗口与费用归属一致

用户要求：本地年化与官方数值若同口径一致，可以直接复用；不因字段名不同而强制另算。本次2026-11-22北京时间13:29对正式`GET /pools/{address}`三个样本，使用每池同一响应的fees[24h]及tvl，调用当前已编译的真实`annualizeFeesApr`函数，窗口86400秒；仅为比较数学口径，将报告费用作为函数输入，不表示已承认其普通LP归属。

| 同响应样本 | 官方fees[24h]美元 | 当前TVL美元 | 官方apr原值 | 同费用/TVL本地简单年化（%） |
|---|---:|---:|---:|---:|
| SOL-USDC / 5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6 | 5338.258399353641 | 2765698.8937120317 | 0.1930166154923974 | 70.45106465472505 |
| cbBTC-USDC / 132hWzkrhLUvamLHpfikDTXXtCVXL3rxPNvkruqzX6sf | 11.086022485139168 | 92467.45772622748 | 0.011989107041270724 | 4.376024070063814 |
| TTWO-SOL / 7qZPiJ2Lvwh9DV9gUBH2EwConBE3RUrAvGRjpN8vTjtT | 1733.1409896820387 | 240115.89780339313 | 0.7217935195199505 | 263.4546346247819 |

三例官方apr均等于`fees[24h]/tvl*100`及`fee_tvl_ratio[24h]`；本地同金额24H简单年化百分比均约为其365倍（浮点尾差除外）。SOL-USDC官方apy=102.1483421293，也与`((1+0.1930166154923974/100)^365-1)*100`闭合；不能把含复利APY当本地简单APR。官方[Pools规格](https://docs.meteora.ag/api-reference/dlmm/pools/pools)只写“24 hour APR/APY”，不足以推翻响应的上述数值关系。此前292池研究与本轮三个样本相互支持，但不宣称每个未来接口版本永远相同，也不据API原字段推断官网最终展示错误。

结论是**当前API apr原值不能直接填本地年化列**。这不是禁止复用官方数据：费用归属核定后，若同窗口同TVL同单位证明一致，可复用；24H源字段换算也不能代替本地1H/2H/4H/6H/3D各自窗口年化。目前六窗仍以本地对应小时费用和实际时长计算的合同为准，普通LP费用未核之前继续留空，不把官方apr乘365后直接上线。

### 13.4 确认缺陷：缺历史小时未完整进入运行状态

`parseMeteoraHistory`返回missingHours，但`runMeteoraRefresh`暖/冷路径只消费已返回小时，未汇总该字段；暖路径另查当前小时，闭合旧小时缺失仍可能使refresh_runs.status=ok、gaps=[]。窗口缺档留NULL的行为正确，运行诊断未完整表达缺口，不能把一次ok解释成四天数据齐全。

本轮最小复现只用真实适配/刷新实现和内存libsql：池创建于200小时前，列表一池、page_size=1000；模拟成功历史响应始终遗漏H-3600（H=1795150800），其余返回合法小时。结果gaps=[]、run=ok，小时行96条（当前H加95个历史小时）；未写运行库、未增加旁路产品脚本。此复现证明缺口诊断缺陷，不证明美元金额或现有NULL规则错误。

**最小修复设计（未实施）**：消费已请求范围的missingHours，按池/范围汇总而非刷屏；区分源响应缺小时、HTTP失败、尚未轮到的冷补积压和创建前无须覆盖小时。创建时间未知不能猜作创建前豁免。预算未轮到的冷补记录待补，不能全部判失败；已请求的有效范围缺档需在本轮诊断/状态体现。保留成功小时及当前发布、缺窗NULL、源finality未知，不补0，不阻塞其他链。回归覆盖缺闭合小时但当前小时存在、创建边界、冷补预算与真实请求失败，不能只测当前小时缺失。

### 13.5 费率语义仍待核，不改金额凑解释

官方Pools文档将dynamic_fee_pct描述为base+variable，但13:29同响应实测SOL-USDC为base_fee_pct=0.04、dynamic_fee_pct=0.000688；cbBTC-USDC为0.04及0.0000007，两者均低于base。三个样本max_fee_pct均为0，尚未证明这是实际最高收费为0，还是接口特殊值。protocol_fee_pct文档为交易费用中的协议分成比例，不能当额外向交易者收取的同等费率。

当前代码把原值存入baseFeePercent/dynamicFeePercent/maxFeePercent等资料字段，详情显示“基础费率/动态费率/最大费率”；主表固定费率为空，未据此计算费用/APR。**待处理**：核对应接口版本、官方SDK/源码或可对账交易后确定动态字段究竟表示总额、附加部分或其他值；未核前不得自行base+dynamic或改名总费率。max=0含义不明时不得作为“最高只收0%”的结论。后续最小详情措辞需如实表达“来源原值、语义待核”，不增加主表冗余备注，不扩展采集请求。此项未完成，不改变金额、准入或排序。

### 13.6 运行、分页修正与Elysium边界

- 13:24左右只读快照：唯一API9556/3001、Vite13284/5173；同一300000ms调度按链互斥。Solana2658成功65.0秒并发布，Robinhood2657成功10.2秒，Elysium2656成功13.1秒。Solana2658的ok不能覆盖13.4诊断缺陷或证明所有冷补已完成。
- 运行进程仍为page_size=100；磁盘源码/dist为1000。41项测试/编译通过与服务已加载是两回事。此前重启命令被自动审批拒绝，仅返回`blocked by policy`，没有具体原因，命令未执行；没有证据归因于用户权限、套餐或Windows。本轮不重试、不绕过拒绝。此记录不是永久禁止重启；待按正常流程成功加载，再核自动续接。
- page_size=1000只减少当前规模动态分页次数。单页313池633326字节的研究样本使用pool_created_at排序，正式仍volume_1h降序；该样本证明响应规模，不证明正式排序获得固定快照。900KB先于1000池也可能触顶，多页仍可能漂移。保持完整性校验和失败保留旧发布，不裁剪候选、不盲目扩大体积上限；实际触限后再依据样本设计最小改动。
- Elysium2650/2653曾有40/20条缺口，抽样为公共RPC ReservesLens的Rate Limit Exceeded；2656已恢复成功。当前节点仍为临时公开RPC，不将“本次恢复”写成限流根治或历史全部补齐，也不能把它归因为Meteora字段或API。后续使用现有重试/续接观察，是否迁移节点另按授权处理。
- S3最终收尾仍需：加载已验证补丁；修复缺小时诊断；核费率语义及必要详情措辞；按最终发布重验六窗/空值/漏斗/详情/切链与自动续接，并确认EVM原路径未退化。S4未开始，不以本次字段核查授权启用其他场所。

### 13.7 S3收尾代码实施（2026-11-22，部署受阻）

本轮已按用户授权更新代码，执行清单只在05维护。

- `src/normalize/official-refresh.ts`暖/冷路径消费missingHours，排除确定创建前小时，按池/范围报告源缺档；成功响应缺闭合小时会记录partial。预算未轮到的冷补以pending_backfill记录warnings，不冒充源缺档；有效当前数据继续发布，不补0，不增加HTTP请求、迁移或其他链开销。
- `test/meteora-refresh.test.ts`新增暖/冷缺闭合小时、创建时间已知/未知、预算未轮到共5例。调用真实刷新与存储，核运行状态、诊断及窗口NULL/当前发布保留。SOL/窗口4文件57项、EVM/筛选/分页/调度6文件40项通过；三套类型检查、前后端构建通过。默认静态检查无error，85 warnings/50 infos；修正分页适配器及其测试既有行尾格式，不改分页合同。
- 已读取官方SDK的[getDynamicFee/calculateFeeInfo](https://github.com/MeteoraAg/dlmm-sdk/blob/main/ts-client/src/dlmm/index.ts)与[getTotalFee](https://github.com/MeteoraAg/dlmm-sdk/blob/main/ts-client/src/dlmm/helpers/fee.ts)：总费为base+variable并限MAX_FEE_RATE，SDK最大比例来自常量。该源码不能解释Data API动态字段低于基础费或max=0；仍不强行套算。详情仅标明动态/最大费率为来源原值及含义待核，协议比例称协议分成；5173已热加载并实看，不改变主表、金额、准入或排序。精确映射留待源证据，本期通过如实展示保留该能力边界。
- 13:42旧后端发布只读对账：同一snapshot翻页取得267池×六窗1602项，1564非空成交及资金效率与运行库对应小时累计/当前TVL一致，38个缺窗留NULL；LP费/APR/环比/涨跌未伪造数值。不以非空数推断四天全齐，也不将旧后端结果当新补丁生产验收。
- 原013成套回滚包保留；本轮额外保存原dist刷新模块及Web产物到`outputs/rollback-solana-s3-audit-20261122`，未再复制运行库。磁盘dist已包含1000分页、缺小时诊断和待补warning。
- 用户再次要求直接重启后，已核三链空闲，但正常API重启仍被自动审批拒绝，仅返回`blocked by policy`，无具体原因。命令未执行，旧API9556/3001与Vite13284/5173仍运行；未换工具或另起生产进程绕过。**S3尚未完成**：后端补丁加载、加载后自动续接/跨整点及最终页面联合验收待完成。普通LP归属、历史价格等既定后续边界不伪置完成。

后续独立联调（13:49–13:50，Asia/Shanghai）：确认生产SOL空闲、距下一拍有足够余量后，使用新dist与真实正式API，仅写内存libsql，不另起服务、不写生产库。发现308候选、297达标，311请求；发现页容量1000，当前23.949秒发布、整轮24.344秒，写入1116小时。只允许2池冷补，305池未轮到，run为ok且warnings持久记录pending_backfill，gaps为空；两池具备3D，未知LP费用/APR继续NULL。该结果验证新编译代码的官方源→存储→归一联通，不替代生产调度/跨整点验收，也未证明10–20秒目标。首轮检查脚本直接拼默认常量、遗漏可空筛选字段，误报无候选；改用真实parseBoardFilters入口后通过，未改变产品过滤逻辑。最小结果见缓存`s3-audit-real-compiled.json`，内存库已关闭，不新增持久测试库。
