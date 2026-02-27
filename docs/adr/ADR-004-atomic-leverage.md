# ADR-004: Atomic Leverage

## Question
How do we achieve leverage atomically in a single transaction?

## Decision
**Flash loan from Morpho Blue** (0% fee) to build/unwind leverage in one transaction.

## Flash Loan Operation Types

The vault uses four operation types in flash loan callbacks:

| Op Code | Name | Parameters | Purpose |
|---------|------|------------|---------|
| 1 | `OP_DEPOSIT` | `uint256 depositedUsdt` | Build leveraged position from user deposit |
| 2 | `OP_WITHDRAW` | `uint256 sharesToRepay, uint256 collateralToWithdraw` | Unwind position for user withdrawal |
| 3 | `OP_LEVER_UP` | (none) | Increase leverage (borrow more, add collateral) |
| 4 | `OP_DELEVER` | `bool withdrawAllCollateral` | Reduce leverage or exit position |

**OP_DELEVER** handles three scenarios via `withdrawAllCollateral` flag and auto-detection:
- **Partial delever** (`withdrawAllCollateral=false`, partial debt): Repay by assets, withdraw only enough collateral for flash loan
- **Full exit to IDLE_MODE** (`withdrawAllCollateral=true`): Repay by shares (no dust), withdraw ALL collateral
- **Transition to LTV=0** (`withdrawAllCollateral=false`, full debt): Auto-detects full repayment, uses by-shares, keeps remaining collateral

## Flow: Deposit (Build Leverage)

> **Note:** Flash loan is only used when `targetLTV > 0` and `borrowAmount > 0`.
> - When `targetLTV = IDLE_MODE`: deposits stay as idle USDT (no flash loan)
> - When `targetLTV = 0`: deposits convert to sUSDD collateral directly (no flash loan)

```
User deposits USDT (when targetLTV > 0)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_DEPOSIT)    │
│   │                                         │
│   ▼                                         │
│ Total USDT = deposit + flash loan           │
│   │                                         │
│   ▼                                         │
│ Swap all USDT → sUSDD (via PSM + stake)     │
│   │                                         │
│   ▼                                         │
│ Supply sUSDD as collateral to Morpho        │
│   │                                         │
│   ▼                                         │
│ Borrow USDT against collateral              │
│   │                                         │
│   ▼                                         │
│ Repay flash loan with borrowed USDT         │
└─────────────────────────────────────────────┘
    │
    ▼
Result: Leveraged sUSDD position
```

## Flow: Withdraw (Unwind Leverage)

> **Note:** Only `redeem(shares)` is supported. `withdraw(assets)` is disabled (see ADR-005).

```
User calls redeem(shares)
    │
    ▼
Calculate withdrawal ratio = shares / totalSupply
    │
    ▼
┌─────────────────────────────────────────────┐
│ Proportionally calculate:                   │
│   - idleToWithdraw = idle * ratio           │
│   - sharesToRepay = borrowShares * ratio    │
│   - collateralToWithdraw = collateral * ratio│
└─────────────────────────────────────────────┘
    │
    ▼ (if sharesToRepay > 0 AND collateralToWithdraw > 0)
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_WITHDRAW)   │
│   │                                         │
│   ▼                                         │
│ Repay debt by shares (exact, no dust)       │
│   │                                         │
│   ▼                                         │
│ Withdraw proportional sUSDD collateral      │
│   │                                         │
│   ▼                                         │
│ Swap sUSDD → USDT (via unstake + PSM)       │
│   │                                         │
│   ▼                                         │
│ Repay flash loan from swap proceeds         │
└─────────────────────────────────────────────┘
    │
    ▼
Transfer USDT to user (idleToWithdraw + unwind proceeds)
```

**Proportional Fairness:** Both idle USDT and position are withdrawn in the same ratio. This ensures all users pay similar gas/fees regardless of withdrawal order. See "Proportional Withdrawal" section below for details.

