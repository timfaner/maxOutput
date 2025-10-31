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
  CURVE_SABLE_ABI,
  CURVE_CRYPTO_ABI,
  ERC20_ABI,
  QUOTER_V2_ABI,
  UNISWAP_V3_FACTORY_ABI,
  UNIV3_POOL_ABI,
} from './abi';

// ------------------------- Constants and Types -------------------------

type Network = 'mainnet' | 'arbitrum' | 'optimism';

const MAX_SLIPPAGE_BPS = 50n; // 0.5%
const UNI_V3_FEE_TIERS: readonly number[] = [500, 3000] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
const POOL_ADDRESS_CACHE = new Map<string, Address | null>();

// QuoterV2 (same address on every chain, deployed by Uniswap with CREATE2)
const QUOTER_V2: Record<Network, Address> = {
  mainnet: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  optimism: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
};

// Uniswap V3 Factory (same address on every chain)
const UNISWAP_V3_FACTORY: Record<Network, Address> = {
  mainnet: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  arbitrum: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  optimism: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
};

// Connector tokens (prefer the native-bridge variants with the deepest liquidity)
const CONNECTORS: Record<
  Network,
  { WETH: Address; USDC: Address; USDT: Address }
> = {
  mainnet: {
    WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    USDT:  '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  arbitrum: {
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    USDC: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', // USDC.e
    USDT:  '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  },
  optimism: {
    WETH: '0x4200000000000000000000000000000000000006',
    USDC: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', // USDC.e (broad liquidity)
    USDT:  '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  },
};

// ------------------------- Curve Preset Pools -------------------------
// Note: different Curve pools use different get_dy signatures (StablePool / CryptoPool indexes); poolSpec clarifies them here.
// Each network ships with at least two sample pools (feel free to extend).
type CurveIndexType = 'StablePool' | 'CryptoPool';

type CurvePoolSpec = {
  name: string;
  pool: Address;
  indexType: CurveIndexType;
  // Token index mapping: tokenAddress => index
  tokenIndex: Record<Address, number>;
};

const CURVE_POOLS: Record<Network, CurvePoolSpec[]> = {
  mainnet: [
    // TriCrypto2: USDT/WBTC/WETH
    {
      name: 'Curve TriCrypto2',
      pool: '0xD51a44d3FaE010294C616388b506AcdA1bfAAE46',
      indexType: 'CryptoPool',
      tokenIndex: {
        // Note: keys must be validated lowercase address strings
        ['0xdAC17F958D2ee523a2206206994597C13D831ec7'.toLowerCase() as Address]: 0, // USDT
        ['0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'.toLowerCase() as Address]: 1, // WBTC
        ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase() as Address]: 2, // WETH
      },
    },
    // DAI/USDC/USDT
    {
      name: 'Curve DAI/USDC/USDT',
      pool: '0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7',
      indexType: 'StablePool',
      tokenIndex: {
        ['0x6B175474E89094C44Da98b954EedeAC495271d0F'.toLowerCase()  as Address]: 0, // DAI
        ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'.toLowerCase() as Address]: 1, // USDC
        ['0xdAC17F958D2ee523a2206206994597C13D831ec7'.toLowerCase() as Address]: 2, // USDT

      },
    },
  ],
  arbitrum: [
    // TriCrypto: USDT/WBTC/WETH
    {
      name: 'Curve TriCrypto (Arbitrum)',
      pool: '0x960ea3e3C7FB317332d990873d354E18d7645590',
      indexType: 'CryptoPool',
      tokenIndex: {
        ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'.toLowerCase() as Address]: 0, // USDT
        ['0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'.toLowerCase() as Address]: 1, // WBTC
        ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'.toLowerCase() as Address]: 2, // WETH
      },
    },
    // 2Pool: USDC/USDT
    {
      name: 'Curve 2Pool (USDC/USDT)',
      pool: '0x7f90122BF0700F9E7e1F688fe926940E8839F353',
      indexType: 'StablePool',
      tokenIndex: {
        ['0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8'.toLowerCase() as Address]: 0, // USDC.e
        ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'.toLowerCase() as Address]: 1, // USDT
      },
    },
  ],
  optimism: [
    // TriCrypto: USDT/WBTC/WETH (Optimism version)
    {
      name: 'Curve crvUSD/USDT (Optimism)',
      pool: '0xD1b30BA128573fcd7D141C8A987961b40e047BB6',
      indexType: 'StablePool',
      tokenIndex: {
        ['0xC52D7F23a2e460248Db6eE192Cb23dD12bDDCbf6'.toLowerCase() as Address]: 0, // crvUSD
        ['0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'.toLowerCase() as Address]: 1, // USDT
      },
    },
    // 3pool (Optimism): DAI/USDC/USDT
    {
      name: 'Curve 3pool (Optimism)',
      pool: '0x1337BedC9D22ecbe766dF105c9623922A27963EC',
      indexType: 'StablePool',
      tokenIndex: {
        ['0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'.toLowerCase() as Address]: 0, // DAI
        ['0x7F5c764cBc14f9669B88837ca1490cCa17c31607'.toLowerCase() as Address]: 1, // USDC.e
        ['0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'.toLowerCase() as Address]: 2, // USDT
      },
    },
    {
      name: 'Curve Tricrypto-crvUSD (Optimism)',
      pool: '0x4456d13Fc6736e8e8330394c0C622103E06ea419',
      indexType: 'CryptoPool',
      tokenIndex: {
        ['0xC52D7F23a2e460248Db6eE192Cb23dD12bDDCbf6'.toLowerCase() as Address]: 0, // crvUSD
        ['0x68f180fcCe6836688e9084f035309E29Bf0A2095'.toLowerCase() as Address]: 1, // WBTC
        ['0x4200000000000000000000000000000000000006'.toLowerCase() as Address]: 2, // WETH
      },
    },
  ],
};

// ------------------------- ABIs -------------------------


// ------------------------- Routing and Quotes -------------------------

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
  const rawConnectorList = [connectors.WETH, connectors.USDC, connectors.USDT].filter(Boolean) as Address[];
  const connectorList = Array.from(new Set(rawConnectorList.map(lower)))
    .filter((addr) => addr !== tIn && addr !== tOut);
  const curveSpecs = CURVE_POOLS[net];

  const addRoute = (legs: Route['legs'], label: string) => {
    routes.push({ legs, label });
  };

  const hasCurvePath = (spec: CurvePoolSpec, a: Address, b: Address) => {
    const idxA = spec.tokenIndex[a];
    const idxB = spec.tokenIndex[b];
    return idxA !== undefined && idxB !== undefined && idxA !== idxB;
  };

  // 1) Direct Uniswap V3 (different fee tiers)
  for (const fee of UNI_V3_FEE_TIERS) {
    addRoute([{ kind: 'uniV3', tokenIn: tIn, tokenOut: tOut, fee }], `UniV3 ${fee / 10000}% direct`);
  }

  // 2) Two-hop Uniswap V3 (via connector)
  for (const c of connectorList) {
    for (const f1 of UNI_V3_FEE_TIERS) {
      for (const f2 of UNI_V3_FEE_TIERS) {
        addRoute(
          [
            { kind: 'uniV3', tokenIn: tIn, tokenOut: c, fee: f1 },
            { kind: 'uniV3', tokenIn: c, tokenOut: tOut, fee: f2 },
          ],
          `UniV3 ${f1}/${f2} via ${c}`,
        );
      }
    }
  }

  // 3) Direct Curve swap (if in the same pool)
  for (const spec of curveSpecs) {
    if (hasCurvePath(spec, tIn, tOut)) {
      addRoute([{ kind: 'curve', tokenIn: tIn, tokenOut: tOut, spec }], `Curve ${spec.name} direct`);
    }
  }

  // 4) Cross-protocol two-hop: UniV3 -> Curve / Curve -> UniV3
  for (const c of connectorList) {
    for (const f1 of UNI_V3_FEE_TIERS) {
      for (const spec of curveSpecs) {
        if (hasCurvePath(spec, c, tOut)) {
          addRoute(
            [
              { kind: 'uniV3', tokenIn: tIn, tokenOut: c, fee: f1 },
              { kind: 'curve', tokenIn: c, tokenOut: tOut, spec },
            ],
            `UniV3(${f1}) -> Curve(${spec.name}) via ${c}`,
          );
        }
      }
    }

    for (const spec of curveSpecs) {
      if (!hasCurvePath(spec, tIn, c)) continue;
      for (const f2 of UNI_V3_FEE_TIERS) {
        addRoute(
          [
            { kind: 'curve', tokenIn: tIn, tokenOut: c, spec },
            { kind: 'uniV3', tokenIn: c, tokenOut: tOut, fee: f2 },
          ],
          `Curve(${spec.name}) -> UniV3(${f2}) via ${c}`,
        );
      }
    }
  }

  // 5) Two-hop Curve (via connector)
  for (const c of connectorList) {
    for (const spec of curveSpecs) {
      if (!hasCurvePath(spec, tIn, c)) continue;
      for (const spec2 of curveSpecs) {
        if (!hasCurvePath(spec2, c, tOut)) continue;
        addRoute(
          [
            { kind: 'curve', tokenIn: tIn, tokenOut: c, spec },
            { kind: 'curve', tokenIn: c, tokenOut: tOut, spec: spec2 },
          ],
          `Curve(${spec.name}) -> Curve(${spec2.name}) via ${c}`,
        );
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
    if (spec.indexType === 'StablePool') {
      const dy = await client.readContract({
        address: spec.pool,
        abi: CURVE_SABLE_ABI,
        functionName: 'get_dy',
        args: [BigInt(i), BigInt(j), amountIn],
      });
      return dy;
    } else {
      const dy = await client.readContract({
        address: spec.pool,
        abi: CURVE_CRYPTO_ABI,
        functionName: 'get_dy',
        args: [BigInt(i), BigInt(j), amountIn],
      });
      return dy;
    }
  } catch (error) {
    console.error('quoteCurve error', error, tokenIn, tokenOut,amountIn);
    return null;
  }
}


// TODO: use Curve Router and uniswap router to quote connector swap
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

// Check if the execution price deviates from the "near-zero execution price" (including fees) by no more than 50bps.
function withinSlippageBps(
  spotRateE18: bigint, // Ratio of tokenOut per 1 tokenIn, scaled by 1e18
  amountIn: bigint,
  amountOut: bigint,
  maxBps: bigint,
): boolean {
  if (amountIn === 0n || amountOut === 0n) return false;
  const execRateE18 = (amountOut * 10n ** 18n) / amountIn;
  if (execRateE18 >= spotRateE18) return true; // No negative slippage
  const diff = spotRateE18 - execRateE18;
  const bps = (diff * 10000n) / spotRateE18;
  return bps <= maxBps;
}

// small amount for quoteRouteOut
function tinyAmount(decimals: number): bigint {
  // At least one base unit; multiply by 1e6 for 18-dec tokens to avoid poor precision
  if (decimals >= 12) return 1000n ** BigInt(decimals - 12); // = 1e6 wei for 18-dec
  return 10n;
}

// Exponential expansion + binary search for the maximum input amount
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

  // Initial guess: 0.01 token
  const oneCent = decimalsIn >= 2 ? 10n ** BigInt(decimalsIn - 2) : 1n;

  // Is it viable?
  const isGood = async (x: bigint): Promise<boolean> => {
    const out = await quoteRouteOut(client, network, route, x);
    return !!out && withinSlippageBps(spotRateE18, x, out, MAX_SLIPPAGE_BPS);
  };

  let lo = 0n;
  let hi = oneCent;

  // If the initial value is too large, shrink downward
  let ok = await isGood(hi);
  if (!ok) {
    for (let i = 0; i < 30 && hi > 1n; i++) {
      hi = hi / 2n;
      ok = await isGood(hi);
      if (ok) break;
    }
    if (!ok) return 0n; // No feasible interval
  }
  lo = hi;


  const HARD_CAP = 10n ** BigInt(Math.min(36, decimalsIn + 18));
  
  // 2) exponential expansion until bad or hard cap
  let bad = lo * 10n;
  while (bad <= HARD_CAP) {
    const ok = await isGood(bad);
    if (!ok) break;       // Found the actual bad value
    lo = bad;             // Expand the feasible solution
    bad = bad * 10n;       // Keep doubling
  }
  
  // 3) if bad > HARD_CAP, try HARD_CAP again
  if (bad > HARD_CAP) {
    if (await isGood(HARD_CAP)) {
      return HARD_CAP;    // Entire range is good, so return the hard cap
    } else {
      bad = HARD_CAP;     // HARD_CAP is bad, already confirmed above
    }
  }
  
  const gap = decimalsIn >= 8 ? 10n ** BigInt(decimalsIn - 8) : 1n;
  // 4) now have boundary [lo, bad] and lo good, bad bad, binary search
  while (bad - lo > gap) {
    const mid = lo + (bad - lo) / 2n;
    if (await isGood(mid)) {
      lo = mid;
    } else {
      bad = mid;
    }
  }
  return lo; 
}

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

    // Iterate through all candidate routes and take the largest feasible input
    const promiseList = routes.map(r => 
      maxInputForRoute(client, network, r, metaIn.decimals).then(amt => ({ amt, r }))
    );
    const amtRouteList = await Promise.all(promiseList);

    for (const { amt, r } of amtRouteList) {
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
    console.log('route=', bestRoute.label);
  } catch (err) {
    console.error((err as Error).message);
    console.log('No valid swap route found.');
  }
})();
