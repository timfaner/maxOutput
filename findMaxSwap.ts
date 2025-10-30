/* 
  findMaxSwap.ts
  需求要点：
  - 仅链上只读：viem + QuoterV2 / Curve get_dy
  - 支持主网 / Arbitrum / Optimism
  - 直达与多跳（连接器：WETH/USDC/DAI）
  - 价格偏离（执行价 vs “近零成交”的即时报价）<= 0.5%（50 bps）
  - Bun 运行：bun run findMaxSwap.ts --network <network> --tokenIn <addr> --tokenOut <addr>
*/

import 'dotenv/config';
import {
  Address,
  PublicClient,
  Hex,
  createPublicClient,
  http,
  formatUnits,
  isAddress,
} from 'viem';
import { mainnet, arbitrum, optimism } from 'viem/chains';
import {
  CURVE_DY_INT128_ABI,
  CURVE_DY_UINT256_ABI,
  ERC20_ABI,
  QUOTER_V2_ABI,
  UNISWAP_V3_FACTORY_ABI,
  UNIV3_POOL_ABI,
} from './abi';

// ------------------------- 常量与类型 -------------------------

type Network = 'mainnet' | 'arbitrum' | 'optimism';

const MAX_SLIPPAGE_BPS = 50n; // 0.5%
const UNI_V3_FEE_TIERS: readonly number[] = [500, 3000, 10000] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const POOL_ADDRESS_CACHE = new Map<string, Address | null>();

// QuoterV2（各链一致地址，Uniswap 官方使用 CREATE2 部署）
const QUOTER_V2: Record<Network, Address> = {
  mainnet: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};

// Uniswap V3 Factory（各链一致地址）
const UNISWAP_V3_FACTORY: Record<Network, Address> = {
  mainnet: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  arbitrum: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  optimism: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
};

// 连接器代币（尽量选流动性最强的原生桥版本）
const CONNECTORS: Record<
  Network,
  { WETH: Address; USDC: Address; DAI: Address }
> = {
  mainnet: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    DAI:  '0x6B175474E89094C44Da98b954EedeAC495271d0F',
  },
  arbitrum: {
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // native USDC
    DAI:  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  },
  optimism: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // USDC.e（流动性广）
    DAI:  '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
  },
};

// ------------------------- Curve 预置池 -------------------------
// 说明：不同 Curve 池 get_dy 签名不同（int128 / uint256 索引），这里用 poolSpec 指明。
// 已内置各网络≥2个示例池（可自行扩展）。
type CurveIndexType = 'int128' | 'uint256';

type CurvePoolSpec = {
  name: string;
  pool: Address;
  indexType: CurveIndexType;
  // token 索引映射：tokenAddress => index
  tokenIndex: Record<Address, number>;
};

const CURVE_POOLS: Record<Network, CurvePoolSpec[]> = {
  mainnet: [
    // TriCrypto2: USDT/WBTC/WETH
    {
      name: 'Curve TriCrypto2',
      pool: '0xD51a44d3FaE010294C616387e6cE3fFaEdbB6345',
      indexType: 'uint256',
      tokenIndex: {
        // 注意：键必须是校验后的小写地址字符串
        ['0xdac17f958d2ee523a2206206994597c13d831ec7' as Address]: 0, // USDT
        ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599' as Address]: 1, // WBTC
        ['0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase() as Address]: 2, // WETH
      },
    },
    // sUSD v2: DAI/USDC/USDT/sUSD
    {
      name: 'Curve sUSD v2',
      pool: '0xA5407eAE9Ba41422680e2e00537571bcC53efBfD',
      indexType: 'int128',
      tokenIndex: {
        ['0x6b175474e89094c44da98b954eedeac495271d0f' as Address]: 0, // DAI
        ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address]: 1, // USDC
        ['0xdac17f958d2ee523a2206206994597c13d831ec7' as Address]: 2, // USDT
        ['0x57ab1ec28d129707052df4df418d58a2d46d5f51' as Address]: 3, // sUSD
      },
    },
  ],
  arbitrum: [
    // TriCrypto: USDT/WBTC/WETH
    {
      name: 'Curve TriCrypto (Arbitrum)',
      pool: '0x960ea3e3C7FB317332d990873d354E18d7645590',
      indexType: 'uint256',
      tokenIndex: {
        ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' as Address]: 0, // USDT
        ['0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f' as Address]: 1, // WBTC
        ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'.toLowerCase() as Address]: 2, // WETH
      },
    },
    // 2Pool: USDC/USDT
    {
      name: 'Curve 2Pool (USDC/USDT)',
      pool: '0x7f90122d6d3ea8eaf6b5f8fdd1cfa7f7f6a8ea6a',
      indexType: 'int128',
      tokenIndex: {
        ['0xaf88d065e77c8cc2239327c5edb3a432268e5831' as Address]: 0, // USDC
        ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9' as Address]: 1, // USDT
      },
    },
  ],
  optimism: [
    // TriCrypto: USDT/WBTC/WETH（OP 版）
    {
      name: 'Curve TriCrypto (Optimism)',
      pool: '0x8e0B8c8BB9db49a46697F3a5Bb8A308e7448219D',
      indexType: 'uint256',
      tokenIndex: {
        ['0x94b008aa00579c1307b0ef2c499ad98a8ce58e58' as Address]: 0, // USDT
        ['0x68f180fcce6836688e9084f035309e29bf0a2095' as Address]: 1, // WBTC
        ['0x4200000000000000000000000000000000000006' as Address]: 2, // WETH
      },
    },
    // sUSD v2（OP 版工厂池）：DAI/USDC/USDT/sUSD
    {
      name: 'Curve sUSD v2 (Optimism)',
      pool: '0x4e6a5d356d3a8385a3bdc6cf0cd6a7b8f1b9b5b3',
      indexType: 'int128',
      tokenIndex: {
        ['0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'.toLowerCase() as Address]: 0, // DAI
        ['0x7F5c764cBc14f9669B88837ca1490cCa17c31607'.toLowerCase() as Address]: 1, // USDC.e
        ['0x94b008aa00579c1307b0ef2c499ad98a8ce58e58' as Address]: 2, // USDT
        ['0x8c6f28f2f1a3c87f0f938b96d27520d9751ec8d9' as Address]: 3, // sUSD
      },
    },
  ],
};

