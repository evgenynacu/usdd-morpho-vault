# sUSDD Morpho Vault - Requirements

## 1. Overview

### 1.1 Purpose
Leveraged DeFi Vault that allows users to earn amplified sUSDD yield through Morpho Blue protocol.

### 1.2 High-Level Flow
1. Users deposit **USDT** (base asset) and receive vault shares
2. Vault creates leveraged sUSDD position in **Morpho Blue** (sUSDD collateral, USDT debt)
3. Vault earns amplified sUSDD yield minus borrowing costs

### 1.3 Key Properties
- **No AMM slippage** on sUSDD/USDT conversion (rate queryable on-chain)
- **ERC4626 compatible** - standard vault interface (base asset: USDT)
- **Atomic operations** - deposits/withdrawals in single transaction

---

## 2. External Dependencies

- **Morpho Blue** - lending/borrowing, flash loans (0% fee)
- **sUSDD Swap Contract** - on-chain swap without AMM slippage

---

## 3. Roles & Operations

| Role | Operations |
|------|------------|
| **User** | deposit, withdraw, mint, redeem |
| **Keeper** | rebalance (lever/delever) |
| **Manager** | update fees, claim performance fee |
| **Pauser** | pause/unpause |
| **Admin** | grant/revoke roles, emergency withdraw |

---

## 4. Strategy Requirements

### 4.1 Leverage Mechanism
- New deposits increase the existing position proportionally
- Withdrawals reduce the position proportionally

**Example (75% LTV = ~4x leverage):**
- User deposits 1000 USDT
- Final position: ~4000 USDT worth of sUSDD collateral, ~3000 USDT debt
- Net equity: 1000 USDT

### 4.2 Rebalancing
- Keeper monitors LTV and adjusts position (lever/delever) as needed
- Keeper monitors borrowRate vs sUSDD yield
- Keeper decides when to delever if strategy becomes unprofitable

### 4.3 Performance Fee
- Vault accrues performance fee on profits
- Manager can claim accrued fees

---

## 5. Configuration Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `performanceFee` | Fee on profits (bps) | 1000 (10%) |
| `maxTotalAssets` | Vault TVL cap | 10M USDT |

---

## 6. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Vault vulnerability | Audits, bug bounty |
| sUSDD depeg | Emergency delever |
| High borrow rates | Keeper delevers |
| Liquidation | Conservative LTV, rebalance buffer |
| Keeper failure | Multiple keepers |
| Morpho liquidity | Monitor utilization |

---

## 7. External Contracts

```
USDT = 0x...
sUSDD = 0x...
sUSDD_SWAP = 0x...
MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
MARKET_ID = 0x...
```

---

## 8. Open Questions

1. **sUSDD Swap Interface** - need to verify exact interface
2. **Morpho Market** - existing sUSDD/USDT market or need to create?
3. **sUSDD Yield Source** - how to get yield rate for keeper monitoring?