**Micro-redemption Edge Cases:** Position unwind is skipped when:
- `sharesToRepay > 0` but `collateralToWithdraw == 0` (can't repay flash loan)
- `sharesToRepay == 0` but debt exists (protects remaining LTV)

In these cases, user receives only their idle USDT portion. If no debt exists (`borrowShares == 0`), collateral withdrawal proceeds normally.

## Flow: Rebalance (Lever Up)

```
Keeper calls rebalance(higherLTV)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_LEVER_UP)   │
│   │                                         │
│   ▼                                         │
│ Swap all USDT → sUSDD (flash loan + idle)   │
│   │                                         │
│   ▼                                         │
│ Supply sUSDD as additional collateral       │
│   │                                         │
│   ▼                                         │
│ Borrow USDT to repay flash loan             │
└─────────────────────────────────────────────┘
```

> **Note:** Lever up also deploys any idle USDT into the position.

## Flow: Rebalance (Delever)

```
Keeper calls rebalance(lowerLTV) where lowerLTV > 0
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_DELEVER)    │
│   │                                         │
│   ▼                                         │
│ Repay portion of USDT debt                  │
│   │                                         │
│   ▼                                         │
│ Calculate sUSDD needed for flash loan repay │
│ (using previewSUSDDNeededForUSDT + buffer)  │
│   │                                         │
│   ▼                                         │
│ Withdraw sUSDD collateral                   │
│   │                                         │
│   ▼                                         │
│ Swap sUSDD → USDT                           │
│   │                                         │
│   ▼                                         │
│ Repay flash loan                            │
└─────────────────────────────────────────────┘
```

## Flow: Transition to Unleveraged (LTV = 0)

```
Keeper calls rebalance(0)
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_DELEVER, keepCollateral)│
│   │                                                     │
│   ▼                                                     │
│ Auto-detect full debt → repay by shares (no dust)       │
│   │                                                     │
│   ▼                                                     │
│ Calculate sUSDD needed for flash loan repay + buffer    │
│   │                                                     │
│   ▼                                                     │
│ Withdraw only that sUSDD (keep rest as collateral)      │
│   │                                                     │
│   ▼                                                     │
│ Swap sUSDD → USDT                                       │
│   │                                                     │
│   ▼                                                     │
│ Repay flash loan (excess becomes idle USDT)             │
└─────────────────────────────────────────────────────────┘
    │
    ▼
Convert any idle USDT to sUSDD collateral
```

**Result:** Position has sUSDD collateral, zero debt, earning sUSDD yield without leverage.

## Flow: Exit to IDLE_MODE

```
Keeper calls rebalance(IDLE_MODE)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_DELEVER)    │
│   │                                         │
│   ▼                                         │
│ Repay ALL debt by shares                    │
│   │                                         │
│   ▼                                         │
│ Withdraw ALL collateral                     │
│   │                                         │
│   ▼                                         │
│ Swap sUSDD → USDT                           │
│   │                                         │
│   ▼                                         │
│ Repay flash loan                            │
└─────────────────────────────────────────────┘
```

**Result:** All assets converted to idle USDT, no position in Morpho.

## Flash Loan Mechanics

### Morpho Flash Loan Flow

```solidity
// Morpho.sol
function flashLoan(address token, uint256 assets, bytes calldata data) external {
    IERC20(token).safeTransfer(msg.sender, assets);           // 1. Send tokens
    IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);  // 2. Callback
    IERC20(token).safeTransferFrom(msg.sender, address(this), assets);     // 3. Pull back
}
```

**Key point:** Morpho uses `safeTransferFrom` to reclaim tokens, which **requires approval**.

### Approval Strategy

The vault sets infinite approval in `initialize()`:

```solidity
// In initialize()
IERC20(Constants.USDT).forceApprove(Constants.MORPHO, type(uint256).max);
IERC20(Constants.SUSDD).forceApprove(Constants.MORPHO, type(uint256).max);
```

**Important:** Do NOT call `forceApprove` in callbacks — it would overwrite infinite approval with a smaller amount, causing subsequent operations to fail.

### Why Unlimited Approval is Safe for Morpho Blue

| Factor | Morpho Blue |
|--------|-------------|
| Upgradeable? | ❌ No — immutable singleton contract |
| Admin functions? | ❌ No owner, no governance, no admin keys |
| When tokens are pulled | Only on explicit calls: `repay()`, `supplyCollateral()`, flash loan callback |
| Audits | Multiple (Spearbit, Trail of Bits, etc.) |
| TVL | $2B+ — battle-tested |

**Key points:**

1. Morpho Blue is **immutable** — no proxy, no upgrade path, no way to change contract logic
2. Morpho **only pulls exact amounts** requested in each operation (never more)
3. Per-operation approval would cost +25-45k gas per operation
4. For flash loans, approval must exist BEFORE callback (can't approve exact amount inside callback)

**When NOT to use unlimited approval:**
- Upgradeable proxy contracts
- Contracts with owner/admin that could be compromised
- New/unaudited protocols

---

## Rationale

1. **No intermediate state** - Position never exists in partial/risky state.

2. **Gas efficient** - Single transaction vs multiple.

3. **Zero flash loan fee** - Morpho Blue provides free flash loans.

4. **Standard pattern** - Flash loans for atomic leverage is well-established.

5. **Idle balance optimization** - Minimizes unnecessary position changes.

## Key Calculations

**Deposit leverage:**
```
borrowAmount = depositedUsdt * targetLTV / (1 - targetLTV)
```

**Example (75% LTV = 4x leverage):**
- 1000 USDT deposit needs 3000 USDT flash loan
- Total 4000 USDT converts to ~4000 sUSDD collateral
- Borrow 3000 USDT to repay flash loan
- Net equity: 1000 USDT, Collateral: ~4000, Debt: 3000

**Withdrawal proportional amounts:**
```
withdrawRatio = shares / totalSupply  (shares-based, no NAV needed)

// Proportional from idle
idleToWithdraw = idleUsdt * withdrawRatio

// Proportional from position
collateralToWithdraw = totalCollateral * withdrawRatio
sharesToRepay = totalBorrowShares * withdrawRatio
```

Note: We use shares ratio (not NAV ratio) because it's mathematically equivalent but simpler and cheaper (no `totalAssets()` call needed).

## Withdraw Algorithm Details

### Shares-Based Approach

Withdrawal uses **shares-based ratio** for all calculations:

```solidity
uint256 withdrawRatio = (shares * WAD) / totalSupply();

// Apply ratio to idle and position
uint256 idleToWithdraw = (idleUsdt * withdrawRatio) / WAD;
uint256 sharesToRepay = (pos.borrowShares * withdrawRatio) / WAD;
uint256 collateralToWithdraw = (pos.collateral * withdrawRatio) / WAD;
```

**Why shares-based?**
- `shares / totalSupply == assets / NAV` (mathematically equivalent)
- No expensive `totalAssets()` call needed
- Simpler code, fewer edge cases

### Debt Repayment Strategy

**Always repay by shares** — both full and partial withdrawals:

```solidity
morpho.repay(marketParams, 0, sharesToRepay, address(this), "");
```

| Scenario | sharesToRepay | Result |
|----------|---------------|--------|
| Full withdraw (100%) | `pos.borrowShares` | All debt cleared |
| Partial withdraw (X%) | `pos.borrowShares * X%` | Proportional debt reduction |

**Why always shares?** Shares-based repay is exact — no rounding issues that can leave micro-debt.

### Proportional Withdrawal (Fairness First)

The vault uses **proportional withdrawal** — both idle USDT and position are withdrawn in the same ratio:

```
redeem(300 shares) when totalSupply=1000, idle=100 USDT, position equity=900 USDT:
├── ratio = 300/1000 = 30%
├── idleToWithdraw: 100 * 30% = 30 USDT
├── collateralToWithdraw: collateral * 30%
├── sharesToRepay: borrowShares * 30%
└── User receives: idleToWithdraw + (collateral_value - debt_repaid)
```

**Why proportional?**

| Approach | Early Withdrawer | Late Withdrawer |
|----------|-----------------|-----------------|
| Idle-first | Cheap (just transfer) | Expensive (full unwind) |
| **Proportional** | **Same cost** | **Same cost** |

**Trade-off accepted:** Every withdrawal touches the Morpho position (more gas), but this ensures fairness — all users pay similar costs regardless of withdrawal order.

**Example: Bank run scenario**
```
Vault: 1000 shares, idle=500 USDT, position=500 USDT equity

With idle-first:
├── User A (500 shares) withdraws first → gets 500 from idle (cheap)
└── User B (500 shares) withdraws second → must unwind entire position (expensive)

With proportional:
├── User A (500 shares) → 250 idle + 250 from position
└── User B (500 shares) → 250 idle + 250 from position
Both pay the same! ✓
```

### Actual Transfer Amount

The vault transfers what was **actually received**, not a pre-calculated estimate:

```solidity
uint256 balanceBefore = USDT.balanceOf(this);
// ... unwind position via flash loan ...
uint256 balanceAfter = USDT.balanceOf(this);

uint256 gainFromPosition = balanceAfter - balanceBefore;
uint256 toTransfer = idleToWithdraw + gainFromPosition;
USDT.safeTransfer(receiver, toTransfer);
```

This approach:
- Returns the real amount to user (no estimates)
- Naturally handles rounding in the user's favor (equity margin covers rounding)
- Simpler code with fewer failure modes

---

## Delever Algorithm Details

> **Note:** Delever uses a 0.1% buffer, but **withdrawal does not**. Withdrawal is purely proportional — the equity margin naturally covers any rounding.

### Unified OP_DELEVER with Auto-Detection

All delever scenarios use a single `OP_DELEVER` operation with two parameters:
- `flashLoanAmount`: Amount of USDT to flash loan (equals debt to repay)
- `withdrawAllCollateral`: Whether to withdraw ALL collateral (true) or just enough for flash loan (false)

**Repayment strategy is auto-detected:**
```solidity
bool repayingAllDebt = flashLoanAmount >= actualDebt;
if (repayingAllDebt) {
    // Full repayment: use by-shares (no dust)
    morpho.repay(marketParams, 0, pos.borrowShares, address(this), "");
} else {
    // Partial repayment: use by-assets
    morpho.repay(marketParams, flashLoanAmount, 0, address(this), "");
}
```

### Partial Delever (rebalance to lower LTV)

Parameters: `OP_DELEVER, withdrawAllCollateral=false`

1. Flash loan the amount of debt to repay
2. Auto-detect partial → repay by assets
3. Calculate collateral needed: `previewSUSDDNeededForUSDT(flashLoanAmount)`
4. Add 0.1% buffer for rounding (see `DELEVER_BUFFER_BPS`)
5. Withdraw and convert collateral to repay flash loan

This may leave small amounts of excess USDT as idle balance.

### Full Delever (rebalance(IDLE_MODE))

Parameters: `OP_DELEVER, withdrawAllCollateral=true`

1. Flash loan the ENTIRE debt amount
2. Auto-detect full → repay by shares (no dust)
3. Withdraw ALL remaining collateral
4. Convert all collateral to USDT
5. Repay flash loan, remainder becomes idle USDT

### Transition to Unleveraged (rebalance(0))

Parameters: `OP_DELEVER, withdrawAllCollateral=false`

1. Flash loan the ENTIRE debt amount
2. Auto-detect full → repay by shares (no dust)
3. Withdraw only enough collateral to repay flash loan + buffer
4. Keep remaining collateral as unleveraged sUSDD
5. Convert any idle USDT to sUSDD collateral (done after flash loan)

### Edge Case: Underwater Position

If underwater (`currentDebt > 0 && NAV == 0`), `rebalance()` is a true no-op — delevering is impossible without external capital.

See [requirements.md](../requirements.md#underwater-behavior-for-rebalance) for full underwater behavior and recovery options.
