# sUSDD Morpho Vault - Requirements

## 1. Overview

### 1.1 Purpose
Leveraged DeFi Vault that allows users to earn amplified sUSDD yield through Morpho Blue protocol.

### 1.2 High-Level Flow (when targetLTV > 0)
1. Users deposit **USDT** (base asset) and receive vault shares
2. Vault creates leveraged sUSDD position in **Morpho Blue** (sUSDD collateral, USDT debt)
3. Vault earns amplified sUSDD yield minus borrowing costs

> **Note:** When `targetLTV = IDLE_MODE`, deposits stay as idle USDT. When `targetLTV = 0`, deposits convert to unleveraged sUSDD. See section 4.1.1.

### 1.3 Key Properties
- **No AMM slippage** on sUSDD/USDT conversion (uses PSM + ERC4626)
- **Limited ERC4626** - only `deposit()` and `redeem()` supported (see ADR-005)
- **Atomic operations** - deposits/withdrawals via flash loans (when `targetLTV > 0`)
- **PSM tout handled dynamically** - swap functions account for PSM buyGem fee; see "PSM Fee Handling" section below

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
| **Keeper** | rebalance (lever/delever), harvestFees (emit heartbeat) |
| **Manager** | update fees, set fee recipient, set max TVL, manage whitelist |
| **Pauser** | pause/unpause |
| **Admin** | grant/revoke roles, pause (for emergency: rebalance(IDLE_MODE) THEN pause) |

---

## 4. Strategy Requirements

### 4.1 Leverage Mechanism

The vault supports three operating modes based on `targetLTV`:

| Mode | targetLTV Value | Deposit Behavior | Yield |
|------|-----------------|------------------|-------|
| **IDLE_MODE** | `type(uint256).max` | Stay as idle USDT | None |
| **Unleveraged** | `0` | Convert to sUSDD collateral (no debt) | sUSDD yield |
| **Leveraged** | `1..MAX_LTV` | Build leveraged sUSDD position | Amplified sUSDD yield |

- **Deposit shares**: calculated using **Delta NAV** — shares represent actual value added after PSM fees (protects existing holders from dilution)
- **Withdrawals**: use **proportional** approach — both idle USDT and position are withdrawn in the same ratio (fairness-first design)

**Example (75% LTV = ~4x leverage):**
- User deposits 1000 USDT
- Final position: ~4000 USDT worth of sUSDD collateral, ~3000 USDT debt
- Net equity: 1000 USDT

### 4.1.1 Operating Modes

**IDLE_MODE (`type(uint256).max`):**
- Deposits stay as **idle USDT** (no position built, no flash loan)
- **No yield** is earned — deposits remain in USDT
- Useful for emergency pause of all strategy exposure
- Re-entering any other mode via `rebalance()` deploys idle USDT

**Unleveraged Mode (`targetLTV = 0`):**
- Deposits convert to **sUSDD collateral** in Morpho (no borrowing)
- Earns **sUSDD staking yield** without leverage
- Useful when carry trade is unprofitable but sUSDD yield is still desired
- Transitioning to/from leveraged mode via `rebalance()` adjusts position

**Leveraged Mode (`targetLTV > 0`):**
- Deposits build **leveraged sUSDD position** (collateral + debt)
- Earns **amplified sUSDD yield** minus borrowing costs
- Target LTV must be below both MAX_LTV (91.5%) and market LLTV

### 4.2 Rebalancing
- Keeper monitors LTV and adjusts position via `rebalance(targetLTV)`
- Keeper monitors borrowRate vs sUSDD yield
- Mode transitions via `rebalance()`:
  - `rebalance(IDLE_MODE)` → Exit to idle USDT (emergency)
  - `rebalance(0)` → Unleveraged sUSDD (when carry trade unprofitable)
  - `rebalance(newLTV)` → Adjust leverage ratio
- LTV is validated against both MAX_LTV (91.5%) and market LLTV

### 4.3 Performance Fee
- Vault charges performance fee on profits above high-water mark
- Fees are **automatically accrued** on every deposit/redeem (before share mint/burn)
- Keeper can also call `claimRewards("0x")` to accrue fees + emit heartbeat event
- This ensures fairness: fees are always current before any share price calculation

