// Dip-Buy Pressure Bot — Pump.fun Paper Sprint (pumpfun-replay/v2)
//
// Idea: fresh pump.fun curves overshoot on their first rush, dip, and then get
// bought back up by the crowd. This bot buys ONLY that dip, and only when the
// tape shows buyers are already stepping back in. It never chases a green
// candle, never holds a dead coin, and exits whole positions fast.
//
// Wire protocol (agent-fun/replay/v2, NDJSON on stdin/stdout):
//   - The harness opens with one `hello` message: protocol, seed, capital,
//     caps (max 5 open positions, max 16 orders per batch, max order 100 bps
//     of real reserve), latency_slots (orders decided on the batch for slot s
//     fill at slot s + latency), and fees (5000 + 100000 lamports tx fee per
//     order, ~95 bps protocol + ~30 bps creator curve fees).
//   - Then one `batch` per slot: seq, slot, events (CreateEvent / TradeEvent /
//     CompleteEvent), marks (latest reserves), fills (how earlier orders
//     resolved), and the account (cash + positions).
//   - The bot answers every batch with exactly one reply on stdout echoing
//     the batch's seq: {"type":"reply","seq":N,"orders":[...]}. A buy order
//     carries quote_lamports; a sell order carries token_amount; both carry
//     max_slippage_bps. The vendor shim owns this wire: it reads hello,
//     keeps state current, calls onBatch once per batch, and writes the reply.
//   - A final `done` message ends the run; no reply is sent for it.
//   - The slot number is the only clock. Holding periods and curve age are
//     measured in slots, never in wall time. No Date, no Math.random, no env
//     reads, no I/O: the bot is deterministic, so the harness's two executions
//     produce byte-identical action logs. Diagnostics go to stderr only;
//     stdout carries protocol replies only.

import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- constants
// All amounts are lamports (1 SOL = 1_000_000_000 lamports). Prices are kept
// as scaled integers: price = virtual_quote_reserves * PRICE_SCALE /
// virtual_token_reserves, i.e. lamports per token, scaled by 1e9.
const LAMPORTS_PER_SOL = 1_000_000_000n;
const PRICE_SCALE = 1_000_000_000n;

// Sizing: target 0.15 SOL per buy, never below 0.015 SOL (above the 0.01 SOL
// round-trip minimum the guardrails count), never above 80% of the size cap
// the hello message implies (max_order_bps_of_real_reserve = 100 bps = 1% of
// real SOL reserves, so 80% of that cap keeps fills safely inside it even
// after the 2-slot latency moves reserves).
const TARGET_BUY_LAMPORTS = 150_000_000n; // 0.15 SOL
const MIN_BUY_LAMPORTS = 15_000_000n; // 0.015 SOL
const SIZE_CAP_USE_BPS = 80; // use at most 80% of the 1%-of-real-reserve cap
const MIN_REAL_SOL_LAMPORTS = 1_500_000_000n; // need >= 1.5 SOL real reserves

// Entry tape: a curve must be young, dipped off its peak, and show buyers
// returning before we touch it.
const MAX_CURVE_AGE_SLOTS = 400; // only curves created within the last 400 slots
const MIN_TRADES_TO_JUDGE = 6; // need at least 6 trades of tape first
const TAPE_WINDOW = 8; // judge buy pressure on the last 8 trades
const MIN_BUYS_IN_WINDOW = 4; // at least 4 of those 8 trades must be buys
const DIP_BPS = 1000; // price at least 10% below its peak since creation
const BUY_PRESSURE_NUM = 4; // buy SOL must be at least 4x sell SOL in window
const MAX_BUYS_PER_BATCH = 2; // at most 2 new buys per batch
const REJECT_COOLDOWN_SLOTS = 50; // pause after a rejected buy before retrying a mint
const SLIPPAGE_BPS = 500; // 5% max slippage on every order

// Exits: whole-position sells only, decided from the account's cost basis
// (cost_lamports / token_amount) against the current mark price.
const TAKE_PROFIT_BPS = 2500; // +25% vs cost basis
const HARD_STOP_BPS = 600; // -6% vs cost basis
const FADE_EXIT_MIN_PROFIT_BPS = 500; // fade exit only when up at least +5%
const STALE_HOLD_SLOTS = 450; // stale + breakeven-or-better -> sell
const MAX_HOLD_SLOTS = 900; // never hold longer than this, whatever the PnL

