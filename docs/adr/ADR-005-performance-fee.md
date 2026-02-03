# ADR-005: Performance Fee

## Question
How do we accrue and calculate performance fees?

## Decision
**High-water mark with virtual shares** - mint fee shares on explicit harvest when NAV exceeds previous high.

## Mechanism

1. Track `highWaterMark` (highest NAV per share achieved)
2. Manager calls `harvestFees()` to realize fees:
   - If current NAV/share > highWaterMark:
     - Calculate profit = (currentNAV/share - highWaterMark) × totalSupply
     - Fee = profit × performanceFeeBps / 10000
     - Mint new shares to feeRecipient worth `fee` amount
     - Update highWaterMark = currentNAV/share

## Harvest Trigger

Fees are **only** collected via explicit `harvestFees()` call by Manager role. This is intentional:
- Saves gas on user deposit/withdraw operations
- Allows Manager to choose optimal timing
- Prevents MEV/sandwich attacks around fee collection

## Fee Calculation Formula

```solidity
// Current value per share (WAD precision)
currentValuePerShare = totalAssets() * 1e18 / totalSupply()

// Profit per share above high water mark
profitPerShare = currentValuePerShare - highWaterMark

// Fee per share
feePerShare = profitPerShare * performanceFeeBps / 10000

// Shares to mint to feeRecipient
feeShares = totalSupply * feePerShare / (currentValuePerShare - feePerShare)
```

## Rationale

1. **Fair to users** - Only charge fees on actual gains above previous peak.

2. **No double-charging** - High-water mark prevents charging fees on recovery from losses.

3. **Standard pattern** - Used by most sophisticated vaults (Yearn v3, etc.).

4. **Share dilution** - Minting shares is cleaner than transferring assets; doesn't require liquidity.

5. **Gas optimization** - Not charging on every user action saves significant gas.

## Example

- High-water mark: 1.00 USDT/share
- Current NAV/share: 1.10 USDT/share
- Total supply: 1000 shares
- Performance fee: 10% (1000 bps)

```
Profit = (1.10 - 1.00) × 1000 = 100 USDT
Fee = 100 × 10% = 10 USDT
Shares minted = 1000 × 0.01 / (1.10 - 0.01) = ~9.17 shares to feeRecipient
New high-water mark: 1.10 USDT/share
```

## Configuration

| Parameter | Description | Constraints |
|-----------|-------------|-------------|
| `performanceFeeBps` | Fee rate in basis points | Max 3000 (30%) |
| `feeRecipient` | Address receiving fee shares | Non-zero address |
| `highWaterMark` | NAV/share threshold | Initialized to 1e18 |
