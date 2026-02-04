# ADR-004: Atomic Leverage

## Question
How do we achieve leverage atomically in a single transaction?

## Decision
**Flash loan from Morpho Blue** (0% fee) to build/unwind leverage in one transaction.

## Flash Loan Operation Types

The vault uses three operation types in flash loan callbacks:

| Op Code | Name | Purpose |
|---------|------|---------|
| 1 | `OP_DEPOSIT` | Build leveraged position from user deposit |
| 2 | `OP_WITHDRAW` | Unwind position for user withdrawal |
| 3 | `OP_REBALANCE` | Adjust leverage (lever up or delever) |

## Flow: Deposit (Build Leverage)

> **Note:** Flash loan is only used when `targetLTV > 0` and `borrowAmount > 0`. When `targetLTV = 0`, deposits stay as idle USDT without flash loan.

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

```
User requests withdrawal (X USDT)
    │
    ▼
Calculate withdrawal ratio = X / NAV
    │
    ▼
┌─────────────────────────────────────────────┐
│ Proportionally withdraw:                    │
│   - idleToWithdraw = idle * ratio           │
│   - positionToUnwind = position * ratio     │
└─────────────────────────────────────────────┘
    │
    ▼ (if positionToUnwind > 0)
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_WITHDRAW)   │
│   │                                         │
│   ▼                                         │
│ Repay proportional USDT debt                │
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

## Flow: Rebalance (Lever Up)

```
Keeper calls rebalance(higherLTV)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_REBALANCE)  │
│   │                                         │
│   ▼                                         │
│ Swap USDT → sUSDD                           │
│   │                                         │
│   ▼                                         │
│ Supply sUSDD as additional collateral       │
│   │                                         │
│   ▼                                         │
│ Borrow USDT to repay flash loan             │
└─────────────────────────────────────────────┘
```

## Flow: Rebalance (Delever)

```
Keeper calls rebalance(lowerLTV)
    │
    ▼
┌─────────────────────────────────────────────┐
│ Flash loan USDT from Morpho (OP_REBALANCE)  │
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

The vault sets infinite approval in constructor:

```solidity
constructor(...) {
    IERC20(Constants.USDT).forceApprove(Constants.MORPHO, type(uint256).max);
    IERC20(Constants.SUSDD).forceApprove(Constants.MORPHO, type(uint256).max);
}
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

### Partial Delever (rebalance to lower LTV)

When reducing leverage but not fully exiting:

1. Flash loan the amount of debt to repay
2. Repay that debt to Morpho
3. Calculate collateral needed: `previewSUSDDNeededForUSDT(flashLoanAmount)`
4. Add 0.1% buffer for rounding: `collateral *= 10010 / 10000` (see `DELEVER_BUFFER_BPS`)
5. Withdraw and convert collateral to repay flash loan

This may leave small amounts of excess USDT as idle balance.

### Full Delever (rebalance(0))

When fully exiting the leveraged position:

1. Flash loan the ENTIRE debt amount
2. Repay all debt to Morpho
3. Withdraw ALL remaining collateral (not just enough for flash loan)
4. Convert all collateral to USDT
5. Repay flash loan, remainder becomes idle USDT

The key difference: partial delever withdraws only what's needed for the flash loan, while full delever withdraws everything.

### Edge Case: Underwater Position

If `totalAssets() == 0` (underwater: collateral value ≤ debt), `rebalance()` exits early:

```solidity
uint256 nav = totalAssets();
if (nav == 0) return;  // Cannot rebalance underwater position
```

**Why this is correct:**

| Scenario | Collateral | Debt | NAV | Can Delever? |
|----------|------------|------|-----|--------------|
| Healthy | 4000 USDT | 3000 USDT | 1000 USDT | ✅ Yes |
| Underwater | 2900 USDT | 3000 USDT | 0 | ❌ No |

Delevering requires: sell collateral → get USDT → repay debt.
If collateral < debt, there's not enough USDT to repay — delevering is impossible without external capital.

**What to do with underwater positions:**

1. **Wait for liquidation** — Morpho will liquidate when position crosses LLTV
2. **Capital injection** — Add USDT externally, then delever
3. **Accept the loss** — Users redeem what's available

This is not a bug — it's the correct behavior for an insolvent position.
