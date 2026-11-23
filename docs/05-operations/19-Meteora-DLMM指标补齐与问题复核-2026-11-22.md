# 19 · Meteora DLMM 指标补齐与问题复核

日期：2026-11-22（Asia/Shanghai）　状态：费用口径已确认，2026-11-22 20:26已加载并通过费用指标及五分钟自动发布验收。

## 1. 目标与范围

2026-11-23 补记：五分钟采集的生产耗时、分段测速与优化见 [P21](21-Meteora-DLMM五分钟采集性能-2026-11-23.md)，执行状态统一见 05。

补齐现有主站 Meteora DLMM 的费用、年化和费用环比，核对资金效率、缺窗诊断及实际加载版本。沿用官方 Data API、现有小时库和五分钟调度，不接 Raydium/DAMM V2，不改 EVM 两链的金额、准入、排序规则或页面布局，不新增一批风险或解释标签。

用户确认：以官方 `fees` 对齐费用金额。此前“`fees + protocol_fees`作为主表费用”的建议撤销，不再作为实施依据。本文统一整理了 Grok 的有效复核意见及随后官方接口对账结论，删除互相冲突的旧执行稿；当前合同见第7节，实施状态只维护在 [05唯一执行清单](../04-standards/05-roadmap.md)。

### 1.1 最终阶段执行边界

- **费用已验收。** 第 7 节的官方费用、年化、环比、资金效率与既有准入规则是本期基线。
- **筛选与字段说明。** 正式实现只按第 8.4 节已支持字段和现有 HTML 预览调整原漏斗。默认「通用筛选」，DLMM 页沿用官网的双端区间和并排选项，扩展组默认折叠，各条件默认不限。字段名悬停或键盘聚焦只解释含义、单位和适用范围，例如「基础交易费率」与「费用年化」分别解释。全部网络与 Solana 共用发布数据和已应用条件，DLMM 条件在分页前只作用于 DLMM 池。预览已核，正式实现及验收见 05。
- **价格涨跌。** 仅按第 9.3 节复用正常采集返回的 `current_price`。观测不足则留空。筛选与涨跌新增对外采集请求均为零，以现有五分钟采集与发布为验收基线。
- **待审核项。** 池标签、农场 APR/APY、动态费率、最大费率、Active TVL、Organic Score、官网 BASE 映射，以及需要新增来源或改变统计口径的字段，均保留现有状态。实施中发现本方案以外有必要的改动，先在本方案记录证据、最小改动与影响范围，标为「待用户审核」，经用户确认后才纳入执行。旧调查和待审核记录仅供复核。

正式验收用同一发布、窗口和通用条件比对两个视图的 Solana 池 ID 与指标，覆盖默认不限、组合筛选、缺值、分页和字段说明。验收同时核对现有采集与发布链路，记录实际耗时。唯一执行状态维护在 05。

HTML 参考为 `outputs/19-dlmm-filter-preview.html`。它沿用现有主站组件和样式，以冻结发布数据演示漏斗。正式改动落在原漏斗，保留六窗口主表、排序、搜索和右侧详情／交易面板。预览结果只证明交互与筛选逻辑，正式链路的实现、发布和性能以 05 验收状态为准。

## 2. 现场数字：为什么直接使用 fees

### 2.1 用户截图

用户提供 DAMM V2 的 VEILBOSS/SOL 池：`5k2fPAMLsrKQvky8axnAtudasm4xcvUGg4iQ9gUKcTaF`。

截图显示24H Fees=$26.32、TVL=$4.34、Fees/TVL=606%。用已显示的舍入值计算：

`26.32 ÷ 4.34 × 100% ≈ 606.45%`

与官网整数显示606%吻合。截图没有精确采样时间，不能与之后实时金额要求逐分一致。该DAMM样本只用于费用字段对照，不代表启用DAMM采集。

### 2.2 2026-11-22 18:37同响应核算

每一列数据均取该池同一份官方响应；计算用 Decimal，不跨时点混算。原始响应为JSON浮点数，保留其报告精度，不宣称链上逐最小单位对账。

| 项目 | DAMM V2 · VEILBOSS/SOL | DLMM · cbBTC/USDC |
| --- | ---: | ---: |
| 池地址 | `5k2fPAMLsrKQvky8axnAtudasm4xcvUGg4iQ9gUKcTaF` | `132hWzkrhLUvamLHpfikDTXXtCVXL3rxPNvkruqzX6sf` |
| 官方24H fees | 26.45141693756583 | 11.5807100494568 |
| 官方24H protocol_fees | 6.356875937898382 | 1.0361791203429336 |
| 当前TVL | 9.752617839300349 | 95188.76168304383 |
| fees÷TVL×100（%） | 271.22376138818795 | 0.012166047592905808 |
| 官方fee_tvl_ratio[24h]（%） | 271.223761388188 | 0.01216604759290581 |
| fees+protocol_fees | 32.808292875464212 | 12.6168891697997336 |
| 合计÷TVL×100（%） | 336.40498803568287 | 0.013254599541709561 |
| 按fees计算24H简单年化（%） | 98996.67290668860 | 4.44060737141062 |
| 按两项合计计算24H简单年化（%） | 122787.82063302425 | 4.83792883272399 |

