# Dip-Buy Pressure Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rezimx-btc/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rezimx-btc/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win"
bounty. It trades 10 SOL of paper money on a 6-hour replay of real pump.fun
bonding-curve activity. Highest net PnL wins.

## Strategy

Fresh curves rush, dip, and either get bought back up or fade. This bot buys
only the dip — price at least 10% below its peak since creation — and only
when the recent tape shows buyers returning (buy SOL at least 4× sell SOL
over the last 8 trades). One 0.15 SOL shot per mint, at most 5 open
positions. Exits are whole positions: take-profit +25%, hard stop −6%,
fade exit when sellers retake the tape while in profit, and a stale/max-hold
exit so slots recycle fast. See [STRATEGY.md](STRATEGY.md) for the full
rules table.

## Run it

```sh
node main.ts < replay.ndjson
```

The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout: it reads
a `hello` message, then one `batch` per slot (each with a `seq`, a `slot`,
events, marks, fills, and the account), and answers every batch with exactly
one reply echoing its `seq` and carrying its `orders`. No dependencies, no
network, no clock, no randomness — deterministic, so the harness's two
executions produce identical action logs. Requires Node 22.18+ (the grader
runs Node 22.23.4).

---

<sub>Entered on [make.fun](https://make.fun/?ref=rezimx-btc&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
