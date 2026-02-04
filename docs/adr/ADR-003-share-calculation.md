# ADR-003: Share Calculation

## Question
How do we calculate shares on deposit/withdraw?

## Decision
**Delta NAV approach** for deposits — shares based on actual value added, not deposited amount.
Standard ERC4626 for withdrawals with rounding in favor of the vault.

## Why Delta NAV for Deposits?

Standard ERC4626 formula `shares = assets * totalSupply / totalAssets` doesn't account for conversion costs (PSM fees). This causes **dilution** of existing holders:

```
Example with 1% PSM fee:
├── Vault: 1000 shares, NAV = 1000 USDT
├── Alice holds 100 shares (10%)
│
├── Bob deposits 100 USDT
├── Standard ERC4626: Bob gets 100 shares
├── After PSM fee: Bob actually added 99 USDT value
│
├── Result: Alice's 100 shares now worth 99.5 USDT
└── Alice lost 0.5 USDT due to Bob's deposit! ❌
```

With Delta NAV:
```
├── Bob deposits 100 USDT
├── Position built, NAV increases by 99 USDT (after fees)
├── Delta NAV: Bob gets 99 shares
│
├── Result: Alice's 100 shares still worth 100 USDT
└── No dilution! ✅
```

## Formulas

**Deposit (Delta NAV):**
```
navBefore = totalAssets()
// ... build position ...
navAfter = totalAssets()
valueAdded = navAfter - navBefore
shares = valueAdded * totalSupply / navBefore
```

**Redeem (Standard):**
```
assets = shares * totalAssets / totalSupply
```

## Rounding Rules

Always round against the user initiating the action (in favor of vault):

| Operation | User specifies | User receives | Rounding |
|-----------|----------------|---------------|----------|
| `deposit` | assets (USDT) | shares | DOWN (fewer shares) |
| `redeem` | shares | assets (USDT) | DOWN (fewer assets) |

> **Note:** `mint()` and `withdraw()` are not supported. See ADR-005 for rationale.

## Rationale

1. **Prevents rounding exploits** - Without correct rounding, attackers could extract dust amounts over many transactions.

2. **Protects existing shareholders** - Rounding errors don't dilute existing holders.

3. **Standard practice** - All secure ERC4626 implementations follow this pattern.

## NAV Calculation (totalAssets)

```
totalAssets = idle USDT
            + (sUSDD collateral * sUSDD rate)
            - USDT debt
```

All values in USDT terms. Assumes 1:1 USDD:USDT peg (PSM tin/tout = 0).

### Component Breakdown

**1. Idle USDT:**
```solidity
idleUsdt = IERC20(USDT).balanceOf(address(this))
```

**2. Collateral Value:**
```solidity
// sUSDD → USDD via ERC4626 rate
usddValue = sUSDD.convertToAssets(collateral)

// USDD → USDT (1:1 when PSM fees = 0)
usdtValue = usddValue / 1e12
```

**3. Debt (from Morpho borrowShares):**

Morpho uses share-based accounting for borrows. We use `MorphoBalancesLib.expectedBorrowAssets()` which:
1. Reads current market state
2. Accrues interest to current timestamp
3. Converts shares to assets

```solidity
// We use the library function (includes interest accrual)
debt = morpho.expectedBorrowAssets(marketParams, address(this));
```

This conversion is necessary because:
- Borrow shares represent proportional claim on debt
- Total borrow assets grow over time with interest
- Our debt = our proportion × total debt

### Debt Rounding Behavior

**Important:** `expectedBorrowAssets()` rounds **UP** (conservative for protocol).

From MorphoBalancesLib:
```solidity
return borrowShares.toAssetsUp(totalBorrowAssets, totalBorrowShares);
```

**Edge case:** If `collateral + idle` is very close to `debt`, rounding up can cause:
- Calculated debt slightly exceeds actual collateral value
- `totalAssets()` returns 0 even though real NAV is slightly positive

**Impact:** Minimal (< 1 wei per share conversion). Positions near zero NAV report 0 rather than a tiny positive value. This is conservative and prevents issues with division by near-zero NAV.

### Final NAV

```solidity
if (collateralUsdt + idleUsdt > debtUsdt) {
    return idleUsdt + collateralUsdt - debtUsdt;
}
return 0; // Underwater protection
```

