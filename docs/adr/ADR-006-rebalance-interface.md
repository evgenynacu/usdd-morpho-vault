# ADR-006: Rebalance Interface

## Question
How does the keeper interact with the vault for rebalancing?

## Decision
**Simple lever/delever function** with target LTV parameter and safety guardrails.

## Interface

```solidity
function rebalance(uint256 newTargetLTV) external onlyRole(KEEPER_ROLE)
```

## Three Operating Modes

The vault supports three modes based on `newTargetLTV`:

| Mode | Value | Action | Result |
|------|-------|--------|--------|
| **IDLE_MODE** | `type(uint256).max` | Full exit | All assets as idle USDT |
| **Unleveraged** | `0` | Clear debt, keep collateral | sUSDD collateral, no debt |
| **Leveraged** | `1..MAX_LTV` | Adjust leverage | sUSDD collateral + USDT debt |

**Mode transitions:**
- `IDLE_MODE → 0`: Deploy idle USDT as sUSDD collateral
- `IDLE_MODE → leveraged`: Build leveraged position from idle USDT
- `0 → leveraged`: Add debt to existing collateral
- `leveraged → 0`: Repay all debt, keep remaining collateral
- `leveraged → IDLE_MODE`: Fully unwind, convert all to USDT
- `0 → IDLE_MODE`: Withdraw all collateral, convert to USDT

## LTV Validation

The vault enforces safety checks on target LTV (for leveraged mode only):

| Check | Constraint | Error |
|-------|------------|-------|
| Special modes | `IDLE_MODE` and `0` always valid | - |
| Absolute maximum | `newTargetLTV <= 0.915e18` (91.5%) | `InvalidLTV` |
| Market LLTV | `newTargetLTV < marketParams.lltv` | `LTVExceedsLLTV` |

**Why both checks for leveraged mode?**
- `MAX_LTV` is a conservative hard limit (91.5%)
- `marketParams.lltv` is the actual liquidation threshold from Morpho market
- Target must be below BOTH to ensure safety margin before liquidation

**Example:**
- Market LLTV: 86%
- MAX_LTV constant: 91.5%
- Valid targetLTV range: IDLE_MODE, 0, or 0.01% to 85.99% (limited by LLTV in this example)

## State Changes

```solidity
// 1. Check underwater FIRST (true no-op if underwater)
if (currentDebt > 0 && totalAssets() == 0) {
    return; // No state change, no events
}

// 2. Updates stored targetLTV
targetLTV = newTargetLTV;

// 3. Emits event
emit Rebalanced(oldLTV, newLTV);

// 4. Executes rebalance via flash loan
if (targetDebt > currentDebt) _leverUp(additionalDebt);
else if (targetDebt < currentDebt) _delever(debtToRepay, false);
```

## Idle USDT Handling

**All idle USDT is automatically deployed when transitioning out of IDLE_MODE.**

- `rebalance(0)`: Idle USDT → sUSDD collateral (unleveraged)
- `rebalance(LTV)`: Idle USDT + borrowed USDT → sUSDD collateral (leveraged)

**Formula:**
```solidity
targetDebt = NAV * newTargetLTV / (1 - newTargetLTV);
// During lever up, idle USDT is included in the collateral conversion
```

**Example: Re-lever after full exit**
1. Initial state: 4000 sUSDD collateral, 3000 USDT debt (75% LTV)
2. `rebalance(IDLE_MODE)` → All converted to ~1000 idle USDT
3. `rebalance(0.6e18)` → All 1000 USDT deployed into new position at 60% LTV

**When idle USDT exists (from delever buffer):**
- Partial delever buffer (0.1% / 10 bps) creates small idle amounts
- Next lever up automatically deploys this idle
- No manual intervention needed

## Rationale

1. **Single parameter** - Keeper specifies desired end state, vault figures out the steps.

2. **Atomic execution** - Uses same flash loan pattern as deposits/withdrawals.

3. **Multiple guardrails** - Both absolute and market-relative limits prevent risky positions.

4. **Simplicity** - No complex command arrays or multi-step orchestration needed.

## Keeper Responsibilities

1. Monitor sUSDD yield vs Morpho borrow rate
2. Monitor current LTV vs acceptable range
3. Call `rebalance()` when adjustment needed
4. Mode transition decisions:
   - `rebalance(0)` → When carry trade is unprofitable but sUSDD yield is still desired
   - `rebalance(IDLE_MODE)` → Emergency exit, full risk-off
5. Consider gas costs vs benefit of rebalancing

## Access Control

- Only addresses with `KEEPER_ROLE` can call `rebalance()`
- Multiple keepers can be granted the role via AccessControl
- Admin can grant/revoke keeper role as needed

## Rebalance Blocked When

- Vault is paused (`whenNotPaused` modifier)
- Would exceed MAX_LTV (91.5%)
- Would exceed market LLTV (liquidation threshold)
