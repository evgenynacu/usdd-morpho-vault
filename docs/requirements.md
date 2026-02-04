# sUSDD Morpho Vault - Requirements

## 1. Overview

### 1.1 Purpose
Leveraged DeFi Vault that allows users to earn amplified sUSDD yield through Morpho Blue protocol.

### 1.2 High-Level Flow (when targetLTV > 0)
1. Users deposit **USDT** (base asset) and receive vault shares
2. Vault creates leveraged sUSDD position in **Morpho Blue** (sUSDD collateral, USDT debt)
3. Vault earns amplified sUSDD yield minus borrowing costs

> **Note:** When `targetLTV = 0`, deposits stay as idle USDT without leverage. See section 4.1.1.

### 1.3 Key Properties
- **No AMM slippage** on sUSDD/USDT conversion (uses PSM + ERC4626)
- **Limited ERC4626** - only `deposit()` and `redeem()` supported (see ADR-005)
- **Atomic operations** - deposits/withdrawals via flash loans (when `targetLTV > 0`)
- **PSM fees assumed 0** - see "PSM Fee Assumption" section below

---

## 2. External Dependencies

- **Morpho Blue** - lending/borrowing, flash loans (0% fee)
- **PSM** - USDT ↔ USDD swaps (currently 0 fees, but can be changed)
- **sUSDD** - ERC4626 vault for USDD staking

---

## 3. Roles & Operations

| Role | Operations |
|------|------------|
| **User** | deposit, redeem (see ADR-005: mint/withdraw not supported) |
| **Keeper** | rebalance (lever/delever) |
| **Manager** | update fees, set fee recipient, set max TVL, harvest fees |
| **Pauser** | pause/unpause |
| **Admin** | grant/revoke roles, pause (for emergency: rebalance(0) THEN pause) |

---

## 4. Strategy Requirements

### 4.1 Leverage Mechanism
- When `targetLTV > 0`: each deposit builds a leveraged position via flash loan
- When `targetLTV = 0`: deposits stay as idle USDT (see section 4.1.1)
- **Deposit shares**: calculated using **Delta NAV** — shares represent actual value added after PSM fees (protects existing holders from dilution)
- **Withdrawals**: use **proportional** approach — both idle USDT and position are withdrawn in the same ratio (fairness-first design)

**Example (75% LTV = ~4x leverage):**
- User deposits 1000 USDT
- Final position: ~4000 USDT worth of sUSDD collateral, ~3000 USDT debt
- Net equity: 1000 USDT

### 4.1.1 No-Leverage Mode (targetLTV = 0)

When `targetLTV = 0`:
- Deposits stay as **idle USDT** (no position built, no flash loan)
- **No sUSDD yield** is earned — deposits remain in USDT
- Useful for emergency pause of leverage without pausing user deposits
- Re-levering via `rebalance(newLTV)` deploys all idle USDT into a new position

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
| `ZeroNAV` | NAV is zero on deposit (underwater position) |
| `DepositTooSmall` | Deposit rounds to 0 shares (dust rejected) |
| `UnauthorizedCallback` | Flash loan callback from non-Morpho |

### Underwater Position (NAV = 0)

When collateral value ≤ debt, the vault is "underwater" and `totalAssets()` returns 0.

| Operation | Behavior |
|-----------|----------|
| `maxDeposit()` | Returns 0 |
| `previewDeposit()` | Returns 0 |
| `convertToShares()` | Returns 0 |
| `deposit()` | Reverts `ZeroNAV` |
| `redeem()` | Reverts during flash loan (insufficient USDT to repay) |
| `rebalance(0)` | No-op (exits early) |

**Recovery:** Wait for Morpho liquidation or inject external capital.

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
| PSM fee changes | See "PSM Fee Assumption" below |
| Morpho exploit via approval | Morpho Blue is immutable (see "Approval Security" below) |

### PSM Fee Assumption

> **Design Decision:** The vault assumes PSM tin/tout fees are **0** (current mainnet state).

This assumption is used in:
- `SwapHelper.sol` — all swap and preview functions
- `SUSDDVault.sol` — NAV calculation, deposit/withdraw logic

**Why we made this choice:**

| Factor | Consideration |
|--------|---------------|
| Current state | PSM tin/tout = 0 on mainnet |
| Probability of change | Very low (USDD governance decision) |
| Code complexity | Handling fees adds ~30% more code |
| Gas cost | Fee calculations in every operation |

**What happens if PSM enables fees:**

| Operation | Behavior | Risk |
|-----------|----------|------|
| Deposit | May work (overpays slightly) | Low |
| Withdraw | Reverts (insufficient USDT) | None (fail-safe) |
| Delever | Reverts (insufficient USDT) | None (fail-safe) |
| Funds | Safe in Morpho | None |

**Resolution path:** Deploy upgraded contract with fee handling, migrate users.

**How reverts happen:** The vault code assumes 1:1 swap rates. If PSM enables fees:
- `buyGem(gemAmt)` expects to receive `gemAmt` USDT
- With fees, PSM sends less than `gemAmt`
- Subsequent operations fail due to insufficient balance

The vault does NOT explicitly check tin/tout values — reverts are a consequence of incorrect assumptions, not explicit guards. This is acceptable because:
1. Reverts are fail-safe (no fund loss)
2. Adding explicit checks would increase code complexity for a low-probability scenario

### Approval Security

> **Design Decision:** The vault grants unlimited token approval to Morpho Blue in constructor.

```solidity
IERC20(USDT).forceApprove(MORPHO, type(uint256).max);
IERC20(SUSDD).forceApprove(MORPHO, type(uint256).max);
```

**Why this is safe for Morpho Blue:**

| Property | Morpho Blue |
|----------|-------------|
| Upgradeable? | ❌ No — immutable singleton, no proxy |
| Admin keys? | ❌ No owner, no governance |
| Token pulling | Only on explicit calls (`repay`, `supplyCollateral`, flash loan) |

**Why not per-operation approval:**
- +25-45k gas per operation
- Flash loan requires approval BEFORE callback executes
- Morpho Blue's immutability makes unlimited approval safe

See [ADR-004](adr/ADR-004-atomic-leverage.md#why-unlimited-approval-is-safe-for-morpho-blue) for detailed rationale.

### Implementation Notes

**USDD Dust from Decimal Conversion**

When converting sUSDD → USDT, the 18→6 decimal division (`usddReceived / 1e12`) truncates up to 0.000001 USDD per swap. This dust:
- Stays in the vault as USDD balance
- Is NOT included in `totalAssets()` (which only counts USDT, sUSDD collateral, debt)
- Accumulates over time but is negligible (< 1 USDD per million swaps)
- No sweep mechanism implemented (gas cost exceeds value)

**TVL Limit Check**

`maxTotalAssets` is checked conservatively BEFORE position is built:
```solidity
if (assets + totalAssets() > maxTotalAssets) revert MaxTotalAssetsExceeded();
```
This means the actual NAV after deposit may be slightly different due to sUSDD rate. The check is intentionally conservative to ensure the limit is never exceeded.

**Preview Functions**

`previewDeposit()` and `convertToShares()` return estimates based on current state. They do NOT check:
- Paused state
- `maxTotalAssets` limit
- Whether deposit would result in `DepositTooSmall`

This is standard ERC4626 behavior. Integrators should check `maxDeposit()` to determine if deposits are actually allowed.

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