## previewDeposit Implementation

Since Delta NAV requires building the position to know exact shares, `previewDeposit` estimates the expected value:

```solidity
function _estimateDepositValue(uint256 assets) internal view returns (uint256) {
    // IDLE_MODE: USDT stays idle
    if (targetLTV == IDLE_MODE) {
        return assets;
    }

    // Unleveraged mode: convert to sUSDD, no borrowing
    if (targetLTV == 0) {
        uint256 susdd = previewSwapUSDTtoSUSDD(assets);
        return getUSDTValue(susdd);
    }

    // Leveraged mode:
    uint256 borrowAmount = assets * targetLTV / (WAD - targetLTV);
    uint256 totalUsdt = assets + borrowAmount;

    uint256 susdd = previewSwapUSDTtoSUSDD(totalUsdt);
    uint256 susddValue = getUSDTValue(susdd);

    // NAV increase = collateral value - debt
    return susddValue - borrowAmount;
}
```

**Why this works:** PSM is 1:1 (tin/tout = 0), so preview matches actual execution exactly.

### Preview Limitations

`previewDeposit()` and `convertToShares()` are **estimates only**. They do NOT check:
- Paused state → use `maxDeposit() == 0` to detect
- `maxTotalAssets` limit → use `maxDeposit()` to get available capacity
- `DepositTooSmall` → preview may return small non-zero value, but deposit reverts if shares round to 0

Additionally, if sUSDD rate changes between preview and deposit, actual shares may differ slightly.

### Operating Modes

The vault supports three modes based on `targetLTV`:

| Mode | targetLTV | Deposit Behavior | Yield |
|------|-----------|------------------|-------|
| **IDLE_MODE** | `type(uint256).max` | Stay as idle USDT | None |
| **Unleveraged** | `0` | Convert to sUSDD collateral | sUSDD yield |
| **Leveraged** | `1..MAX_LTV` | Build leveraged position | Amplified yield |

**IDLE_MODE (`type(uint256).max`):**
- Deposits stay as idle USDT (no position, no flash loan)
- Value added = deposited assets (1:1)
- **No yield** is earned
- Useful for emergency pause of all strategy exposure

**Unleveraged Mode (`targetLTV = 0`):**
- Deposits convert to sUSDD collateral (no borrowing)
- Value added = sUSDD value after conversion
- Earns **sUSDD staking yield** without leverage
- Useful when carry trade is unprofitable but sUSDD yield is still desired

## Edge Cases

| Case | Handling |
|------|----------|
| First deposit (totalSupply = 0) | shares = navAfter (actual NAV of built position) |
| ZeroNAV (NAV = 0, supply > 0) | `previewDeposit` returns 0, `deposit` reverts with `ZeroNAV` |
| Dust deposit (shares round to 0) | Reverts with `DepositTooSmall` (protects existing holders) |

### ZeroNAV vs Underwater

The vault uses different checks for different operations:

| Condition | Check | Used By |
|-----------|-------|---------|
| **ZeroNAV** | `totalSupply() > 0 && NAV == 0` | `deposit()`, `maxDeposit()` |
| **Underwater** | `currentDebt > 0 && NAV == 0` | `rebalance()` |

**Why different?**
- **Deposits** must prevent division by zero: `shares = value * supply / NAV`
- **Rebalance** only needs to skip when delevering is impossible (debt exists but no value)

### ZeroNAV Behavior (Deposits)

When `totalAssets() == 0` and `totalSupply() > 0`:
- `previewDeposit()` returns 0 (signals deposits blocked)
- `deposit()` reverts with `ZeroNAV`

This protects against division by zero and infinite share minting.

### Underwater Behavior (Rebalance)

When `currentDebt > 0` and `totalAssets() == 0`:
- `rebalance()` is a true no-op (returns early, no state change, no events)
- `redeem()` reverts during flash loan (insufficient USDT to repay)

**Note:** An empty vault (no position, no shares) can still update `targetLTV`.

**Why redeem reverts during flash loan:** The proportional withdrawal attempts to repay debt via flash loan. With insufficient collateral value to cover debt, the flash loan repayment fails.

**Recovery path:** Wait for Morpho liquidation or external capital injection to restore positive NAV.