两个场所的官方费用/TVL均与 **fees单独计算** 一致，与两项相加不一致。相加会使以上费用基数分别增加24.03%、8.95%，偏离本次对齐官网Fees的目标。因此主表采用 `fees`；`protocol_fees` 单独保留，不相加，也不从 `fees` 再扣一次。

以上24H简单年化只是使用官方报告费用的本地数学换算，不是官方API `apr` 原值，也不是持币收益或个人仓位收益保证。最终生产窗口仍用本地整点小时，不能与官网实时滚动24H强行逐分相等。

## 3. 费用文档核对结论与删除的推测

官方事件文档明确区分 `mm_fee`（做市费用）、`protocol_fee`（协议费用）、`host_fee`（推荐/集成方费用）、`limit_order_fee`（限价单费用）。因此 `protocol_fees` 不是邀请费。

历史API公开 `fees` 和 `protocol_fees`，没有给出所有事件分支的聚合穷尽公式。这不等于已发现API金额错误，也不需要另造一套分成计算才能显示官方费用。本期直接复用官方报告的 `fees`，不推导用户能分得多少，不自行增减组成。

本版取消以下不适用的执行要求：

- 取消将两项费用相加作为官网Fees的映射。
- 取消“必须先验证所有推荐/限价单分配，费用相关指标才允许有值”的前置门；不据缺少样本推断官方有漏算或混算。
- 取消以118笔历史交易逐笔美元复算作为本次字段接通的必要工作，不扩大全库交易扫描。
- 取消新增“报告费用合计”产品口径及对应标签；不增加推测性的提示说明。
- 取消为补满价格列就接入未经核定边界的OHLCV；也纠正旧稿把现行价格涨跌误写为美元涨跌的问题。

仍需如实区分：本期显示官方报告费用，不把它写成普通LP净实得、特定仓位收益或完整链上所有费用组成已精确核定。无需为此阻塞当前指标实施。

## 4. 实际问题与保留边界

| 项目 | 已核事实 | 本次处理 |
| --- | --- | --- |
| 费用/年化/环比为空 | SOL归一模块主动置空；小时费用原值已具备解析与存储路径 | 使用已落库reportedFeesUsd接通，不增加费用采集请求 |
| 资金效率 | 当前为对应窗口美元成交量÷当前TVL，未发现公式错误 | 保持公式，最终同发布逐窗核对；截图279.75÷93561≈0.002990，显示0.0030合理 |
| 价格涨跌 | EVM代码使用token1/token0池内相对价格，严格窗口边界；SOL当前无已核真实边界 | 保持NULL，不新增价格请求、迁移或供应商；该项明确未完成，不写成已修复 |
| 新池长窗口缺值 | Grok报告18:12同发布205个可见池中19个成交空窗均跨创建前 | 只证明当时可见集合；新池不足窗口保留空值，不推断全库无缺档 |
| 缺小时诊断 | 磁盘已有missingHours与pending_backfill区分补丁 | 加载后核源缺档、预算未处理及创建前豁免，不补0 |
| 分页漂移 | 已有发现页100→1000及完整性校验补丁 | 加载核验；页容量增大不保证未来所有多页漂移消失 |
| 运行版本 | 18:16核3001仍PID9556，部分dist晚于进程启动 | 是历史时点证据；部署前重查，不把成功刷新等同于已加载新补丁 |

不凭假设建设新排队系统。只有实际证实失败池反复占预算使后续池无法补齐，才定向修复。

## 5. 代码与验收要求

复用现有适配器、小时表、组窗、API、快照分页、列表/详情与组合筛选。保留官方原字段、来源版本与净LP字段合同，改变Meteora费用指标时不能污染EVM。

需要核对的路径：`src/adapters/venues/solana/meteora-dlmm.ts` → `src/store/repositories.ts` → `src/metrics/compose-windows.ts` → `src/normalize/official-board.ts` → shared/API → 原前端列表、详情、排序及组合筛选。

实施顺序：相加代码已纠正为直接fees，类型与质量口径、六窗计算及场所文案已同步；受影响检查已通过。已加载唯一3001并验证实际发布与自动续接，结果见第6节。

最终验收覆盖：费用0与未知、协议费缺失不应挡住已知fees、缺窗、来源版本混用、年化有效时长、对照为0、新池、cbBTC/USDC及一个SOL计价池。逐窗对账成交/费用/年化/环比/资金效率，核搜索清空、切链、排序、分页、详情及自动载入，EVM原规则保持。

官网对比必须同池同时间范围。官网滚动24H与本地整点24H不对齐时，应使用官方历史API请求相同小时范围核对，不能用时间窗不同解释一个未经核实的差额，也不能改成本地滚动窗。