---

## 5. Configuration Parameters

| Parameter | Description | Example | Constraints |
|-----------|-------------|---------|-------------|
| `targetLTV` | Target leverage mode | 0.75e18 (75%) | IDLE_MODE, 0, or <= MAX_LTV (91.5%) and < LLTV |
| `performanceFeeBps` | Fee on profits (bps) | 1000 (10%) | Max 3000 (30%) |
| `maxTotalAssets` | Vault TVL cap | 10M USDT | - |
| `feeRecipient` | Address receiving fees | - | Non-zero |
| `highWaterMark` | NAV/share threshold | 1e18 | Auto-updated |
| `IDLE_MODE` | Constant for idle mode | `type(uint256).max` | Immutable constant |
| `whitelistEnabled` | Restrict deposit/redeem to whitelisted | true (default) | Toggle via Manager |
| `whitelisted` | Mapping of allowed addresses | - | Managed via Manager |

---

## 5.1 Whitelist

The vault supports optional whitelist mode to restrict deposits and redemptions during testing period.

### Behavior

| State | Deposit | Redeem |
|-------|---------|--------|
| `whitelistEnabled = true` | Both caller AND receiver must be whitelisted | Both owner AND receiver must be whitelisted |
| `whitelistEnabled = false` | Open to everyone | Open to everyone |

### Default State

- `whitelistEnabled = true` by default (whitelist active)
- Addresses must be added before anyone can deposit/redeem

### Management (MANAGER_ROLE)

| Function | Description |
|----------|-------------|
| `setWhitelistEnabled(bool)` | Enable or disable whitelist mode |
| `addToWhitelist(address)` | Add single address |
| `removeFromWhitelist(address)` | Remove single address |

### Notes

- Share transfers (ERC20) are NOT restricted - non-whitelisted addresses can hold shares but not redeem
- Fee accrual (`_mint` to feeRecipient) bypasses whitelist
- After testing period: call `setWhitelistEnabled(false)` to open to everyone

---

## 6. Error Handling

| Error | Trigger |
|-------|---------|
| `InvalidAdmin` | admin is zero address in initialize() |
| `InvalidLTV` | targetLTV > MAX_LTV (91.5%) |
| `LTVExceedsLLTV` | targetLTV >= market liquidation threshold |
| `InvalidFee` | performanceFeeBps > 30% |
| `InvalidRecipient` | feeRecipient is zero address |
| `MaxTotalAssetsExceeded` | Deposit would exceed TVL cap |
| `ZeroNAV` | NAV is zero on deposit (shares exist but NAV=0) |
| `DepositTooSmall` | Deposit rounds to 0 shares (dust rejected) |
| `NotWhitelisted` | Address not whitelisted when whitelist enabled |
| `UnauthorizedCallback` | Flash loan callback from non-Morpho |

### ZeroNAV vs Underwater

The vault distinguishes between two related but different conditions:

| Condition | Definition | Check |
|-----------|------------|-------|
| **ZeroNAV** | NAV=0 while shares exist | `totalSupply() > 0 && totalAssets() == 0` |
| **Underwater** | Debt exceeds collateral value | `currentDebt > 0 && totalAssets() == 0` |

**ZeroNAV** is broader — it includes underwater positions AND the rare case where sUSDD depegs to 0 without debt.

**Why different checks?**
- **Deposits** check `totalSupply() > 0` because `shares = value * supply / NAV` would divide by zero
- **Rebalance** checks `currentDebt > 0` because delevering requires debt to repay

### ZeroNAV Behavior (for deposits)

When `totalAssets() == 0` and `totalSupply() > 0`:

| Operation | Behavior |
|-----------|----------|
| `maxDeposit()` | Returns 0 |
| `previewDeposit()` | Returns 0 |
| `convertToShares()` | Returns 0 |
| `deposit()` | Reverts `ZeroNAV` |

### Underwater Behavior (for rebalance)

When `currentDebt > 0` and `totalAssets() == 0`:

| Operation | Behavior |
|-----------|----------|
| `rebalance(*)` | True no-op (no state change, no events) |
| `redeem()` | Reverts during flash loan (insufficient USDT to repay) |