// ---------------------------------------------------------------- per-mint tape
interface Tape {
  createdSlot: number | null;
  peakPrice: bigint; // scaled price, highest seen since creation
  trades: number;
  // Ring of the last TAPE_WINDOW trades: buy SOL and sell SOL (lamports).
  buySol: bigint[];
  sellSol: bigint[];
  entrySlot: number | null; // slot our buy fill landed, for the stale rule
}

const tapes = new Map<string, Tape>();
// Mints we already bought once (filled). One shot per mint: this is what
// drives the distinct-mint count toward the 20-mint guardrail instead of
// re-trading the same few winners.
const tradedMints = new Set<string>();
// Cooldown after a rejected buy: the harness reports the rejection in a
// later batch's fills, and without a pause the bot would re-fire the same
// order on every batch until the fill lands. Keyed by mint, value is the
// slot before which no new buy may be sent for that mint.
const rejectCooldown = new Map<string, number>();

function tapeFor(mint: string): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: null, peakPrice: 0n, trades: 0, buySol: [], sellSol: [], entrySlot: null };
    tapes.set(mint, t);
  }
  return t;
}

function scaledPrice(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken <= 0n) return 0n;
  return (virtualQuote * PRICE_SCALE) / virtualToken;
}

function pushTrade(t: Tape, isBuy: boolean, solAmount: bigint): void {
  if (isBuy) {
    t.buySol.push(solAmount);
    t.sellSol.push(0n);
  } else {
    t.buySol.push(0n);
    t.sellSol.push(solAmount);
  }
  if (t.buySol.length > TAPE_WINDOW) {
    t.buySol.shift();
    t.sellSol.shift();
  }
  t.trades += 1;
}

function windowSums(t: Tape): { buy: bigint; sell: bigint; buys: number } {
  let buy = 0n;
  let sell = 0n;
  let buys = 0;
  for (let i = 0; i < t.buySol.length; i++) {
    buy += t.buySol[i];
    sell += t.sellSol[i];
    if (t.buySol[i] > 0n) buys += 1;
  }
  return { buy, sell, buys };
}

// ---------------------------------------------------------------- strategy
function decideBuys(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return orders;
  const freeCash = state.freeCashLamports();
  if (freeCash < MIN_BUY_LAMPORTS + state.txFeeLamports()) return orders;

  // Walk curves in first-seen order (deterministic): the oldest fresh dip
  // that qualifies gets the buy.
  for (const [mint, curve] of state.curves) {
    if (orders.length >= MAX_BUYS_PER_BATCH) break;
    if (curve.complete) continue;
    if (state.positions.has(mint)) continue;
    if (tradedMints.has(mint)) continue;
    if ([...state.pending.values()].some((p) => p.order.side === 'buy' && p.order.mint === mint)) continue;
    if (state.committedPositionCount() + orders.length >= state.hello.caps.max_open_positions) break;

    const t = tapes.get(mint);
    if (t === undefined) continue;
    if (t.createdSlot === null) continue;
    if (batch.slot - t.createdSlot > MAX_CURVE_AGE_SLOTS) continue;
    // Respect the post-rejection cooldown for this mint.
    const coolUntil = rejectCooldown.get(mint);
    if (coolUntil !== undefined && batch.slot < coolUntil) continue;
    if (t.trades < MIN_TRADES_TO_JUDGE) continue;

    const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0n || t.peakPrice <= 0n) continue;
    // Dip: current price at least DIP_BPS below the peak since creation.
    if (price * 10_000n > t.peakPrice * (10_000n - BigInt(DIP_BPS))) continue;

    // Buy pressure: buyers dominate the recent tape.
    const w = windowSums(t);
    if (w.buys < MIN_BUYS_IN_WINDOW) continue;
    if (w.buy < BigInt(BUY_PRESSURE_NUM) * w.sell) continue;

    // Size cap: the buys on one mint in one reply may spend at most
    // max_order_bps_of_real_reserve of its real SOL reserves.
    if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
    const cap = state.maxBuyLamports(mint);
    const capped = (cap * BigInt(SIZE_CAP_USE_BPS)) / 100n;
    let quote = TARGET_BUY_LAMPORTS < capped ? TARGET_BUY_LAMPORTS : capped;
    if (quote < MIN_BUY_LAMPORTS) continue;
    const affordable = freeCash - state.txFeeLamports();
    if (quote > affordable) quote = affordable;
    if (quote < MIN_BUY_LAMPORTS) continue;

    orders.push({ side: 'buy', mint, quote_lamports: quote, max_slippage_bps: SLIPPAGE_BPS });
    console.error(`slot ${batch.slot} BUY ${mint.slice(0, 8)} quote=${quote} price=${price} peak=${t.peakPrice} buySol=${w.buy} sellSol=${w.sell}`);
  }
  return orders;
}

