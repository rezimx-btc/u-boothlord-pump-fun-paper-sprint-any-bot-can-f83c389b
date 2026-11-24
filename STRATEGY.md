# Strategy — Dip-Buy Pressure Bot

Fresh pump.fun curves rush up on their first wave of buyers, dip as early
flippers take profits, and then either get bought back up by the crowd or
fade into nothing. This bot only buys the dip, and only when the tape
already shows buyers stepping back in — it never chases a green candle and
never holds a dead coin.

## Rules

| Rule | Value |
| --- | --- |
| Entry trigger | Price ≥ 10% below its peak since creation (dip) |
| Entry confirmation | Buy SOL ≥ 4× sell SOL over the last 8 trades, with ≥ 4 buys in that window |
| Curve age at entry | Created within the last 400 slots, ≥ 6 trades of tape seen |
| Position size | 0.15 SOL target, capped at 80% of the 1%-of-real-reserves size cap, floored at 0.015 SOL |
| Real-reserve floor | Skip curves with < 1.5 SOL real reserves (size cap would be too small) |
| One shot per mint | A mint is bought at most once per run (drives the 20-distinct-mint guardrail) |
| Max open positions | 5 (from hello caps); at most 2 new buys per batch |
| Take-profit | Whole-position sell at +25% vs cost basis |
| Hard stop | Whole-position sell at −6% vs cost basis |
| Fade exit | Sellers retake the tape (sell SOL > buy SOL) while up ≥ +5% → sell |
| Stale exit | Held ≥ 450 slots and at breakeven or better → sell |
| Max hold | Held ≥ 900 slots → sell regardless of PnL |
| Slippage | 500 bps (5%) on every order |
| Rejection cooldown | 50 slots after a rejected buy before retrying that mint |
| Determinism | Slot numbers are the only clock; no clock, randomness, env reads, or I/O |

## Why the numbers work

A 0.15 SOL round trip pays about 1.25% curve fees each way plus 0.000105 SOL
of tx fees per order — roughly 2.7% of the position in total. The +25%
take-profit and −6% hard stop are both far outside that fee band, so fees
cannot eat the edge. Tuning history on the reference kit's dev window
(128,058 events): v1 (dip 4%, pressure 2×, TP +30%, stop −15%) lost −2.23
SOL at a 30.9% win rate — stops gapped through on crashing fresh coins, so
losers ran far past −15% before the 2-slot-latency fill landed. v2 (dip 6%,
pressure 3×, TP +20%, stop −8%) improved to ≈ −1.21 SOL with a 13.7% max
drawdown. v3 tightens further (dip 10%, pressure 4×, TP +25%, stop −6%,
shorter holds): more selectivity kept improving net PnL, so the bot only
takes the deepest dips with the clearest buyer return. A v4 probe (dip 12%,
pressure 5×, stop −5%) went the other way — −0.44 SOL, 25.5% win rate — so
v3's numbers are the ones shipped. The dev window is a different 24h slice
from the 6h final window, so these numbers are a direction, not a forecast. Exits are always whole positions from the account's
authoritative token balance, so no dust is left behind. The 6-hour final
window rewards turnover across many coins, which is why the bot takes one
small shot per mint and recycles its 5 position slots quickly instead of
concentrating on a few names.
