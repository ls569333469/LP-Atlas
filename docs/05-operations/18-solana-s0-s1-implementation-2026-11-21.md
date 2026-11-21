# 方案18 · S0/S1 实施交接

日期：2026-11-21，Asia/Shanghai。本文是方案18的实施记录，不另起平行方案。代码基线：`fb570aab16e6ec86e603a2026d5fdf04dd651611`（GitHub main）。分支：`feat/solana-s0-s1-foundation`。**未部署、未迁移运行库、未启动扫描。**

## 实际完成

- S0：导入用户现行17/18必要规范；修订17八项审核处置、决策/场所路径/代码/四层标准。删除默示授权，明确旧“仅MD”是11月20日复审范围，不覆盖本次明确的S0/S1授权。保留费用归属、小时覆盖、历史字段、报价和预算阻塞；不改方案16。
- 公共身份：`ChainRef`用目录字符串及可空`evmChainId`，拒绝未知数字、Solana哨兵和不一致组合。Base58严格验证32字节公钥与64字节签名，保留大小写、允许off-curve字节；不冒充账户owner/布局验证。
- 新迁移014：tokens主键改为`(chain_key,address)`；pools新增`chain_key/native_pool_id`及规范唯一约束，旧物理`pool_id`不变。Solana内部键使用有版本的JSON编码，不泄露为外部池地址。旧pool/token/window/coverage/publication的rowid保留。
- 同一窗口表支持`native_amounts`与`official_usd`分型：无来源原币/交易数为NULL，官方美元不冒充方案13计价版本；原币重算路径明确拒绝官方美元记录。官方累计同池/小时覆盖更新，不重复加总，跨源/版本/表示切换须另有明确政策。
- scanned_hours以目录链/协议/小时/coverage_scope为键，EVM仍venue覆盖；非EVM只接受匹配精确池键的源覆盖，不把一个样本扩成全场所。未知源截止/finality不能标complete，未核普通LP归属不能写确认LP美元费用（连0也不行）。
- chain_publications本来已用目录字符串：保留其身份与EVM发布SQL，扩展非EVM可空块号/未知截止，记录源观察；读取不再把NULL转成`"null"`。报价里的`sourceChainId`仍是已批准RedStone的EVM源链，不代表业务池链；本次没有扩SOL报价或供应商。
- 迁移器使用已安装`@libsql/client 0.18.0`的write Transaction及其`executeMultiple`，结构与schema_migrations登记同连接、同事务提交。仅移除旧脚本已知外层BEGIN/COMMIT，不编辑001–013；拒绝其他事务/连接控制，失败关闭事务回滚。
- 数字调用的EVM兼容入口保留；存储查询、目录计数、token关联、窗口/coverage、延期回访及发布读取核对链/协议/池作用域。EVM刷新、价格桥、修复、研究读取显式限制为EVM/raw能力，防止Base58被小写或NULL被强转0。
- v1/v2现有EVM字段及准入/六窗/搜索排序分页/snapshot/poolKeys/详情身份保持；未把required数字字段擅自改成字符串。Solana尚未获准出现在这些旧数字wire合同中，新链对外合同仍需在接入前协商，不伪造chainId。
- Solana三个场所仍`listed_not_implemented`、placeholder、`not_started`，注册表和刷新入口继续拒绝它们。源能力区分事件扫描、官方索引、未启用的官方累计候选；游标仅准备分型合同，未实现S2采集/事件去重/slot推进。

## 本轮真实验证

