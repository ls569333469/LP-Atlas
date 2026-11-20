export const v3FactoryAbi = [
	{
		type: "event",
		name: "PoolCreated",
		inputs: [
			{ name: "token0", type: "address", indexed: true },
			{ name: "token1", type: "address", indexed: true },
			{ name: "fee", type: "uint24", indexed: true },
			{ name: "tickSpacing", type: "int24", indexed: false },
			{ name: "pool", type: "address", indexed: false },
		],
	},
] as const;

export const v3PoolAbi = [
	{
		type: "event",
		name: "Swap",
		inputs: [
			{ name: "sender", type: "address", indexed: true },
			{ name: "recipient", type: "address", indexed: true },
			{ name: "amount0", type: "int256", indexed: false },
			{ name: "amount1", type: "int256", indexed: false },
			{ name: "sqrtPriceX96", type: "uint160", indexed: false },
			{ name: "liquidity", type: "uint128", indexed: false },
			{ name: "tick", type: "int24", indexed: false },
		],
	},
	{
		type: "function",
		name: "slot0",
		stateMutability: "view",
		inputs: [],
		outputs: [
			{ name: "sqrtPriceX96", type: "uint160" },
			{ name: "tick", type: "int24" },
			{ name: "observationIndex", type: "uint16" },
			{ name: "observationCardinality", type: "uint16" },
			{ name: "observationCardinalityNext", type: "uint16" },
			{ name: "feeProtocol", type: "uint8" },
			{ name: "unlocked", type: "bool" },
		],
	},
	{
		type: "function",
		name: "liquidity",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "uint128" }],
	},
	{
		type: "function",
		name: "token0",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "address" }],
	},
	{
		type: "function",
		name: "token1",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "address" }],
	},
	{
		type: "function",
		name: "fee",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "uint24" }],
	},
] as const;

export const erc20Abi = [
	{
		type: "function",
		name: "symbol",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "string" }],
	},
	{
		type: "function",
		name: "decimals",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "uint8" }],
	},
	{
		type: "function",
		name: "name",
		stateMutability: "view",
		inputs: [],
		outputs: [{ type: "string" }],
	},
	{
		type: "function",
		name: "balanceOf",
		stateMutability: "view",
		inputs: [{ name: "account", type: "address" }],
		outputs: [{ type: "uint256" }],
	},
] as const;

export const v4PoolManagerAbi = [
	{
		type: "event",
		name: "Initialize",
		inputs: [
			{ name: "id", type: "bytes32", indexed: true },
			{ name: "currency0", type: "address", indexed: true },
			{ name: "currency1", type: "address", indexed: true },
			{ name: "fee", type: "uint24", indexed: false },
			{ name: "tickSpacing", type: "int24", indexed: false },
			{ name: "hooks", type: "address", indexed: false },
			{ name: "sqrtPriceX96", type: "uint160", indexed: false },
			{ name: "tick", type: "int24", indexed: false },
		],
	},
	{
		type: "event",
		name: "Swap",
		inputs: [
			{ name: "id", type: "bytes32", indexed: true },
			{ name: "sender", type: "address", indexed: true },
			{ name: "amount0", type: "int128", indexed: false },
			{ name: "amount1", type: "int128", indexed: false },
			{ name: "sqrtPriceX96", type: "uint160", indexed: false },
			{ name: "liquidity", type: "uint128", indexed: false },
			{ name: "tick", type: "int24", indexed: false },
			{ name: "fee", type: "uint24", indexed: false },
		],
	},
] as const;

export const stateViewAbi = [
	{
		type: "function",
		name: "getSlot0",
		stateMutability: "view",
		inputs: [{ name: "poolId", type: "bytes32" }],
		outputs: [
			{ name: "sqrtPriceX96", type: "uint160" },
			{ name: "tick", type: "int24" },
			{ name: "protocolFee", type: "uint24" },
			{ name: "lpFee", type: "uint24" },
		],
	},
	{
		type: "function",
		name: "getLiquidity",
		stateMutability: "view",
		inputs: [{ name: "poolId", type: "bytes32" }],
		outputs: [{ name: "liquidity", type: "uint128" }],
	},
] as const;

export const reservesLensAbi = [
	{
		type: "function",
		name: "getPoolTVL",
		stateMutability: "view",
		inputs: [
			{ name: "manager", type: "address" },
			{
				name: "key",
				type: "tuple",
				components: [
					{ name: "currency0", type: "address" },
					{ name: "currency1", type: "address" },
					{ name: "fee", type: "uint24" },
					{ name: "tickSpacing", type: "int24" },
					{ name: "hooks", type: "address" },
				],
			},
		],
		outputs: [
			{
				name: "result",
				type: "tuple",
				components: [
					{ name: "coreAmount0", type: "uint256" },
					{ name: "coreAmount1", type: "uint256" },
					{ name: "hookReserves0", type: "uint256" },
					{ name: "hookReserves1", type: "uint256" },
					{ name: "hookEffective0", type: "uint256" },
					{ name: "hookEffective1", type: "uint256" },
					{ name: "sqrtPriceX96", type: "uint160" },
					{ name: "tick", type: "int24" },
					{ name: "activeLiquidity", type: "uint128" },
					{ name: "blockNumber", type: "uint256" },
					{ name: "statsProvider", type: "address" },
					{ name: "hookPermissions", type: "uint16" },
					{ name: "hasCustomAccounting", type: "bool" },
					{ name: "statsStatus", type: "uint8" },
				],
			},
		],
	},
] as const;
