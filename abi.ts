import type { Abi } from 'viem';

export const ERC20_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const satisfies Abi;

export const UNISWAP_V3_FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPool',
    stateMutability: 'view',
    inputs: [
      { type: 'address', name: 'tokenA' },
      { type: 'address', name: 'tokenB' },
      { type: 'uint24', name: 'fee' },
    ],
    outputs: [{ type: 'address', name: 'pool' }],
  },
] as const satisfies Abi;

export const QUOTER_V2_ABI = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'view',
    inputs: [
      {
        type: 'tuple',
        name: 'params',
        components: [
          { type: 'address', name: 'tokenIn' },
          { type: 'address', name: 'tokenOut' },
          { type: 'uint256', name: 'amountIn' },
          { type: 'uint24', name: 'fee' },
          { type: 'uint160', name: 'sqrtPriceLimitX96' },
        ],
      },
    ],
    outputs: [
      { type: 'uint256', name: 'amountOut' },
      { type: 'uint160', name: 'sqrtPriceX96After' },
      { type: 'uint32', name: 'initializedTicksCrossed' },
      { type: 'uint256', name: 'gasEstimate' },
    ],
  },
] as const satisfies Abi;

export const CURVE_SABLE_ABI = [
  {
    type: 'function',
    name: 'get_dy',
    stateMutability: 'view',
    inputs: [
      { type: 'int128', name: 'i' },
      { type: 'int128', name: 'j' },
      { type: 'uint256', name: 'dx' },
    ],
    outputs: [{ type: 'uint256', name: 'dy' }],
  },
] as const satisfies Abi;

export const CURVE_CRYPTO_ABI = [
  {
    type: 'function',
    name: 'get_dy',
    stateMutability: 'view',
    inputs: [
      { type: 'uint256', name: 'i' },
      { type: 'uint256', name: 'j' },
      { type: 'uint256', name: 'dx' },
    ],
    outputs: [{ type: 'uint256', name: 'dy' }],
  },
] as const satisfies Abi;

export const UNIV3_POOL_ABI = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies Abi;


export const CURVE_ROUTER_ABI = [
  {"name":"Exchange","inputs":[{"name":"sender","type":"address","indexed":true},
    {"name":"receiver","type":"address","indexed":true},
    {"name":"route","type":"address[11]","indexed":false},
    {"name":"swap_params","type":"uint256[5][5]","indexed":false},
    {"name":"pools","type":"address[5]","indexed":false},
    {"name":"in_amount","type":"uint256","indexed":false},
    {"name":"out_amount","type":"uint256","indexed":false}],"anonymous":false,"type":"event"},
    {"stateMutability":"payable","type":"fallback"},
    {"stateMutability":"payable","type":"function","name":"exchange","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_amount","type":"uint256"},{"name":"_min_dy","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"payable","type":"function","name":"exchange","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_amount","type":"uint256"},{"name":"_min_dy","type":"uint256"},{"name":"_pools","type":"address[5]"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"payable","type":"function","name":"exchange","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_amount","type":"uint256"},{"name":"_min_dy","type":"uint256"},{"name":"_pools","type":"address[5]"},{"name":"_receiver","type":"address"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"view","type":"function","name":"get_dy","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_amount","type":"uint256"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"view","type":"function","name":"get_dy","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_amount","type":"uint256"},{"name":"_pools","type":"address[5]"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"view","type":"function","name":"get_dx","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_out_amount","type":"uint256"},{"name":"_pools","type":"address[5]"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"view","type":"function","name":"get_dx","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_out_amount","type":"uint256"},{"name":"_pools","type":"address[5]"},{"name":"_base_pools","type":"address[5]"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"view","type":"function","name":"get_dx","inputs":[{"name":"_route","type":"address[11]"},{"name":"_swap_params","type":"uint256[5][5]"},{"name":"_out_amount","type":"uint256"},{"name":"_pools","type":"address[5]"},{"name":"_base_pools","type":"address[5]"},{"name":"_base_tokens","type":"address[5]"}],"outputs":[{"name":"","type":"uint256"}]},
    {"stateMutability":"view","type":"function","name":"version","inputs":[],"outputs":[{"name":"","type":"string"}]}] as const satisfies Abi;