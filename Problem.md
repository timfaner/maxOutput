**Problem Name:** *Maximum Swap Amount Finder*  
---

### Problem Description  

In decentralized exchanges (DEXs) like **Uniswap V3** and **Curve**, the amount of one token you can swap into another without causing excessive **slippage** depends on the liquidity in the pools. Your task is to write a **TypeScript program** (runnable with **Bun**) that, given an **EVM-compatible network**, two token addresses (`tokenIn` → `tokenOut`), and a **maximum slippage threshold**, computes the **largest input amount** of `tokenIn` such that the effective swap price deviates from the **spot price** by **at most 0.5%**.

The program must consider **direct pools** (Uniswap V3 or Curve) and **multi-hop routes** via **connector tokens** (e.g., WETH, USDC, DAI). It should **simulate** swaps using on-chain pool data (read via **viem**) and use **binary search** or iterative refinement to find the maximum valid input.

---

### Input  

The program is run from the command line:

```bash
bun run findMaxSwap.ts --network <network> --tokenIn <address> --tokenOut <address>
```

- `<network>`: one of `mainnet`, `arbitrum`, `optimism`  
- `<address>`: 40-character hex string (0x...) representing ERC-20 token contract addresses

---

### Output  

A single line printed to **stdout**:

```
Maximum swap amount with 0.5% slippage: X.XX <symbol>
```

- `X.XX` is the maximum input amount (in human-readable units, e.g., 6 decimals for USDC)  
- `<symbol>` is the symbol of `tokenIn` (fetch via `symbol()` call or hardcoded map)

If no route exists or input would be zero:

```
No valid swap route found.
```

---

### Constraints  

- Use **viem** to read on-chain data (pool reserves, `sqrtPriceX96`, liquidity, etc.)  
- Predefine **at least 3 Uniswap V3 pools** and **2 Curve pools** per network    
- **Hardcoded slippage threshold: 0.5%**
- Use strict types, do not use any or never types.
- Get required RPCs from .env file

---

Good luck!