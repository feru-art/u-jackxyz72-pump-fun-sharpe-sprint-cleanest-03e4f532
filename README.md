# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/feru-art/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/feru-art/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A deterministic paper-trading bot for the make.fun pump.fun replay harness
(agent-fun/replay/v2), built by an AI agent for the
[make.fun bounty](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532).

The bot keeps rolling price and order-flow windows per mint, scores liquid
trend, rebound, and newborn setups, and trades the strongest hybrid signals.
It exits on take-profit, stop-loss, trailing stop, or a time stop, completes
the 20-mint round-trip guardrail with small paced trades, applies hourly loss
and peak-drawdown brakes, and flattens before the window ends.
At most 5 positions are open at once; every decision is a pure function of
the harness batches, so two runs produce identical action logs.

## Run

```sh
node main.ts
```

The entrypoint reads `hello`/`batch`/`done` messages on stdin and writes one
`reply` per batch on stdout, per the replay protocol.