## 6. 本轮实际状态

前轮相加实现已被纠正：归一层直接读取reportedFeesUsd，组窗分别累加fees与protocol_fees，缺协议费不影响已知fees；列表、详情、排序和组合筛选使用同一费用口径。缺费用保留NULL，费用为0保留0，不覆盖lpFeesUsd或伪置ordinary_lp_verified。价格边界仍未完成。

本版直接fees实现的Windows定向检查为6文件72项通过，覆盖六窗费用、年化、环比、资金效率、缺项/0、来源版本及筛选；三套类型检查、前后端构建通过，默认静态检查无error，104 warnings/50 infos。测试记录为`node_modules/.cache/p19-direct-tests.log`，静态检查记录为`node_modules/.cache/p19-final-biome.log`。旧相加版98项结果不是本版验收依据。

18:42正常重启3001的命令被自动审批拒绝，仅返回`blocked by policy`，未给出具体原因，命令未执行；当时旧API9556仍运行。本次未迁移或重估运行库，未启动额外扫描。后续加载前须重新核对进程与链空闲状态；真实服务加载、最终发布对账、页面和自动续接尚未验收，不能标完成。当前执行状态仅维护在05清单。

此前普通样本、推荐样本和Grok调查不再堆叠为本期准入条件；有效事实已归入本文相应小节。本次字段对齐不要求先证明全部链上分配，不将未知当作官方金额错误，也不推断用户个人仓位收益。

18:45–18:46补充只读验收：使用新dist和运行库同一读事务，以Solana第2850轮截止`2026-11-22T10:42:49.931Z`为基准，290个可见池共1740窗；独立从小时记录核算费用、年化、环比、成交与资金效率，8700次比对无差异。1710窗费用非空，30个空窗均跨创建前，当前可见集合未发现创建后缺小时；结论不扩展为全库或未来覆盖完整。读取与全量核算合计约6.6秒，不是采集耗时。

新dist API通过Fastify内存注入只读核同库：290池两页无重复、fees降序、地址搜索及清空、费用与APR组合条件通过；分页后feeBasis仍为reported_fees，价格仍NULL。未listen、未启用autoScan、未调用refresh、未写库，不冒充正式3001及浏览器验收。18:46现场旧API9556仍运行，Solana最新轮为成功，五分钟调度开启；Elysium为部分成功，不将旧服务健康状态作为新版本加载证据。

19:26后续实源抽核：cbBTC/USDC（`132hWzkrhLUvamLHpfikDTXXtCVXL3rxPNvkruqzX6sf`）与cbBTC/SOL（`HDhWhQCBrSh9xNWmNtsTi86eWj3yCoEiaRodjgNydo1b`），请求相同已结束范围`[1795255200,1795341600)`，各返回24小时、无缺小时。逐小时对比成交、fees及protocol_fees，最大差额除以max(1,源金额)分别约`3.71e-16`、`1.18e-15`；有末位差异，报告精度内一致，不称逐位完全相同，也不证明源数据最终性。未写运行库。

本次恢复执行后，正常重启仍被自动审批以`blocked by policy`拒绝，命令未执行。19:26现场API9556、Vite13284保持；Solana最新旧版轮次分页漂移失败，保留11:17:49Z成功发布，两EVM链最新为成功。旧版失败不能用于判定尚未加载的新分页补丁效果；待正常加载后再验。

20:26启动新版API38248/3001和前端16648/5173，旧9556/13284已退出。Solana自动轮2913、2916分别在20:26、20:31启动，均成功、无运行缺档，耗时125.6秒、102.5秒。主站未手动刷新，费用样本观察时间从20:27:01更新至20:31:08，达标池296→319。1H费用>$50且年化>100%筛出14池，逐行满足两项条件且费用降序；完整池地址搜索命中1池，清空还原目录，SOL/USDC详情与同页列表的1H费用$367.46及年化297.78%一致。第2916轮通过5173正式代理取两页319池，1914窗口，独立对账9570项费用、成交、年化、环比与资金效率无差异，1886窗费用非空。严格价格边界仍留空。Elysium首轮部分成功，第二轮成功；Robinhood两轮成功。

## 7. 当前唯一费用合同（取代此前相加稿）