**Note:** An empty vault (no position, no shares) can still have its `targetLTV` updated via `rebalance()`.

**Recovery:** Wait for Morpho liquidation or inject external capital.

### Tiny Redemption Edge Cases

For extremely small redemptions, rounding can cause edge cases:

| Scenario | sharesToRepay | collateralToWithdraw | Behavior |
|----------|---------------|---------------------|----------|
| Normal | > 0 | > 0 | Full proportional unwind via flash loan |
| Both zero | 0 | 0 | User gets only idle portion |
| Collateral only | 0 | > 0 (debt exists) | **Skip** - protects remaining LTV |
| Debt only | > 0 | 0 | **Skip** - can't repay flash loan without collateral |

In skip scenarios, user receives only their proportional share of idle USDT. This protects remaining depositors from micro-redemptions that would harm the position.

### Tiny Deposit Edge Case

For extremely small deposits in leveraged mode (`targetLTV > 0`), if `borrowAmount` rounds to 0:
- Deposit becomes **unleveraged** (sUSDD collateral only, no debt)
- This prevents reverts on micro-deposits
- User still receives shares proportional to value added

This is intentional: reverting on tiny deposits would harm UX, and the "unleveraged" fallback is safe.

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Vault vulnerability | Audits, bug bounty |
| sUSDD depeg | Emergency exit via `rebalance(IDLE_MODE)` |
| High borrow rates | Keeper switches to `rebalance(0)` (unleveraged) or `IDLE_MODE` |
| Liquidation | Conservative LTV, rebalance buffer, LLTV validation |
| Keeper failure | Multiple keepers via AccessControl |
| Morpho liquidity | Monitor utilization off-chain |
| PSM fee changes | tout handled dynamically; tin reduces deposit value (captured by Delta NAV) |
| Morpho exploit via approval | Morpho Blue is immutable (see "Approval Security" below) |

### PSM Fee Handling

> **Design Decision:** Swap functions handle PSM `tout` (buyGem fee) dynamically. NAV calculation assumes 1:1 peg (ignores fees).

**tout (buyGem fee):**
- `SwapHelper` calculates `gemAmt = usddAmount * 1e6 / (1e18 + tout)` — accounts for the fee when converting USDD → USDT
- When `tout = 0`, this simplifies to `usddAmount / 1e12` (1:1 swap)
- When `tout > 0`, user receives less USDT but operations succeed

**tin (sellGem fee):**
- No special handling needed — PSM takes fee from output USDD
- Delta NAV correctly reflects the reduced deposit value (fewer sUSDD shares minted)

**NAV calculation:**
- `getUSDTValue()` uses 1:1 USDD:USDT peg (ignores tout)
- Rationale: tout is a swap fee, not a depeg — deducting it from NAV would undervalue the vault

**Preview functions:**
- `previewDeposit()`, `previewSwapSUSDDtoUSDT()` etc. assume tin/tout = 0
- These are estimates only; actual shares use Delta NAV
- Integrators should not rely on preview accuracy if PSM fees change

| Operation | Behavior with tout > 0 |
|-----------|----------------------|
| `deposit()` | Works (Delta NAV captures actual value) |
| `redeem()` | Works (user receives less USDT) |
| `rebalance(IDLE_MODE)` | Works (less USDT recovered) |
| `previewDeposit()` | Slightly inaccurate estimate |
| `totalAssets()` | Unaffected (NAV ignores tout) |

### Approval Security

> **Design Decision:** The vault grants unlimited token approval to Morpho Blue in `initialize()`.

```solidity
// In initialize()
IERC20(Constants.USDT).forceApprove(Constants.MORPHO, type(uint256).max);
IERC20(Constants.SUSDD).forceApprove(Constants.MORPHO, type(uint256).max);
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

When converting USDD → USDT via PSM, the `gemAmt` calculation (`usddAmount * 1e6 / (1e18 + tout)`) may leave small USDD remainders. This dust:
- Stays in the vault as USDD balance
- Is NOT included in `totalAssets()` (which only counts USDT, sUSDD collateral, debt)
- Accumulates over time but is negligible
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
