# 文档目录

按编号阅读。数字既是分类，也是顺序。项目标准正文以 [LP Atlas 项目标准](https://cursor.com/canvas/store-228dc691-956a-4bc2-a808-727d3a2b74e5/e5325002-b925-4eb0-a1cd-0e6aa760e873) 为准，这里是分类归档，不是讨论记录。

## 01 产品

| 文件 | 内容 |
| --- | --- |
| [01-overview.md](01-product/01-overview.md) | 产品是什么、全期框架、第一期做什么、落地顺序 |
| [02-decisions.md](01-product/02-decisions.md) | 已确定、暂缓、待确认清单与交接表 |
| [03-templates.md](01-product/03-templates.md) | 四套集中流动性模板 |
| [04-entry.md](01-product/04-entry.md) | 购买与开仓页（设计先写入，扫描验收后实现） |
| [05-前端HTML设计预览.md](01-product/05-前端HTML设计预览.md) | 独立 HTML 预览说明与已验证交互范围，非生产完成状态 |

## 02 架构

| 文件 | 内容 |
| --- | --- |
| [01-dual-plane.md](02-architecture/01-dual-plane.md) | 热路径与旁路双平面、多链归一、接入通道 |
| [02-四层技术架构.md](02-architecture/02-四层技术架构.md) | 四层技术架构、目录与架构图 |
| [03-protocol-coop.md](02-architecture/03-protocol-coop.md) | 多协议如何配合 |
| [04-stack.md](02-architecture/04-stack.md) | 语言、SDK、仓库路径 |

## 03 数据

| 文件 | 内容 |
| --- | --- |
| [01-signals-and-windows.md](03-data/01-signals-and-windows.md) | 看板规则、信号、已定窗口与其他档 |
| [02-sources.md](03-data/02-sources.md) | 数据源策略与指标来源；参考站用法见文末依据 |
| [03-official-review-2026-11.md](03-data/03-official-review-2026-11.md) | 依据：2026 年 11 月对照官方文档的修正 |
| [04-fee-investigation.md](03-data/04-fee-investigation.md) | 零手续费逐池核查、Hook 未确认边界、费用状态修复与验证 |
| [05-data-repair-and-1h-filter.md](03-data/05-data-repair-and-1h-filter.md) | 本轮方案：数据修复、统一 1H 准入、LP 手续费 ≥ $10、各窗口同池集合、3D 参考 24H、4 天保留及按依赖排序的实施与统一验收 |
| [06-signal-research.md](03-data/06-signal-research.md) | 用户授权的两日离线信号研究：数据导出、多指标组合、集中区间情景、成本及可复现工具 |

## 04 标准

| 文件 | 内容 |
| --- | --- |
| [01-collaboration.md](04-standards/01-collaboration.md) | 协作与变更 |
| [02-acceptance.md](04-standards/02-acceptance.md) | 「跑通 Elysium Uniswap V3 与 V4」验收标准 |
| [03-code.md](04-standards/03-code.md) | 前后端代码标准 |
| [04-iteration.md](04-standards/04-iteration.md) | 更新与迭代要求 |
| [05-roadmap.md](04-standards/05-roadmap.md) | 更新迭代计划：完成打钩，供进度与代码审计对照 |
| [06-venue-sources.md](04-standards/06-venue-sources.md) | 多链场所数据路径：一场所一适配器、官方索引与自建小时档 |
| [07-frontend.md](04-standards/07-frontend.md) | PC 多链目录、六窗对照、筛选排序、50/100/200 条分页、版本一致性与容量验证 |
| [08-robinhood-venue.md](04-standards/08-robinhood-venue.md) | Robinhood Chain（4663）专用接入说明：自建小时档、官方合约、接入现有全站统一的 5 分钟续接刷新；2026-11-14 已授权启用并生产拉数 |

## 05 运行

| 文件 | 内容 |
| --- | --- |
| [01-risks.md](05-operations/01-risks.md) | 技术风险与防范 |
| [02-budget.md](05-operations/02-budget.md) | 延迟与新鲜度预算 |
| [03-runtime.md](05-operations/03-runtime.md) | 第一期在哪运行、存储与上线原则 |
| [04-第一期准备事项.md](05-operations/04-第一期准备事项.md) | 第一期你需要准备的节点与办理入口 |
| [05-retry-cache.md](05-operations/05-retry-cache.md) | 失败重试、跨链与兑换边界、存储与缓存 |
| [06-elysium-acceptance-confirm.md](05-operations/06-elysium-acceptance-confirm.md) | Elysium 正式验收仍欠项：给 Codex 的确认清单（不替代 02-acceptance） |
| [07-codex-handoff-2026-11-14.md](05-operations/07-codex-handoff-2026-11-14.md) | 2026-11-14 给 Codex 的工作交接：Robinhood 生产拉数 + Elysium 验收确认 |
| [08-codex-handoff-robinhood-alchemy-2026-11-14.md](05-operations/08-codex-handoff-robinhood-alchemy-2026-11-14.md) | 2026-11-14 晚给 Codex 的交接与使用说明：用已配置的 Alchemy 归档节点恢复 Robinhood 扫描并补齐 3 天窗口 |
| [09-codex-handoff-robinhood-backfill-no-wait-2026-11-14.md](05-operations/09-codex-handoff-robinhood-backfill-no-wait-2026-11-14.md) | 2026-11-14 晚给 Codex 的交接：补齐 3 天窗口期间暂停 30 分钟空等，一轮结束立刻续补，并并行提速 |
| [10-codex-handoff-robinhood-heavy-chain-optimize-2026-11-15.md](05-operations/10-codex-handoff-robinhood-heavy-chain-optimize-2026-11-15.md) | RPC 能力与价格读取核查记录；原优化执行内容已合并到 05-roadmap 的 Robinhood 唯一执行清单 |
| [11-codex-handoff-five-minute-incremental-2026-11-15.md](05-operations/11-codex-handoff-five-minute-incremental-2026-11-15.md) | 2026-11-15 给 Codex 的交接：5 分钟续接采集，1 小时仍为记账单位，不另存 5 分钟快照 |
| [12-multichain-incremental-performance-review-2026-11-15.md](05-operations/12-multichain-incremental-performance-review-2026-11-15.md) | 待Grok审核：多链续接性能调查、旧修复占锁、目录/查询与状态读取优化；未授权实施 |
| [13-dollar-valuation-repair-review-2026-11-16.md](05-operations/13-dollar-valuation-repair-review-2026-11-16.md) | RedStone Push报价合同、历史金额重估及修复边界 |
| [14-lp-participation-risk-notices-2026-11-16.md](05-operations/14-lp-participation-risk-notices-2026-11-16.md) | LP参与限制与风险提示最终方案：只对准入池提示，不屏蔽、不改变排序；代码未执行 |
| [15-query-controls-and-funnel-design-2026-11-16.md](05-operations/15-query-controls-and-funnel-design-2026-11-16.md) | 三项准入、组合漏斗及排序统一设计；B中央弹窗已在现有主站实施，进度与验证范围见05唯一清单 |
| [17-solana-venue-architecture-2026-11-20.md](05-operations/17-solana-venue-architecture-2026-11-20.md) | 2026-11-20 Solana 场所接入方案：先补非以太坊底座，第一批先 Meteora DLMM、再 Raydium CLMM；BSC 暂时不动；本轮只改标准，不启用生产扫描 |
| [20-代币分组与FDV及价格档位间距-2026-11-23.md](05-operations/20-代币分组与FDV及价格档位间距-2026-11-23.md) | 三链代币分组、FDV、价格档位间距、筛选、右侧详情和外链 |
| [21-Meteora-DLMM五分钟采集性能-2026-11-23.md](05-operations/21-Meteora-DLMM五分钟采集性能-2026-11-23.md) | P18/P19 性能专项：生产基线、分段测速、定向优化和验收 |

## 06 实战手册

| 文件 | 内容 |
| --- | --- |
| [01-lp-practical-handbook.md](06-playbook/01-lp-practical-handbook.md) | 集中流动性实战手册：选池、铺法、策略库与管仓纪律；1%–2% 只是其中一条，不是全部 |

## Solana基础更新

- [19 · Meteora DLMM 指标补齐与问题复核](05-operations/19-Meteora-DLMM指标补齐与问题复核-2026-11-22.md)（2026-11-22，已确认直接使用官方fees，撤销费用相加；六窗指标与生产加载问题；新口径代码待纠正）

- [方案17 · 接入边界与S0审核](05-operations/17-solana-venue-architecture-2026-11-20.md)
- [方案18 · 官方API主源接入与统一看板](05-operations/18-solana-codex-foundation-2026-11-20.md)（2026-11-22更新；原基础交接保留，当前合同见第0/12节）
- [方案18 · S0/S1实际实施、测试与回滚边界](05-operations/18-solana-s0-s1-implementation-2026-11-21.md)（未部署、未扫描）