1. 仅Solana / Meteora DLMM采用官方 `history.fees → reportedFeesUsd` 作为展示费用；`history.protocol_fees → reportedProtocolFeesUsd` 独立保留，不加不减。协议费未知不使已知fees为空，fees缺失不补0。
2. 六窗费用按同池、同来源版本的对应整点小时fees累加；缺必要小时留空，不用滚动源值代替整点窗口。
3. 年化=`窗口fees÷当前TVL×年秒数÷窗口有效秒数`；内部比值，页面转百分比；未结束窗口按实际过去时长。复用年化数学函数，不直接复制源apr，不倒填历史TVL。
4. 环比=`(当前fees−前一等长非重叠窗fees)÷前窗fees`；对照缺失或分母0则NULL。24H对前24H；3D与24H并列参考，不要求3D自身环比，不扩四天保留范围。
5. 资金效率=`窗口美元成交量÷当前TVL`，保持周转倍数，不年化，不除小时数。
6. 不将官方报告费写成已验证净LP收益，不覆盖库内lpFeesUsd，不伪置ordinary_lp_verified。列表费用、年化、环比及其排序/组合筛选必须同口径；Meteora文案不称“费用合计”或“净LP实得”，不改变EVM标签与字段意义。
7. 保持SOL当前TVL≥1000、整点1H成交≥100候选准入，不自动恢复手续费≥10门槛。严格价格涨跌仍NULL，无额外价格采集。
8. 不新增费用RPC/HTTP/迁移，不重拉全部历史，不另起扫描管线。代码、检查、部署、生产验收分别如实记录，状态仅见05。

官方依据：

