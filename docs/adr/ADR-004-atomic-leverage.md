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
withdrawRatio = usdtToWithdraw / NAV

// Proportional from idle
idleToWithdraw = idleUsdt * withdrawRatio

// Proportional from position
collateralToWithdraw = totalCollateral * withdrawRatio
debtToRepay = totalDebt * withdrawRatio
```

Note: We use NAV as the denominator because we're withdrawing proportionally from ALL assets (both idle and position). This ensures fairness across all users.

## Withdraw Algorithm Details

### Full Withdraw Detection

Full position unwind happens only when ALL vault shares are burned:

```solidity
bool isFullWithdraw = (totalSupply() == 0);
```

This ensures:
- **Dust-free exit** for the last user — no micro-debt or collateral remains
- **Predictable behavior** — no magic percentage thresholds
- **Fairness** — other users' positions unaffected by large withdrawals

Previously used 99% threshold, but that caused unexpected full unwinds on large partial withdrawals.

### Debt Repayment Strategy

| Scenario | Method | Reason |
|----------|--------|--------|
| Full withdraw | `repay(0, borrowShares)` | Exact clearance, no dust |
| Partial withdraw | `repay(assets, 0)` | Proportional reduction |

**Why this matters:** Morpho rounds UP when converting assets→shares for repay. This can leave micro-debt on partial withdrawals. Full withdraw avoids this by specifying exact shares to burn.

```solidity
// Full withdraw — repay by shares (exact)
if (isFullWithdraw && pos.borrowShares > 0) {
    morpho.repay(marketParams, 0, pos.borrowShares, address(this), "");
}

// Partial withdraw — repay by assets
morpho.repay(marketParams, repayAmount, 0, address(this), "");
```

### Proportional Withdrawal (Fairness First)

The vault uses **proportional withdrawal** — both idle USDT and position are withdrawn in the same ratio:

```
withdraw(300 USDT) when NAV=1000, idle=100, position=900:
├── ratio = 300/1000 = 30%
├── idle: 100 * 30% = 30 USDT
└── position: 900 * 30% = 270 USDT (unwind)
```

**Why proportional?**

| Approach | Early Withdrawer | Late Withdrawer |
|----------|-----------------|-----------------|
| Idle-first | Cheap (just transfer) | Expensive (full unwind) |
| **Proportional** | **Same cost** | **Same cost** |

**Trade-off accepted:** Every withdrawal touches the Morpho position (more gas), but this ensures fairness — all users pay similar costs regardless of withdrawal order.

**Example: Bank run scenario**
```
Vault: idle=500, position=500, NAV=1000

With idle-first:
├── User A (50%) withdraws first → gets 500 from idle (cheap)
└── User B (50%) withdraws second → must unwind entire position (expensive)

With proportional:
├── User A (50%) → 250 idle + 250 from position
└── User B (50%) → 250 idle + 250 from position
Both pay the same! ✓
```

---

## Delever Algorithm Details

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
