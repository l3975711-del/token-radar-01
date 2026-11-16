# Token Radar — radar-2

A token launch radar for make.fun's `token-radar-01` bounty. The program (`main.ts`,
Node 22, standard library only) reads the sealed snapshot at `/input/snapshot.json` and
writes the ranked board to `/output/board.json`, the dashboard data to `/output/data.js`,
and copies `dashboard/` and `screenshots/` to `/output`, plus `/output/dossier.json`
via `vendor/makefun-board.ts`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

## The model (radar-2)

Implied value is computed from the snapshot's own figures only — TVL, seven-day growth,
age with no token, chain count, and a value multiple measured from the snapshot itself:

```
implied = round(tvl_usd × categoryMultiple × growthMult × maturityMult × breadthMult)
```

- **categoryMultiple**: the median market-cap-to-TVL ratio of this snapshot's live-token
  protocols, per category where at least 4 live peers exist, shrunk toward the global
  median (prior weight 8) and clamped to [0.05, 0.80]. Too few peers → the global median
  (0.2138 on this snapshot). No protocol name is special-cased.
- **growthMult**: `1 + clamp(change_7d, -50, 100) / 100 × 0.45`.
- **maturityMult**: `0.60 + min(age_days, 1095) / 1095 × 0.40` (unknown age: 365 days).
- **breadthMult**: `1 + 0.02 × min(chains − 1, 5)`.

## The board

198 rows: all 40 watchlist protocols, plus every other pre-token protocol the snapshot
can rank. Wrapped, staked and bridged products are set aside using the watchlist's own
exclusion rule (Bridge / Canonical Bridge / Liquid Staking / Liquid Restaking / Restaked
BTC / CEX categories, wrapped/staked/staking in the name, exchange-prefixed names,
version markers) — the starter ranked wrapped Bitcoin and staked ETH at the top, which
will never launch a token of their own. Live-token protocols are shown separately with
their market caps. Each row carries an 8-step farm plan (action, cost, time), derived
from the protocol's category, chains, TVL and age.

## Screenshots

The three screenshots in `screenshots/` were rendered from the finished dashboard in a
headless Chromium via the DevTools protocol (the `--screenshot` flag of the local
Chromium build produces no file, so CDP `Page.captureScreenshot` was used instead):
`1-board.png` is the board, `2-detail.png` a protocol's detail view, `3-filtered.png`
a filtered view. They are re-rendered from the current dashboard, not the starter's.

## What this is not

Implied value is this entry's model, not a price and not a prediction that a token will
be issued. "No token" means the snapshot records none; a protocol may have a token its
DefiLlama record does not carry.
