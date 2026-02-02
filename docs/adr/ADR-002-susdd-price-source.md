# ADR-002: sUSDD Price Source

## Question
Where do we get the sUSDD price for NAV calculation?

## Decision
**Use sUSDD ERC4626 rate** via `convertToAssets()`.

## Swap Path

USDT ↔ sUSDD requires two steps:

```
USDT ↔ USDD ↔ sUSDD
     PSM    ERC4626
```

### Step 1: PSM (USDT ↔ USDD)

Contract: `0xcE355440c00014A229bbEc030A2B8f8EB45a2897`
USDD Token: `0x4f8e5de400de08b164e7421b3ee387f461becd1a`

| Direction | Function | Rate |
|-----------|----------|------|
| USDT → USDD | `sellGem(address usr, uint256 gemAmt)` | 1:1 |
| USDD → USDT | `buyGem(address usr, uint256 gemAmt)` | 1:1 |

### Step 2: sUSDD (USDD ↔ sUSDD)

Contract: `0xc5d6a7b61d18afa11435a889557b068bb9f29930` (ERC4626)

| Direction | Function |
|-----------|----------|
| USDD → sUSDD | `deposit(uint256 assets, address receiver)` |
| sUSDD → USDD | `redeem(uint256 shares, address receiver, address owner)` |
| Rate query | `convertToAssets(uint256 shares)` |

## NAV Price Calculation

```
sUSDD_in_USDT = sUSDD_amount * sUSDD.convertToAssets(1e18) / 1e18
```

Since PSM is 1:1, USDD value equals USDT value.

## Rationale

1. **Authoritative source** - sUSDD contract defines the actual conversion rate.

2. **No oracle risk** - No external oracle dependency.

3. **Consistency** - Same rate for NAV and actual swaps.

## Implementation

Create `SwapHelper` library to encapsulate:
- `swapUSDTtoSUSDD(uint256 usdtAmount)` - full path swap
- `swapSUSDDtoUSDT(uint256 susddAmount)` - full path swap
- `getSUSDDRate()` - returns USDD per 1 sUSDD
- `getUSDTValue(uint256 susddAmount)` - for NAV calculation
