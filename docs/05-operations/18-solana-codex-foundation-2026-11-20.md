# 18 · Solana 给 Codex 的基础交接包

日期：2026-11-20，Asia/Shanghai。性质：**审计结论＋接口与迁移草案＋真实小样本＋实施/验收入口**，不是产品补丁，不是生产启用授权。

## 0. 先读这页：已知、建议、阻塞分开

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

## 9. 连续实施切片与停点

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

## 11. 剩余阻塞和最短接手指令

### 阻塞（不等于什么都不能做）

1. Datapi `fees/protocol_fees` 与普通MM LP/LO/host准确映射未证，禁止费用准入/APR；官方事件定义已找到，但索引层语义未找到。
2. Grok报告端点边界反例及96小时标签连续，Codex尚未独立复现；原样本未落本机。源asOf/finality、晚到修订仍未知，不宣称双方或全站完整验收。
3. 历史TVL/原币/价格边界缺少可验来源；历史交易archive不等于历史账户快照。
4. SOL历史根价未选定、未实测；Pyth/RedStone只是候选，official_usd是否接受及估值版本待审核。
5. API/迁移未获破坏变更批准；现有v1/v2均保护。结构/登记原子性、rowid/缓存/延期/meta依赖待验证，Codex须核真实schema和全部消费者。
6. 全站池数与生产预算未测；低成本全链索引不作承诺。

### 给Codex最短指令（可直接复制）

> 先读本机18；原始样本/manifest在助手侧未附本机，不当已取得附件；Grok边界报告待独立复现，403不证实也不证伪。可先审核底座，源语义门仍阻塞。在你会话授权内先修标准，再S1：保护旧EVM主键、rowid/缓存/延期/meta发现水位及现有v1/v2搜索排序分页/snapshot/poolKeys/详情身份，先验证结构与schema_migrations原子提交和故障恢复；Base58保留大小写。最小增量，不全站重写、不泛化包装、不用零/当前值掩盖错误。Solana仍listed不入默认刷新，DLMM费用/小时门过后再接，报价/调度/验收随后，Raydium独立下一片；不动BSC、DAMM V2、16、钱包开仓，不开生产。破坏变更/部署另候确认，内部细节不逐函数问。列实际改动/阻塞/真实测试，未跑不说通过。

## 修订记录

- 2026-11-20（北京时间）：四项复审融入0/2证据、3.3–3.6迁移/兼容、8–9实施、10测试、11接手；仅改本机18，未改产品/17/16/BSC/开关/服务，未传ZIP或证据、未新API复现、未跑产品测试。


- 2026-11-21（Asia/Shanghai）：按用户明确授权完成S0/S1离线实施；实际代码、测试、未做及回滚边界见[本轮实施交接](18-solana-s0-s1-implementation-2026-11-21.md)。此前“待实施”保留为11月20日草案历史，不代表生产已启用。


## 2026-11-21 S0/S1 Windows 清理复核与修复

用户明确授权核对、先记录再修复；历史“本轮仅MD”为此前复审边界，不覆盖本次授权。本机方案18已增量追加问题及计划，未覆盖 Codex 文档修改；代码仅在助手 checkout 实施。

已核实：两个新增测试 afterEach 无重试立即 rmSync，首错中断其余目录清理；legacy fixture 初始化、首次连接使用及 openDatabase 的 WAL 初始化有异常关闭保护缺口。migrate 失败已有 close，事务已有 finally close，不能误报缺失；安装的 libsql close 是同步 API，不能以加 await 代替释放验证。上述源码缺口并不证明就是 Windows EPERM 的实际根因。

本轮计划：补齐连接异常关闭保护并保留原始错误；临时目录使用 Node recursive rmSync 的 maxRetries:5/retryDelay:100 有界重试，全部目录尽力清理并汇总最终失败；补失败路径测试，在助手 Linux 跑定向/全量、check/build，不访问运行库或启动扫描。实际结果见[实施交接](18-solana-s0-s1-implementation-2026-11-21.md)。

Codex 历史 Windows 结果为250通过/8清理失败，并非本轮复现。其 CRLF 格式差异不作全仓转换理由；本机两测试/db.ts 为CRLF而biome配置为LF，未据此证明提交内容有误。Windows实际释放及回归仍待复跑；不启用Solana/S2，不动16/BSC/DAMM/Orca/钱包，不部署或迁移运行库。


本轮执行结果：助手Linux已修复上述异常关闭与有界清理，定向4文件/22项、全量45文件/267项、pnpm check及API/Web构建通过；check仍有72 warnings/50 infos，不声称零告警。Git原始blob核对16df52f的两个测试/db.ts均为LF，未全仓转换；本机CRLF来源机制未核。Windows真实释放及修复后回归尚待Codex复跑，不能用Linux结果替代。新增测试/实际限制及本机后续同步要求见实施交接；不启用S2或生产。
