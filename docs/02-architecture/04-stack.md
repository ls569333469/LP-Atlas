# 语言、SDK 与仓库

语言按三层选：

1. 策略验证可以用 Python。现有仓库 `D:\Axiangmu\流动性LP` 停在这一层，用来对照公式和回放，不再当产品主栈加码。
2. 工业级 LP 主系统用 TypeScript（Node.js）。EVM 用 `viem` 加官方 Uniswap SDK（V4 用 `@uniswap/v4-sdk`，并锁定版本；滑点按「到手少多少」理解，与 `amountMin` 一致），Pancake Infinity 用 `@pancakeswap/infinity-sdk`，不要拿 V3 SDK 硬套。Solana 用 `@meteora-ag/dlmm`（注意破坏性改动，Position v1 已移除）和钉版本的 `@raydium-io/raydium-sdk-v2`，不要用已停更的 v1。扫描、执行、API 和前端同一种语言、同一份类型。
3. 实战高频套利的热路径才改 Rust。Go 是中间档，LP 阶段不选。

## 仓库位置与目录

- 产品仓库：`D:\Axiangmu\LP Atlas`
- 文档：`docs/`，按 01 到 05 分类排序，见 [文档目录](../README.md)
- 主系统代码：`src/`。当前产品代码暂停更新，须等用户解除暂停后再继续。
- HTTP 进程：`src/server/`，只作为 API 宿主。
- 给所有 AI 的说明：仓库根目录 `AGENTS.md`

TypeScript 目录按这个切：`chains/evm`、`chains/solana` 管接入与签名（执行阶段再补）；第一期先在 `src/adapters/` 按协议写接入，预留 `uniswap-v3`、`uniswap-v4`、`pancakeswap-v3`、`pancakeswap-infinity`、`meteora`、`raydium`。Infinity 与 Uniswap V4 结构不同，适配器必须分开写。后期协议（Base 上 Pancake 的现行官方协议、Meteora DAMM V2）轮到该链或该协议时再单独写适配器，不提前实现。`normalize`、`scanner`、`positions`、`strategy`、`risk`、`execution/router` 都只依赖统一模型。