function decideSells(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [mint, holding] of state.positions) {
    if ([...state.pending.values()].some((p) => p.order.side === 'sell' && p.order.mint === mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = scaledPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price <= 0n || holding.token_amount <= 0n) continue;
    // Entry price = cost basis per token (fees included).
    const entryPrice = (holding.cost_lamports * PRICE_SCALE) / holding.token_amount;
    if (entryPrice <= 0n) continue;
    // PnL in bps vs cost basis, signed.
    const pnlBps = ((price - entryPrice) * 10_000n) / entryPrice;

    const t = tapes.get(mint);
    const heldSlots = t !== null && t !== undefined && t.entrySlot !== null ? batch.slot - t.entrySlot : 0;

    let reason: string | null = null;
    if (pnlBps >= BigInt(TAKE_PROFIT_BPS)) reason = 'take-profit';
    else if (pnlBps <= -BigInt(HARD_STOP_BPS)) reason = 'hard-stop';
    else if (heldSlots >= MAX_HOLD_SLOTS) reason = 'max-hold';
    else if (heldSlots >= STALE_HOLD_SLOTS && pnlBps >= 0n) reason = 'stale';
    else if (pnlBps >= BigInt(FADE_EXIT_MIN_PROFIT_BPS) && t !== undefined) {
      // Fade: sellers take over the tape while we are still in profit — bank it.
      const w = windowSums(t);
      if (w.sell > w.buy && w.sell > 0n) reason = 'fade';
    }
    if (reason === null) continue;

    orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIPPAGE_BPS });
    console.error(`slot ${batch.slot} SELL ${mint.slice(0, 8)} reason=${reason} pnlBps=${pnlBps} held=${heldSlots}`);
  }
  return orders;
}

// ---------------------------------------------------------------- bot loop
await runBot({
  onHello(state) {
    console.error(
      `hello: capital=${state.hello.capital.lamports} maxPositions=${state.hello.caps.max_open_positions} ` +
        `maxOrdersPerBatch=${state.hello.caps.max_orders_per_batch} latencySlots=${state.hello.latency_slots} ` +
        `txFee=${state.txFeeLamports()}`,
    );
  },

  onBatch(state, batch) {
    // Fold this batch's events into the per-mint tapes BEFORE deciding.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeFor(e.mint);
        t.createdSlot = e.slot;
        const p = scaledPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (p > t.peakPrice) t.peakPrice = p;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint);
        pushTrade(t, e.is_buy, BigInt(e.sol_amount));
        const p = scaledPrice(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (p > t.peakPrice) t.peakPrice = p;
      }
    }
    // Record our buy fills: one shot per mint, and the entry slot for the
    // stale-hold rule. Fills arrive here because applyBatch ran first.
    // A rejected buy parks the mint for REJECT_COOLDOWN_SLOTS so a transient
    // rejection (cash, size cap, slippage) does not turn into a buy every
    // batch while the fill is still in flight.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        tradedMints.add(f.mint);
        const t = tapeFor(f.mint);
        if (t.entrySlot === null) t.entrySlot = f.slot;
      } else if (f.side === 'buy' && f.status === 'rejected') {
        rejectCooldown.set(f.mint, batch.slot + REJECT_COOLDOWN_SLOTS);
      }
    }

    // Sells first (free position slots), then buys. The reply echoes this
    // batch's seq and carries the orders; the shim validates and writes it.
    const orders: OrderInput[] = [...decideSells(state, batch), ...decideBuys(state, batch)];
    const cap = state.hello.caps.max_orders_per_batch;
    return orders.slice(0, cap);
  },
});