- [DLMM历史成交与费用](https://docs.meteora.ag/api-reference/dlmm/pools/historical-volume)
- [DLMM费用事件组成](https://docs.meteora.ag/developer-guides/dlmm/program/events)
- [DLMM OHLCV](https://docs.meteora.ag/api-reference/dlmm/pools/ohlcv)
- [DAMM V2样本接口](https://damm-v2.datapi.meteora.ag/pools/5k2fPAMLsrKQvky8axnAtudasm4xcvUGg4iQ9gUKcTaF)
- [DLMM样本接口](https://dlmm.datapi.meteora.ag/pools/132hWzkrhLUvamLHpfikDTXXtCVXL3rxPNvkruqzX6sf)

**费率与仓位口径说明。** 基础交易费率是池参数，筛的是每笔交易的基础收费比例；本地费用年化按窗口费用、当前 TVL 和有效时长计算。若同时启用两项，分别判断并取交集。例：基础交易费率 0.25%，1H 费用 $10、TVL $100,000，对应本地费用年化 87.6%。Meteora 官方样本 `apr` 原值与当时的 24H Fee/TVL 相等，池级比值需按各自口径解读。开仓价格区间决定仓位的费收入暴露，属于另一项产品功能；官网 DLMM 指南给出以活跃价为中心的 69 个默认分箱，作为对照资料。P19 不新增仓位收益估算或开仓区间规则。[Meteora 池 API](https://docs.meteora.ag/api-reference/dlmm/pools/pools) · [DLMM 开仓指南](https://docs.meteora.ag/user-guides/how-to-use-dlmm/dynamic-terminal)

## 8. Meteora DLMM 专属筛选与官方字段对照

2026-11-22 复核。下表英文列用于在官方文档或页面定位，中文列是 LP Atlas 的拟用名称。官方 API 字段名、可用作 `filter_by` 的字段名、LP Atlas 已有字段分别列出。DLMM 专属筛选沿用现有漏斗，分为「通用筛选」和「DLMM 专属」两个标签页。每次打开先显示通用筛选，标签切换保留草稿，底部一次应用两页条件。DLMM 页主区显示分箱步长、基础费率区间、费用收取模式和农场激励，其余已验字段按第 8.4 节分组折叠。「全部网络」和「Solana」共用同一发布数据、同一组已应用的 DLMM 条件和同一筛选逻辑；两个视图均在分页前对 Solana 的 Meteora DLMM 行执行相同条件，其他链继续执行通用条件。切换视图保留已应用设置，两视图都可查看和修改；条件默认留空。在发布版本、窗口和通用条件相同时，「全部网络」中的 Solana 池集合与单选 Solana 一致，同池指标相同。只查询已入库数据，新增外部采集请求为零。HTML 已预览，正式版尚未实施。TVL ≥ $1,000、整点 1H 成交 ≥ $100 仍为 Solana 候选准入；弹窗现有「最低 1H LP 手续费」只对 EVM 生效，Solana 单选时隐藏该输入。

### 8.1 池与代币字段

| English / 中文 | 官方 JSON 字段 / 单位 | LP Atlas 现状及筛选结论 |
| --- | --- | --- |
| Bin Step / 价格分箱步长 | `pool_config.bin_step`，整数；官方以基点表示相邻分箱的价格步长，样本 10 等于 0.10% | 已存 `binStep`。建议第一版按整数筛选，保留为 DLMM 参数 |
| Base Fee Rate / 基础费率 | `pool_config.base_fee_pct`，百分数，样本 `0.04` 表示 0.04% | 已存 `baseFeePercent`。建议用此字段做基础费率范围筛选；官方查询 `fee_pct` 是另一个键，二者等价性未核定 |
| Dynamic Fee Rate / 动态费率 | `dynamic_fee_pct`，文档定义为基础费加可变费。复查原值，cbBTC/USDC 为 `0.0005063`（基础 `0.04`），cbBTC/SOL 为 `0.0003206`（基础 `0.03`） | 已存 `dynamicFeePercent`。两字段的尺度关系尚未核定，保留源原值，暂不作为实际费率筛选 |
| Maximum Fee Rate / 最大费率 | `pool_config.max_fee_pct`，三个样本为 `0` | 已存 `maxFeePercent`。零值语义未核，不将其解释为实际费率上限为零 |
| Protocol Fee Share / 协议费分成比例 | `pool_config.protocol_fee_pct`，样本为 `5` | 已存 `protocolFeePercent`。与美元金额 `protocol_fees` 分开；不拿它从官方 `fees` 再扣一次 |
| Fee Collection Mode / 费用收取模式 | `pool_config.collect_fee_mode`，整数；官方定义 `0 InputOnly`（费用以交易输入币计），`1 OnlyY`（费用始终以 Y 币计，X→Y 时从输出侧计费） | 已存 `collectFeeMode`。建议按枚举筛选；未知值不匹配具体模式 |
| Pair Type / 池类型 | `pool_config.pair_type`，整数；样本见 0、3 | 已存 `pairType`，详情保留原值；待按项目所用 IDL 版本核完枚举再开放名称筛选 |
| Has Farm / 有农场激励 | `has_farm`，布尔；`farm_apr`、`farm_apy`、`reward_mint_x/y`为关联资料 | 已存 `hasFarm` 等。建议筛选「不限／有／无」，显式未知不可等同于无。奖励年化与费用年化分列 |
| Verified Token / 官方验证代币 | `token_x/y.is_verified`，每币独立 | 已保留。若后续开放筛选，须明确筛 X、筛 Y、任一或双币，验证状态不代表安全评级 |
| Token Holders / 代币持有人数 | `token_x/y.holders`，整数 | 已保留 X/Y 值。官方查询接受 `base_token_holders`，其 base 与 X/Y 的映射尚未核 |
| Freeze Authority Disabled / 冻结权限已撤销 | `token_x/y.freeze_authority_disabled`，每币独立 | 已保留；与「有冻结权限」含义相反，缺字段保留未知 |
| Token Price / 代币美元价；Market Cap / 市值；Total Supply / 总供应量 | `token_x/y.price`、`market_cap`、`total_supply` | 已保留。币价与池内兑换比例分开，市值不替代 FDV |
| Blacklisted / 官方黑名单；Launchpad / 发射平台；Tags / 标签 | `is_blacklisted`、`launchpad`、`tags` | 已保留作资料；如新增筛选应作为显式选择 |
| Active TVL / 活跃流动性；Organic Score / Organic 评分 | 实测查询键 `active_tvl`、`base_token_organic_score` | 本次对象样本未返回对应数值，本地无可核对字段。暂不纳入首版本地筛选 |

### 8.2 官方查询支持实测

官方列表文档的 `filter_by` 列出数值 `tvl`、`volume_*`、`fee_*`、`fee_tvl_ratio_*`、`apr_*`，布尔 `is_blacklisted`，及文本 `pool_address`、`name`、`token_x`、`token_y`。表达式用 `&&` 组合。本轮给同一个 cbBTC/USDC 池地址追加以下条件，区分「文档列出」「实测接受」与「详情返回」。

| 追加表达式 | 实际响应 | 对接判断 |
| --- | --- | --- |
| `bin_step=10` / `bin_step=999999` | HTTP 200，分别命中 1 / 0 | 查询有效，且已入库可本地筛 |
| `base_fee_pct>=0` / `fee_pct>=0` | 前者 400 unknown or unfilterable，后者 200 命中 1 | 支持筛选的键和响应字段不同；建议本地直接筛明确的基础费率字段 |
| `collect_fee_mode=0` | HTTP 400 unknown or unfilterable | 可用已落库字段做本地筛选 |
| `has_farm=false` / `has_farm=true` | HTTP 200，分别命中 1 / 0；池详情为 `false` | 同池反向条件验证筛选生效，本地已保留该字段 |
| `is_blacklisted=false` | HTTP 200，命中 1 | 官方文档列明可查询，本地已保留该字段 |
| `base_token_holders>=0` | HTTP 200，命中 1 | 已证该查询键被接受，未核定 base 身份 |
| `active_tvl>999999999999` / `base_token_organic_score>999999` | HTTP 200，均命中 0 | 仅证键被接受且极端条件返回空，不证明数值口径或全池覆盖 |
| `unknown_probe_x=0` | HTTP 400 unknown or unfilterable | 用作查询校验对照 |

复核入口：[官方池列表与过滤文档](https://docs.meteora.ag/api-reference/dlmm/pools/pools) · [官方分箱与费率公式](https://docs.meteora.ag/core-products/dlmm/formulas) · [官方费用收取模式](https://docs.meteora.ag/core-products/dlmm/collect-fee-mode) · [cbBTC/USDC 原始返回](https://dlmm.datapi.meteora.ag/pools/132hWzkrhLUvamLHpfikDTXXtCVXL3rxPNvkruqzX6sf) · [Bin Step=10 查询](https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1&filter_by=pool_address%3D132hWzkrhLUvamLHpfikDTXXtCVXL3rxPNvkruqzX6sf%20%26%26%20bin_step%3D10) · [Meteora 官网池列表](https://app.meteora.ag/)。

### 8.3 官网漏斗布局与本地字段对照

2026-11-22 用户确认以 Meteora 官网漏斗布局为参考。保留主站漏斗和默认通用页；数值用最低／最高成对输入，同一窗口下使用同一字段，留空不限。DLMM 页按「池设置」和「DLMM」分组，基础费率、农场激励属于池设置，分箱步长与费用收取模式属于 DLMM。第 8.1 节的分箱步长整数约束仍有效，交互改为最小／最大整数。费用收取提供「仅 Y 币（OnlyY）」与「随输入币（InputOnly）」；后者在两个交易方向分别收对应输入币。旧版 HTML 仅演示代币 X。新版按第 8.4 节提供显式代币侧选择；官网 BASE 映射仍待核。

| 官网分组 | 可以采用的字段 | 待核或缺失字段 |
| --- | --- | --- |
| Pool Details / 池资料 | Has Farm、Pool Age、Volume、Fees、TVL、Base Fee。Fees/TVL% 可用同一窗口费用 ÷ 当前 TVL × 100% 计算；作为该窗口的百分比，不能用 APR 或资金效率代替。与官网滚动窗口逐值对照时需对齐观测时点和窗口 | Active TVL、Volume/Active TVL、Fee/Active TVL 依赖活跃 TVL，当前本地不能复现 |
| DLMM | Bin Step、Fee Collection Mode | DAMM V2 是其他协议，当前接入范围仅 DLMM |
| BASE / 基础代币 | 已存 X/Y 各自市值和持有人数，池资料有 Launchpad | 官网查询按 `base_token_market_cap`、`base_token_holders`、`base_token_launchpad`；须核 BASE 身份及 Launchpad 对应关系。代币年龄需 `base_token_created_at`，池创建时间不可替代。New Listing、Top 10 Holders、Dev Balance、供应和单一持有人集中度缺可用本地字段 |
| 风险与质量 | 本地保留官方验证、冻结权限和池黑名单 | 官网 JupShield 同时筛基础币与报价币的关键告警；Jupiter Organic Score 是独立评分。本地字段未覆盖这两项 |

截图中的 Price Trend、Swaps、Traders、Total LPs、Net Deposit 等为表格列。当前 DLMM 链路未接价格趋势序列、逐笔成交数、独立交易人数、LP 人数和净存入，暂不列入漏斗。两视图共用数据与条件的约束继续适用。

对照来源见 [Meteora 官网](https://app.meteora.ag/) · [官方池列表 API](https://docs.meteora.ag/api-reference/dlmm/pools/pools) · [公开池样本 JSON](https://dlmm.datapi.meteora.ag/pools/132hWzkrhLUvamLHpfikDTXXtCVXL3rxPNvkruqzX6sf) · [官方费用收取模式](https://docs.meteora.ag/core-products/dlmm/collect-fee-mode)。

### 8.4 扩展漏斗字段与控件

用户要求把可用的已采集字段加入漏斗，默认不限。界面沿用官网的双端区间和并排选项，保留主站的通用／DLMM 两个标签页。以下是当前预览，取代第 8.3 节中仅以代币 X 为例的原型。

| 控件组 | 字段和行为 |
| --- | --- |
| 通用筛选 | 继续使用现有六窗费用年化、成交量、费用、费用环比、资金效率、价格涨跌，以及 TVL、池龄。DLMM 历史涨跌可用性仍见第 9 节。池和代币地址、名称及符号使用现有搜索入口 |
| 池设置、DLMM | 基础费率与分箱步长使用最低／最高。费用收取模式用并排按钮，取消选择表示不限。农场激励有不限／有／无 |
| 代币资料 | 市值、持有人数、美元价、总供应量、小数位、官方验证及冻结权限。选择任一侧、X、Y 或两侧；任一侧模式要求同一个代币满足全部已填条件，两侧模式要求两币各自通过。只选范围不会排除池。官网 BASE 身份映射仍待核 |
| 池资料与风险 | 发射平台、官方黑名单、池类型代码、标签、协议费分成、当前池价 Y/X、两侧代币储备数量、两侧储备账户地址、奖励 Mint，以及农场 APR/APY 官方返回值。池类型按原代码筛选；农场收益口径与标签覆盖见下方支持复核 |
| 官方统计 | 官方 Fee/TVL%、协议费金额可选官方统计窗口，默认 1H；累计成交额及累计费用用源累计字段。成交量、费用及费用年化继续使用通用页现有口径。官方原始 APR/APY 暂不开放筛选，避免混淆未年化比值和本地费用年化 |

动态费率和最大费率仍待核单位或零值语义。Active TVL、JupShield、Organic Score、代币年龄、持仓集中度和历史价格涨跌按已有待核项处理。数值下限和上限可只填一侧；未知值只在用户启用相应条件时不匹配；明确的零和否为可筛数据。同一套条件在「全部网络」和「Solana」都只作用于 Solana DLMM。正式版要在分页前复用发布数据，新增对外请求为零。

BASE（基础币）是被报价的代币，例如 BONK/SOL 表示每 1 BONK 对应多少 SOL 时，BONK 是 BASE，SOL 是 QUOTE。官网 BASE 与池 X/Y 的映射待校验，正式筛选沿用显式代币侧选择。专属字段无需加到主表列；后端在同一份发布数据中先应用通用和专属条件再分页，新增条件均默认不限，筛选条件可在两个视图中编辑。当前 HTML 以分箱步长 10–10 验证两个视图各 25 个相同 Solana 池、六窗口一致。

#### 预览字段支持复核

每项字段名支持悬停和键盘聚焦查看简短释义。基础交易费率以百分数输入，说明中区分费用年化；数值区间包含两端。缺值仅在启用该字段时不匹配。

- 264 池的冻结快照中，分箱步长、基础交易费率、费用模式、X/Y 代币资料，以及六个官方统计窗口的协议费和费用/TVL 均有值。发射平台有值 98 池，选择平台时缺值池不匹配。
- 池标签在快照中全为空数组，预览显示「暂不可筛」；有有效标签数据后，先补充证据供用户审核。农场 APR/APY 有字段但快照全为零，单位待核，预览暂禁用。农场激励和黑名单布尔值在当前快照均为否，仍保留条件。
- 奖励代币 Mint 只匹配实际配置，忽略全 1 的占位地址，快照中有 3 池提供非占位奖励 Mint。池类型按源代码值筛选。动态费率、最大费率以及缺有效本地字段的 Active TVL、Organic Score 等继续暂缓。

## 9. Meteora DLMM 价格涨跌与官方 OHLCV 复核

### 9.1 两类价格与查询参数

主站详情的 **Current Pool Price / 当前池价格** 来自 `/pools` 或 `/pools/{address}` 的 `current_price`。它是当前池内兑换比例，响应没有可用来绑定 LP Atlas 每轮发布截止的价格观测区块或源水位。六窗涨跌需要同一价格方向的两侧价格。已接入的 `/volume/history` 返回小时成交和费用；目前归一模块将 Solana 涨跌返回为空。

**OHLCV / 开高低收与成交量** 是同一官方域名上的独立 GET 端点 `/pools/{address}/ohlcv`。官方文档列出的 `timeframe` 有 5m、30m、1h、2h、4h、12h、24h，默认 24h；`start_time`、`end_time` 为 Unix 秒，文档写双端包含。每根记录有 `timestamp`（时间戳）、`timestamp_str`（时间字符串）、`open`（开盘）、`high`（最高）、`low`（最低）、`close`（收盘）、`volume`（成交量）。区间包含指返回的 K 线范围，不能把传入参数当作 K 线内部成交截止。

LP Atlas 的 6H 和 3D 没有同名官方 K 线周期。以下 K 线核对仅为历史调查，本期执行第 9.3 节。

普通采集已随池数据读取 `current_price` 与 `token_x.price`、`token_y.price`。前者用于池内兑换比例，后两项用于代币详情的美元价。费用、成交量与 TVL 直接使用 Meteora 报告的美元金额，费用年化和资金效率据这些金额计算。当前价两池各两次实测均为 HTTP 200，耗时 83–381ms，仅说明当时可读；接口缺少源观测时间或区块，读取时间代表 LP Atlas 的采样时点。

Robinhood 的对照口径是通过已配置 Alchemy RPC 读取 Uniswap V3 `slot0`、V4 `getSlot0`。小时起价来自首块前状态，截止价优先用截止区块状态，缺时可回退到已采集末笔 Swap 后池价。RedStone Push 的美元基准价用于另一条金额换算链路。现有 EVM 实现保持原状，DLMM 实施只复用正常采集的池价。

### 9.2 价格方向和窗口边界实测

池详情与 OHLCV 抽核支持 **Y per X / 每 1 个 X 对应多少个 Y**。cbBTC/SOL 是方向核对的关键对照，因为 Y 不是稳定币。该池当前价格约 865.50，同响应两币美元价相除约 865.75；历史 K 线约 860–865，本轮同池复查分别约 866.02 和 865.91，继续支持 Y/X。cbBTC/USDC 约 60,716、SOL/USDC 约 70.25，数量级同样一致。生产仍按 `token_x/y` 身份核方向和小数位，详情显示单位，不能按交易对名称猜或与 USD 代币涨跌混用。

以下以北京时间 2026-11-22 19:00（UTC 11:00，`1795345200`）为已结束小时分界点，三个活跃池实测：

| 请求 / 样本 | 实际结果 | 对指标的影响 |
| --- | --- | --- |
| 1H 区间跨度 24 小时，两个参数均整点 | cbBTC/USDC、cbBTC/SOL、SOL/USDC 各返回 25 个标签，含结束整点当小时 | 计算闭合 `[S,E)` 时，应丢弃标签为 E 的桶 |
| cbBTC/SOL，18:00–18:59:59 与 18:00–19:00 | 前者只返回 18:00，后者额外有 19:00；共同的 18:00 桶收盘均为 861.70138352 | 整点参数可以核对桶归属，不能把 E 桶的收盘当 E 时刻价格 |
| cbBTC/SOL，18:00–18:30，请求 1h | 仍返回 18:00 **完整小时**，收盘 861.70138352，成交量 68,286.14；18:00:01–18:59:59 也返回 18:00 桶 | 上游按桶对齐，不能用历史半小时参数重现该时点价格 |
| 同池，18:00–18:29:59，请求 5m | 返回 6 根，最后标签 18:25，收盘 862.39095147；把 end 改为 18:30 后会额外收到 18:30 桶 | 只用截止之前结束的桶可以构造已闭合 K 线指标，对齐精度最多到桶级，不能冒充任意秒的池状态 |
| 同池，1h 桶跨度 72 小时，整点双端 | 返回 73 根，单次 HTTP 200，约 728ms、14,351 字节 | 一个实测样本能覆盖六窗的闭合 K 线；不推定所有池覆盖或采集上限 |
| 稀疏池 DEVIN-speed、SOLANA-MUZKI、TL-MM，同区间最近 12 个闭合小时 | 三池成交历史均返回零成交桶，OHLCV 均为 `data: []`。下方链接池复跑两个端点均为 HTTP 200，成交历史返回 13 个零值标签（含结束整点，闭合区间内有 12 个），OHLCV 返回 0 根 | 零成交与缺 K 线可能同时发生，不能自动填 0% 或随意用下一根 |

K 线开盘值也不必等于前一根收盘。cbBTC/USDC 的 18:00 桶收盘约 60,837.72317，19:00 桶开盘约 60,776.94622。官方接口未在本次核到逐根成交时间或边界池状态的保证，因此 K 线开收盘值不能直接冒充 EVM 现行严格整点状态。

复跑链接：[官方 OHLCV 文档](https://docs.meteora.ag/api-reference/dlmm/pools/ohlcv) · [cbBTC/SOL 1h 请求止于半点](https://dlmm.datapi.meteora.ag/pools/HDhWhQCBrSh9xNWmNtsTi86eWj3yCoEiaRodjgNydo1b/ohlcv?timeframe=1h&start_time=1795341600&end_time=1795343400) · [同池 5m 不含 18:30 桶](https://dlmm.datapi.meteora.ag/pools/HDhWhQCBrSh9xNWmNtsTi86eWj3yCoEiaRodjgNydo1b/ohlcv?timeframe=5m&start_time=1795341600&end_time=1795343399) · [低成交池 OHLCV 对照](https://dlmm.datapi.meteora.ag/pools/E6udACQB8uirpH1h6PPBnRCzzRtodQdQuPdGrRgFE4u/ohlcv?timeframe=1h&start_time=1795302000&end_time=1795345200) · [同区间成交历史](https://dlmm.datapi.meteora.ag/pools/E6udACQB8uirpH1h6PPBnRCzzRtodQdQuPdGrRgFE4u/volume/history?timeframe=1h&start_time=1795302000&end_time=1795345200)。官方历史响应可能随后修订，以上为现场样本。

### 9.3 已确认方向：复用正常采集的池价

价格涨跌是辅助指标。沿用现有五分钟采集，只使用官方池列表已返回的 `current_price`，新增报价、OHLCV 和 RPC 请求均为零。第 9.1–9.2 节保留接口调查和实测，供查证。当前数据库的 `official_metadata` 只保留每池最新一份，因此历史样本须从实施后开始累积。

- 正常发布时随已有写入保留有界的池价观测，优先覆盖已满足准入的池，按池、X/Y 方向和实际观测时间关联，用批量读写，避免列表或详情逐池查库。
- 窗口涨跌按 `(截止池价 ÷ 起始池价 − 1) × 100%` 计算。两端取各自目标时刻之前或当时最近的有效观测；偏离目标超过正常采集间隔、缺少任一端、池尚未创建或方向不一致时留空。显示口径为采集时点的近似涨跌；观测时间以实际读取为准。六个窗口随观测积累逐步可用，缺失历史留空，等价的有效价可以计算为 0%；零成交本身不作为价格不变的证据。保持源 X/Y 身份，反向显示时对两端价格先取倒数，再重新计算涨跌。
- 验收核对两端样本、单位、缺档和真实刷新耗时。样本存取与涨跌计算为可省略项，失败时涨跌留空，原有手续费、成交量、TVL、APR、筛选及发布照常。若本地保存与读取产生可见的刷新开销，维持空值。
- 代码已加入迁移 016，按列表页返回的实际时间保存每池 X/Y 方向的读数，保留四天。当前端点按该池本轮的采集时点取值，并截在当前窗口结束以内。迁移加载及自动发布验收状态以 05 唯一清单为准。