- `pnpm install --frozen-lockfile`：成功，未新增依赖或改锁文件。
- `pnpm test`：43个文件、258项测试通过。全部使用临时DB、fixture和既有mock；没有读生产DB、请求Solana RPC/Datapi、运行研究采集脚本或启服务。
- 新增：稀疏rowid、四个真实发现meta键、精确原币/美元、发布版本、持久延期水位迁移前后对照；新增池增量不漏不重；小时截止前/后新增桥的延期失效判定；未知链/NULL物理键/规范别名冲突拒绝。
- 新增：014逐语句前缀故障、最后DDL后版本登记失败、版本登记前/后进程骤退但未commit、重启重试无残留；完整性与FK检查。只验证file SQLite/libsql本地后端，不冒称生产副本或其他远端后端已验收。
- 新增：公钥/签名负向、大小写、非EVM存储/池级覆盖/NULL发布/缺失度量回读；累计覆盖不叠加、跨源拒绝、源截止与LP费用闸门；缺小时不造0。
- 既有回归：双EVM链同原始池ID、v1/v2六窗、搜索排序筛选、分页快照与poolKeys、详情身份/URL参数序列化、20,000行分页、小时续接/失败恢复、金额修复、保留期和调度测试通过。
- `pnpm check`及`pnpm build`：通过。Biome仍报告非阻断warning/info及既有配置弃用提示，不声称零告警；新增文件无新增lint warning。未进行浏览器手工验收。

## rowid/meta与回滚边界

保留`rowid → catalog.lastRowId → usd_repair_deferrals.catalog_rowid`关联，不清空延期队列或重置发现进度。以下meta键和值不改：`v3_discover_block`、`v4_discover_block`、`4663:v3_discover_block`、`4663:v4_discover_block`。它们仍是EVM发现区块水位，不是Solana slot。

部署另候授权：停止新调度并等待在途自然结束，做可恢复的一致性备份与磁盘/实际schema/逻辑引用预检后才运行迁移；以新进程切换，失效重建内存目录及查询快照。**不能拿本轮临时DB测试替代生产副本预演。**

014会拒绝未知链、空/NULL物理池键、孤儿逻辑引用和规范身份冲突；不自动修数据。旧迁移器可能留下的“结构已改但未登记”状态也不会被盲目补登记，需独立核验/恢复。

**不支持把旧001–013二进制直接切回扩展schema继续写入**（旧token ON CONFLICT键等已不匹配）。本轮没有降级迁移；如必须回滚，使用一致性备份与匹配代码一起恢复，涉及运行库操作仍须授权。不清库、不重置meta、不回滚已推送历史。

## 留给Codex的下一步（未做）

S0/S1公共身份与存储兼容底座已完成上述代码和离线验证；不等于Solana已接通。后续仍按方案18：

1. S2先核Datapi fees普通LP归属（MM/LO/protocol/host）、端点边界、小时覆盖/源截止/finality、晚到修订；本轮未独立复现方案18历史证据，不把403或标签连续当验收。
2. 补齐历史TVL、原币、交易数和价格边界的真实来源；历史交易archive不等于账户历史快照。Token2022扩展/epoch、owner/布局和协议原生价格转换留给协议接入，不用当前值补历史。
3. SOL根价/包装同价政策尚未批准；官方美元独立表示只是存储能力，不等于批准用于排名或替代本地计价。没有默认新增Pyth等源。
4. S3再接报价、现有五分钟调度、发布及看板；对外非EVM合同先协商，不能破坏v1/v2。Raydium独立S4。全站池数、请求/回访/存储预算待实测。

BSC、DAMM V2、Orca、钱包/交易、方案16不动；不merge、不部署、不启生产。

## 基线比对范围

GitHub基线缺17/18，现已从用户本机现行MD导入。只读比对确认03-code一致，场所路径/决策的Solana顺序更新已定向保留；与任务无关的本机研究文档重命名未强行导入。用户本机repositories.ts与GitHub基线LF归一化后一致。未声称全本机工作树一致：本机Git状态读取遇dubious ownership，未修改safe.directory或其他用户设置，也未覆盖用户文件。


## PR #1 复核修复（2026-11-21，Asia/Shanghai）

