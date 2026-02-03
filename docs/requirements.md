# sUSDD Morpho Vault - Requirements

## 1. Overview

### 1.1 Purpose
Leveraged DeFi Vault that allows users to earn amplified sUSDD yield through Morpho Blue protocol.

### 1.2 High-Level Flow
1. Users deposit **USDT** (base asset) and receive vault shares
2. Vault creates leveraged sUSDD position in **Morpho Blue** (sUSDD collateral, USDT debt)
3. Vault earns amplified sUSDD yield minus borrowing costs

### 1.3 Key Properties
- **No AMM slippage** on sUSDD/USDT conversion (uses PSM + ERC4626)
- **ERC4626 compatible** - standard vault interface (base asset: USDT)
- **Atomic operations** - deposits/withdrawals in single transaction via flash loans

---

## 2. External Dependencies

- **Morpho Blue** - lending/borrowing, flash loans (0% fee)
- **PSM** - USDT ↔ USDD swaps (currently 0 fees, but can be changed)
- **sUSDD** - ERC4626 vault for USDD staking

---

## 3. Roles & Operations

| Role | Operations |
|------|------------|
| **User** | deposit, withdraw, mint, redeem |
| **Keeper** | rebalance (lever/delever) |
| **Manager** | update fees, set fee recipient, set max TVL, harvest fees |
| **Pauser** | pause/unpause |
| **Admin** | grant/revoke roles, emergency withdraw |

---

## 4. Strategy Requirements

### 4.1 Leverage Mechanism
- Each deposit builds a leveraged position at the current `targetLTV`
- Withdrawals unwind the position proportionally to the withdrawal amount
- Idle USDT is used first before unwinding Morpho position

**Example (75% LTV = ~4x leverage):**
- User deposits 1000 USDT
- Final position: ~4000 USDT worth of sUSDD collateral, ~3000 USDT debt
- Net equity: 1000 USDT

### 4.2 Rebalancing
- Keeper monitors LTV and adjusts position via `rebalance(targetLTV)`
- Keeper monitors borrowRate vs sUSDD yield
- Keeper delevers (`rebalance(0)`) if strategy becomes unprofitable
- LTV is validated against both MAX_LTV (90%) and market LLTV

### 4.3 Performance Fee
- Vault charges performance fee on profits above high-water mark
- Manager calls `harvestFees()` to collect fees as minted shares
- No fees charged on user actions (gas optimization)

---

## 5. Configuration Parameters

| Parameter | Description | Example | Constraints |
|-----------|-------------|---------|-------------|
| `targetLTV` | Target leverage ratio | 0.75e18 (75%) | < MAX_LTV and < market LLTV |
| `performanceFeeBps` | Fee on profits (bps) | 1000 (10%) | Max 3000 (30%) |
| `maxTotalAssets` | Vault TVL cap | 10M USDT | - |
| `feeRecipient` | Address receiving fees | - | Non-zero |
| `highWaterMark` | NAV/share threshold | 1e18 | Auto-updated |

---

## 6. Error Handling

| Error | Trigger |
|-------|---------|
| `InvalidLTV` | targetLTV > MAX_LTV (90%) |
| `LTVExceedsLLTV` | targetLTV >= market liquidation threshold |
| `InvalidFee` | performanceFeeBps > 30% |
| `InvalidRecipient` | feeRecipient is zero address |
| `MaxTotalAssetsExceeded` | Deposit would exceed TVL cap |
| `InsufficientWithdrawBalance` | Cannot fulfill withdrawal amount |
| `ZeroNAV` | NAV is zero (underwater position) |
| `UnauthorizedCallback` | Flash loan callback from non-Morpho |

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Vault vulnerability | Audits, bug bounty |
| sUSDD depeg | Emergency delever via `rebalance(0)` |
| High borrow rates | Keeper delevers when unprofitable |
| Liquidation | Conservative LTV, rebalance buffer, LLTV validation |
| Keeper failure | Multiple keepers via AccessControl |
| Morpho liquidity | Monitor utilization off-chain |
| PSM fee changes | Code handles non-zero tin/tout defensively |

---

## 8. External Contracts

| Name | Address |
| --- | --- |
| **USDT** | `0xdac17f958d2ee523a2206206994597c13d831ec7` |
| **USDD** | `0x4f8e5de400de08b164e7421b3ee387f461becd1a` |
| **sUSDD** (Savings USDD) | `0xc5d6a7b61d18afa11435a889557b068bb9f29930` |
| **PSM** | `0xcE355440c00014A229bbEc030A2B8f8EB45a2897` |
| **MORPHO** | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| **MARKET_ID** | `0x29ae8cad946d861464d5e829877245a863a18157c0cde2c3524434dafa34e476` |

---

## 9. Reference Transactions

#### 1. Staking & Unstaking (sUSDD)

* **Staking:** USDD → sUSDD
* [Transaction](https://etherscan.io/tx/0x58bc718ac8dc6125cab202c82e0ccc0ab9392375e9dbdb59d757a33f82789199)


* **Unstaking:** sUSDD → USDD
* [Transaction](https://etherscan.io/tx/0x86638473d343d420c25c8db5bef157aef147c592bd2577924676f1a1234847c8)



#### 2. Peg Stability Module (PSM)

* **Swap:** USDT → USDD
* [Transaction](https://etherscan.io/tx/0xe7088c5aa0f1feb72b1a084d5f27b3a8d05c4a2e02a73104ee9b459f3a1442e1)


* **Swap:** USDD → USDT
* [Transaction](https://etherscan.io/tx/0x5093d9c6576042bcdecaceed24cc92012bb7b3494825eb38d2b49328487bb5e5)


#### 3. Morpho Blue (sUSDD / USDT Market)

[View Market on Morpho](https://app.morpho.org/ethereum/market/0x29ae8cad946d861464d5e829877245a863a18157c0cde2c3524434dafa34e476/susdd-usdt)

**Supply Collateral (sUSDD) & Borrow USDT**

* **Approve sUSDD** (Permit2): [Transaction](https://etherscan.io/tx/0x4452669330f76d5870977104f462ce02e0d1f037c876fc75b097fd7014b7f26b)
* **Supply & Borrow** (Multicall): [Transaction](https://etherscan.io/tx/0x1b4d37e728140bc05741c8b8c07625090dceaf22f6f47dacb922b214b513ea9d)

**Repay USDT & Withdraw Collateral (sUSDD)**

* **Approve USDT** (Permit2): [Transaction](https://etherscan.io/tx/0x53653bc8674799f8223b1e712cbed1b5f3073291420cd5fe84d59837c98cbf45)
* **Repay & Withdraw** (Multicall): [Transaction](https://etherscan.io/tx/0xf13b56fbe3b6a0f16c14f0f414629dc2ae3328f785dfc812ab280e3ba5a3666e)
