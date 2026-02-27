# ADR-005: Limited ERC4626 Interface

## Question
Should we support all ERC4626 functions (deposit, mint, withdraw, redeem)?

## Decision
**Support only `deposit()` and `redeem()`.** The `mint()` and `withdraw()` functions revert.

## Supported Operations

| Function | Supported | User specifies | User receives |
|----------|-----------|----------------|---------------|
| `deposit(assets)` | ✅ | USDT amount | shares (calculated via Delta NAV) |
| `redeem(shares)` | ✅ | shares to burn | USDT (proportional) |
| `mint(shares)` | ❌ reverts | - | - |
| `withdraw(assets)` | ❌ reverts | - | - |

## Rationale

### Why not `mint()`?

Delta NAV calculates shares based on **actual** NAV change after position is built:

```
navBefore = totalAssets()
// ... build position ...
navAfter = totalAssets()
shares = (navAfter - navBefore) * supplyBefore / navBefore
```

The user cannot know exact shares in advance because:
1. sUSDD rate may change between preview and execution
2. PSM fees could be enabled
3. Position building is non-trivial (flash loan → swap → supply → borrow)

If we allowed `mint(100 shares)`, user might get 99 or 101 — violating ERC4626 semantics.

### Why not `withdraw()`?

Proportional withdrawal withdraws from both idle USDT and position:

```
ratio = usdtToWithdraw / NAV
idleToWithdraw = idle * ratio
positionToUnwind = position * ratio
```

To fulfill `withdraw(100 USDT)`:
- We don't know exact sUSDD→USDT conversion until execution
- Rounding in Morpho repay affects final amounts
- User could receive slightly more or less than requested

If we allowed `withdraw(100 USDT)`, user might get 99.5 or 100.5 — violating ERC4626 semantics.

### Why `deposit()` and `redeem()` work fine?

| Function | Behavior | Why it works |
|----------|----------|--------------|
| `deposit(assets)` | "Give me X USDT, I'll give you proportional shares" | User accepts whatever shares Delta NAV calculates |
| `redeem(shares)` | "Burn X shares, I'll give you proportional USDT" | User accepts whatever USDT proportional withdrawal yields |

These are "input-specified" operations where the output can vary slightly.

## Trade-offs

### Cons
- Not 100% ERC4626 compliant
- Some integrations/aggregators may expect full interface
- Less flexibility for users wanting exact share amounts

### Pros
- Honest behavior — no surprises
- Simpler code — no complex edge case handling
- Clear semantics — deposit=assets, redeem=shares
- Better than silently returning wrong amounts

## Implementation

```solidity
function mint(uint256, address) public pure override returns (uint256) {
    revert NotSupported();
}

function withdraw(uint256, address, address) public pure override returns (uint256) {
    revert NotSupported();
}

function maxMint(address) public pure override returns (uint256) {
    return 0; // Signals mint not supported
}

function maxWithdraw(address) public pure override returns (uint256) {
    return 0; // Signals withdraw not supported
}

function previewMint(uint256) public pure override returns (uint256) {
    return 0;
}

function previewWithdraw(uint256) public pure override returns (uint256) {
    return 0;
}
```

## Alternatives Considered

### 1. Implement mint/withdraw with slippage tolerance
Complexity: High. Would need `mintWithMin`, `withdrawWithMax` variants.
Rejected: Over-engineering for rarely used functions.

### 2. Make mint/withdraw approximate
Risk: Silent failures, user confusion, potential exploits.
Rejected: Worse than explicit revert.

### 3. Full ERC4626 with disclaimers
Risk: Integrations may not read disclaimers.
Rejected: Code should enforce semantics, not docs.

## References

- [EIP-4626](https://eips.ethereum.org/EIPS/eip-4626) - Tokenized Vault Standard
- ADR-003: Share Calculation (Delta NAV)
- ADR-004: Atomic Leverage (Proportional Withdrawal)