本次基于已推送的 `16df52fd66bbbc7e2e84af934a0881002df61ab5`，继续同一分支/PR，新增提交而非改历史。执行前及自审时远程分支均仍为该提交。本机方案18已在原文件末尾增量写入核实问题及计划（423行起），保留本机原文/Codex改动；本机源码未修改，也未在本机运行Git、测试或服务。

### 实际修复

- `src/store/db.ts`：WAL初始化移入失败关闭保护；迁移失败原本已有关闭逻辑，现继续保留。初始化和close同时失败时用带cause的AggregateError保留两者，不用关闭错误掩盖原错。close仍按同步API调用；没有改迁移SQL/事务口径。
- `test/migration-014.test.ts`：legacy初始化失败关闭；首个测试和崩溃恢复测试的首次连接使用纳入finally；两个初始化故障注入分别确认迁移初始化/fixture写入失败后真实client已close。崩溃子进程的故意退出保持，不能把crash模拟改成正常关闭。
- 两个新增测试文件的afterEach共用小型测试专用 `test/helpers/temp-directories.ts`：recursive rmSync，maxRetries=5、retryDelay=100；各目录尽力清理，最终AggregateError包含路径和原始cause，保留失败路径供后续清理，不吞失败、不因首错跳过其余目录。
- 新增 `test/db-lifecycle.test.ts`（4项）及 `test/temp-directories.test.ts`（3项）：WAL/迁移初始化错误、关闭自身错误、成功转交连接；真实临时目录删除、Node有界重试参数、模拟耗尽EPERM/EBUSY后的错误传播和多目录完整尝试。

### 本轮实际验证

平台：助手Linux，Node v20.19.2、pnpm 10.34.6；未安装新依赖。2026-11-21约21:53（Asia/Shanghai）。

- 定向：`pnpm exec vitest run test/migration-014.test.ts test/solana-foundation.test.ts test/db-lifecycle.test.ts test/temp-directories.test.ts`：4文件、22项通过。
- 全量：`pnpm test`：45文件、267项通过（比原258项增加9项）。既有迁移原子性/断点重启、rowid/meta/延期水位、EVM身份及v1/v2搜索排序分页/snapshot/poolKeys回归在全量中继续通过。
- `pnpm check`：退出0，Biome加三组TypeScript通过；Biome报告72 warnings、50 infos（含旧配置弃用提示），不是零告警。本轮6个TS文件定向Biome检查通过，无新增文件级warning；未全仓自动修格式。
- `pnpm build`：API及Web均通过，未启动构建产物或dev服务。
- `git diff --check`通过。读取16df52f的Git原始blob及本轮工作树确认两个测试、db.ts、biome.json均为LF；本机先前读到的CRLF不是这三个TS提交blob的原始换行。未读取/改变本机Git属性或换行配置，不能据此归因具体转换机制；仅保持本轮文件的项目既有格式。
- 过程中新增测试曾因不可spy的ESM导出及execute重载推断报错；已改为测试fixture局部连接工厂注入和显式InStatement类型，并重跑上述最终定向/全量/check；不把失败轮次算作通过。

### 尚未验证 / 不变边界

Node安装类型声明确认：recursive:true才启用maxRetries，默认0；EPERM/EBUSY等使用线性退避。测试验证的是有限参数委托、模拟最终失败传播与Linux实际目录清理，**没有独立复现Windows原生句柄释放、Node内部每次重试时序或证明Windows问题已消失**。Codex的250通过/8清理失败是修复前历史报告，不是本轮复现。仍需Codex保留本机未提交修改后同步新commit，在Windows复跑定向、全量、check/build；遇CRLF差异先核实际格式，不全仓转换或忽略失败。

本轮不改已应用迁移，不读/迁移生产或运行库，不做生产副本预演；所有DB测试仅临时库/fixture及已有mock。没有启用Solana/S2、新报价源或真实扫描，没有部署；16/BSC/DAMM/Orca/钱包、五分钟频率/小时账本/六窗/准入规则不变。S2费用归属、覆盖/截止、历史字段和报价政策等阻塞继续保留。