// ------------------------- ABIs -------------------------


// ------------------------- 路由与报价 -------------------------

type UniV3Leg = { kind: 'uniV3'; tokenIn: Address; tokenOut: Address; fee: number };
type CurveLeg = { kind: 'curve'; tokenIn: Address; tokenOut: Address; spec: CurvePoolSpec };
type Route = { legs: ReadonlyArray<UniV3Leg | CurveLeg>; label: string };

function lower(a: Address): Address {
  return (a.toLowerCase() as Address);
}

function buildRoutes(
  net: Network,
  tokenIn: Address,
  tokenOut: Address,
): Route[] {
  const routes: Route[] = [];
  const connectors = CONNECTORS[net];
  const tIn = lower(tokenIn);
  const tOut = lower(tokenOut);

  // 1) Uniswap V3 直达（不同费档）
  for (const fee of UNI_V3_FEE_TIERS) {
    routes.push({
      legs: [{ kind: 'uniV3', tokenIn: tIn, tokenOut: tOut, fee }],
      label: `UniV3 ${fee / 10000}% direct`,
    });
  }
  return routes;
  // 2) Uniswap V3 两跳（经由连接器）
  for (const conn of [connectors.WETH, connectors.USDC, connectors.DAI]) {
    const c = lower(conn);
    if (c === tIn || c === tOut) continue;
    for (const f1 of UNI_V3_FEE_TIERS) {
      for (const f2 of UNI_V3_FEE_TIERS) {
        routes.push({
          legs: [
            { kind: 'uniV3', tokenIn: tIn, tokenOut: c, fee: f1 },
            { kind: 'uniV3', tokenIn: c, tokenOut: tOut, fee: f2 },
          ],
          label: `UniV3 ${f1}/${f2} via ${c}`,
        });
      }
    }
  }

  // 3) Curve 直达（如果同池）
  for (const spec of CURVE_POOLS[net]) {
    const idxIn = spec.tokenIndex[lower(tokenIn)];
    const idxOut = spec.tokenIndex[lower(tokenOut)];
    if (idxIn !== undefined && idxOut !== undefined && idxIn !== idxOut) {
      routes.push({
        legs: [{ kind: 'curve', tokenIn: tIn, tokenOut: tOut, spec }],
        label: `Curve ${spec.name} direct`,
      });
    }
  }

  // 4) 跨协议两跳：UniV3 -> Curve
  for (const conn of [connectors.WETH, connectors.USDC, connectors.DAI]) {
    const c = lower(conn);
    if (c === tIn || c === tOut) continue;

    // UniV3( tokenIn -> c ), Curve( c -> tokenOut )
    for (const f1 of UNI_V3_FEE_TIERS) {
      for (const spec of CURVE_POOLS[net]) {
        const idx1 = spec.tokenIndex[c];
        const idx2 = spec.tokenIndex[tOut];
        if (idx1 !== undefined && idx2 !== undefined && idx1 !== idx2) {
          routes.push({
            legs: [
              { kind: 'uniV3', tokenIn: tIn, tokenOut: c, fee: f1 },
              { kind: 'curve', tokenIn: c, tokenOut: tOut, spec },
            ],
            label: `UniV3(${f1}) -> Curve(${spec.name}) via ${c}`,
          });
        }
      }
    }

    // Curve( tokenIn -> c ), UniV3( c -> tokenOut )
    for (const spec of CURVE_POOLS[net]) {
      const idx1 = spec.tokenIndex[tIn];
      const idx2 = spec.tokenIndex[c];
      if (idx1 !== undefined && idx2 !== undefined && idx1 !== idx2) {
        for (const f2 of UNI_V3_FEE_TIERS) {
          routes.push({
            legs: [
              { kind: 'curve', tokenIn: tIn, tokenOut: c, spec },
              { kind: 'uniV3', tokenIn: c, tokenOut: tOut, fee: f2 },
            ],
            label: `Curve(${spec.name}) -> UniV3(${f2}) via ${c}`,
          });
        }
      }
    }
  }

  return routes;
}

function getPoolCacheKey(network: Network, tokenIn: Address, tokenOut: Address, fee: number): string {
  return `${network}:${lower(tokenIn)}:${lower(tokenOut)}:${fee}`;
}

function getChainAndRpc(network: Network) {
  const byNet = {
    mainnet: {
      chain: mainnet,
      rpc: process.env.MAINNET_RPC_URL ?? '',
    },
    arbitrum: {
      chain: arbitrum,
      rpc: process.env.ARBITRUM_RPC_URL ?? '',
    },
    optimism: {
      chain: optimism,
      rpc: process.env.OPTIMISM_RPC_URL ?? '',
    },
  } as const;
  const picked = byNet[network];
  if (!picked.rpc) {
    throw new Error(`缺少 ${network} RPC，请在 .env 中设置相应 *_RPC_URL`);
  }
  const client = createPublicClient({ chain: picked.chain, transport: http(picked.rpc) });
  return client;
}

async function getTokenMeta(client: PublicClient, token: Address): Promise<{ decimals: number; symbol: string }> {
  const decimals = Number(await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }));
  let symbol = '';
  try {
    symbol = await client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' });
  } catch {
    symbol = 'TOKEN';
  }
  return { decimals, symbol };
}

async function quoteUniV3Single(
  client: PublicClient,
  network: Network,
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
  amountIn: bigint,
): Promise<bigint | null> {
  try {
    const cacheKey = getPoolCacheKey(network, tokenIn, tokenOut, fee);
    let poolAddress = POOL_ADDRESS_CACHE.get(cacheKey);

    if (poolAddress === undefined) {
      const fetched = await client.readContract({
        address: UNISWAP_V3_FACTORY[network],
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [tokenIn, tokenOut, fee],
      });

      if (!fetched || fetched === ZERO_ADDRESS) {
        POOL_ADDRESS_CACHE.set(cacheKey, null);
        return null;
      }

      poolAddress = fetched as Address;
      POOL_ADDRESS_CACHE.set(cacheKey, poolAddress);
    } else if (poolAddress === null) {
      return null;
    }

    const { result } = await client.simulateContract({
      address: QUOTER_V2[network],
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const amountOut = result[0] as bigint;
    return amountOut;
  } catch (error) {
    return null;
  }
}

function price1Per0E18(sqrtPriceX96: bigint, decimals0: number, decimals1: number): bigint {
  const s = sqrtPriceX96;
  const numerator = s * s * 10n ** (18n + BigInt(decimals0));
  const denominator = (2n ** 192n) * 10n ** BigInt(decimals1);
  return numerator / denominator;
}

function price0Per1E18(sqrtPriceX96: bigint, decimals0: number, decimals1: number): bigint {
  const s = sqrtPriceX96;
  const numerator = (2n ** 192n) * 10n ** (18n + BigInt(decimals1));
  const denominator = s * s * 10n ** BigInt(decimals0);
  return numerator / denominator;
}

export async function getUniV3MidPrice(
  client: PublicClient,
  tokenIn: Address,
  tokenOut: Address,
  fee: number,
): Promise<bigint> {
  const poolAddress = await client
    .readContract({
      address: UNISWAP_V3_FACTORY.mainnet,
      abi: UNISWAP_V3_FACTORY_ABI,
      functionName: 'getPool',
      args: [tokenIn, tokenOut, fee],
    })
    .then((addr) => addr as Address);

  if (!poolAddress || poolAddress === '0x0000000000000000000000000000000000000000') {
    throw new Error('Uniswap V3 pool not found for given tokens and fee');
  }

  const [token0, token1, slot0] = await Promise.all([
    client.readContract({ address: poolAddress, abi: UNIV3_POOL_ABI, functionName: 'token0' }) as Promise<Address>,
    client.readContract({ address: poolAddress, abi: UNIV3_POOL_ABI, functionName: 'token1' }) as Promise<Address>,
    client.readContract({ address: poolAddress, abi: UNIV3_POOL_ABI, functionName: 'slot0' }) as Promise<
      readonly [bigint, number, number, number, number, number, boolean]
    >,
  ]);

  const [meta0, meta1] = await Promise.all([
    getTokenMeta(client, token0),
    getTokenMeta(client, token1),
  ]);

  const sqrtPriceX96 = slot0[0];
  const tIn = lower(tokenIn);
  const tOut = lower(tokenOut);
  const t0 = lower(token0);
  const t1 = lower(token1);

  if (tIn === t0 && tOut === t1) {
    return price1Per0E18(sqrtPriceX96, meta0.decimals, meta1.decimals);
  }
  if (tIn === t1 && tOut === t0) {
    return price0Per1E18(sqrtPriceX96, meta0.decimals, meta1.decimals);
  }

  throw new Error('Token pair does not match retrieved pool tokens');
}



async function quoteCurve(
  client: PublicClient,
  spec: CurvePoolSpec,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<bigint | null> {
  const i = spec.tokenIndex[lower(tokenIn)];
  const j = spec.tokenIndex[lower(tokenOut)];
  if (i === undefined || j === undefined || i === j) return null;

  try {
    if (spec.indexType === 'int128') {
      const dy = await client.readContract({
        address: spec.pool,
        abi: CURVE_DY_INT128_ABI,
        functionName: 'get_dy',
        args: [BigInt(i), BigInt(j), amountIn],
      });
      return dy;
    } else {
      const dy = await client.readContract({
        address: spec.pool,
        abi: CURVE_DY_UINT256_ABI,
        functionName: 'get_dy',
        args: [BigInt(i), BigInt(j), amountIn],
      });
      return dy;
    }
  } catch {
    return null;
  }
}

async function quoteRouteOut(
  client: PublicClient,
  network: Network,
  route: Route,
  amountIn: bigint,
): Promise<bigint | null> {
  let dx: bigint | null = amountIn;
  for (const leg of route.legs) {
    if (dx === null || dx === 0n) return null;
    if (leg.kind === 'uniV3') {
      dx = await quoteUniV3Single(client, network, leg.tokenIn, leg.tokenOut, leg.fee, dx);
    } else {
      dx = await quoteCurve(client, leg.spec, leg.tokenIn, leg.tokenOut, dx);
    }
  }
  return dx;
}

// 计算：执行价相对“近零成交价”的偏离（含费）是否在 50bps 内
function withinSlippageBps(
  spotRateE18: bigint, // 1 tokenIn 可得 tokenOut 的比率，放大 1e18
  amountIn: bigint,
  amountOut: bigint,
  maxBps: bigint,
): boolean {
  if (amountIn === 0n || amountOut === 0n) return false;
  const execRateE18 = (amountOut * 10n ** 18n) / amountIn;
  if (execRateE18 >= spotRateE18) return true; // 没有负滑点
  const diff = spotRateE18 - execRateE18;
  const bps = (diff * 10000n) / spotRateE18;
  return bps <= maxBps;
}

// 为估算“近零成交价”，用极小输入（1 个最小单位）
function tinyAmount(decimals: number): bigint {
  // 至少 1 个 base unit；对 18 位代币再乘 1e6，避免精度太低
  if (decimals >= 12) return 100n ** BigInt(decimals - 12); // = 1e6 wei for 18-dec
  return 10n;
}

// 指数扩张 + 二分查找最大可输入量
async function maxInputForRoute(
  client: PublicClient,
  network: Network,
  route: Route,
  decimalsIn: number,
): Promise<bigint> {
  const tiny = tinyAmount(decimalsIn);
  const spotOut = await quoteRouteOut(client, network, route, tiny);
  if (!spotOut || spotOut === 0n) return 0n;

  
  const spotRateE18 = (spotOut * 10n ** 18n) / tiny;

  // 初始猜测：0.01 个 token
  const oneCent = decimalsIn >= 2 ? 10n ** BigInt(decimalsIn - 2) : 1n;

  // 是否可用？
  const isGood = async (x: bigint): Promise<boolean> => {
    const out = await quoteRouteOut(client, network, route, x);
    return !!out && withinSlippageBps(spotRateE18, x, out, MAX_SLIPPAGE_BPS);
  };

  let lo = 0n;
  let hi = oneCent;

  // 如果初值太大，向下收缩
  let ok = await isGood(hi);
  if (!ok) {
    for (let i = 0; i < 30 && hi > 1n; i++) {
      hi = hi / 2n;
      ok = await isGood(hi);
      if (ok) break;
    }
    if (!ok) return 0n; // 没有可行区间
  }
  lo = hi;


  const HARD_CAP = 10n ** BigInt(Math.min(36, decimalsIn + 18));
  
  // 2) 指数扩张直到遇到 bad 或到达硬上限
  let bad = lo * 10n;
  while (bad <= HARD_CAP) {
    const ok = await isGood(bad);
    if (!ok) break;       // 找到真正的 bad
    lo = bad;             // 扩大可行解
    bad = bad * 10n;       // 继续翻倍
  }
  
  // 3) 若越界仍然 good，直接把 HARD_CAP 当作上限再试一次
  if (bad > HARD_CAP) {
    if (await isGood(HARD_CAP)) {
      return HARD_CAP;    // 全区间都 good，只能返回硬上限
    } else {
      bad = HARD_CAP;     // HARD_CAP 是 bad，上面已验证
    }
  }
  
  // 4) 现在有边界 [lo, bad] 且 lo good, bad bad，进行二分
  while (bad - lo > tiny) {
    const mid = lo + (bad - lo) / 2n;
    if (bad - lo < tiny*10n){
      console.log('bad - lo < 100', bad - lo);
    }
    if (await isGood(mid)) {
      lo = mid;
    } else {
      bad = mid;
    }
  }
  return lo; // lo 为最大可行输入
}

// ------------------------- CLI & 主流程 -------------------------

function parseArgs(argv: string[]) {
  let network: Network | null = null;
  let tokenIn: Address | null = null;
  let tokenOut: Address | null = null;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--network') {
      network = argv[i + 1] as Network;
      i++;
    } else if (v === '--tokenIn') {
      tokenIn = argv[i + 1] as Address;
      i++;
    } else if (v === '--tokenOut') {
      tokenOut = argv[i + 1] as Address;
      i++;
    }
  }
  if (!network || !['mainnet', 'arbitrum', 'optimism'].includes(network)) {
    throw new Error('参数 --network 必须是 mainnet | arbitrum | optimism');
  }
  if (!tokenIn || !isAddress(tokenIn)) {
    throw new Error('参数 --tokenIn 必须是有效的 0x 地址');
  }
  if (!tokenOut || !isAddress(tokenOut)) {
    throw new Error('参数 --tokenOut 必须是有效的 0x 地址');
  }
  if (lower(tokenIn) === lower(tokenOut)) {
    throw new Error('tokenIn 与 tokenOut 不能相同');
  }
  return { network: network as Network, tokenIn: tokenIn as Address, tokenOut: tokenOut as Address };
}

function formatAmountPretty(amount: bigint, decimals: number): string {
  // 人类可读，小数位不超过 6 位
  const dp = Math.min(6, decimals);
  const full = formatUnits(amount, decimals);
  if (full.indexOf('.') === -1) return full;
  const [integer = '', fractional = ''] = full.split('.');
  const trimmed = fractional.slice(0, dp).replace(/0+$/, '');
  return trimmed.length ? `${integer}.${trimmed}` : integer;
}

(async () => {
  try {
    const { network, tokenIn, tokenOut } = parseArgs(process.argv.slice(2));
    const client = getChainAndRpc(network);

    const [metaIn] = await Promise.all([
      getTokenMeta(client, lower(tokenIn)),
    ]);

    const routes = buildRoutes(network, tokenIn, tokenOut);
    if (routes.length === 0) {
      console.log('No valid swap route found.');
      return;
    }

    let bestAmount: bigint = 0n;
    let bestRoute: Route | null = null;

    // 遍历所有候选路由，取最大可输入
    for (const r of routes) {
      const amt = await maxInputForRoute(client, network, r, metaIn.decimals);
      if (amt > bestAmount) {
        bestAmount = amt;
        bestRoute = r;
      }
    }

    if (!bestRoute || bestAmount === 0n) {
      console.log('No valid swap route found.');
      return;
    }

    const pretty = formatAmountPretty(bestAmount, metaIn.decimals);
    console.log(`Maximum swap amount with 0.5% slippage: ${pretty} ${metaIn.symbol}`);
    // 如需调试，可输出路由：console.error('route=', bestRoute.label);
  } catch (err) {
    console.error((err as Error).message);
    console.log('No valid swap route found.');
  }
})();
