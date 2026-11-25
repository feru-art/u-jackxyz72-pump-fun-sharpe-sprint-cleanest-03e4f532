// Deterministic Sharpe-first bot for agent-fun/replay/v2.
// The bot reads only hello/batch payloads. It keeps rolling price and
// order-flow windows per mint, scores five entry styles, and exits with
// mode-specific take-profit, stop-loss, trailing, and time stops.

export interface Params {
  mode: "trend" | "rebound" | "newborn" | "meanrev" | "hybrid";
  baseSizeSol: number;
  maxConcurrent: number;
  maxBuysPerHour: number;
  takeProfit: number;
  stopLoss: number;
  trailStart: number;
  trailDrop: number;
  maxHoldSec: number;
  cooldownSec: number;
  completionSizeSol: number;
  hourLossStop: number;
  peakDrawdownHalt: number;
}

export const VERSIONS: Record<string, Params> = {
  V1: {
    mode: "trend", baseSizeSol: 0.09, maxConcurrent: 3, maxBuysPerHour: 5,
    takeProfit: 0.14, stopLoss: 0.07, trailStart: 0.08, trailDrop: 0.04,
    maxHoldSec: 900, cooldownSec: 900, completionSizeSol: 0.015,
    hourLossStop: 0.0025, peakDrawdownHalt: 0.02,
  },
  V2: {
    mode: "rebound", baseSizeSol: 0.08, maxConcurrent: 3, maxBuysPerHour: 6,
    takeProfit: 0.06, stopLoss: 0.04, trailStart: 0.035, trailDrop: 0.025,
    maxHoldSec: 360, cooldownSec: 600, completionSizeSol: 0.02,
    hourLossStop: 0.0015, peakDrawdownHalt: 0.018,
  },
  V3: {
    mode: "newborn", baseSizeSol: 0.06, maxConcurrent: 4, maxBuysPerHour: 8,
    takeProfit: 0.12, stopLoss: 0.06, trailStart: 0.06, trailDrop: 0.04,
    maxHoldSec: 240, cooldownSec: 900, completionSizeSol: 0.02,
    hourLossStop: 0.002, peakDrawdownHalt: 0.02,
  },
  V4: {
    mode: "meanrev", baseSizeSol: 0.1, maxConcurrent: 3, maxBuysPerHour: 6,
    takeProfit: 0.045, stopLoss: 0.035, trailStart: 0.03, trailDrop: 0.02,
    maxHoldSec: 300, cooldownSec: 600, completionSizeSol: 0.02,
    hourLossStop: 0.0012, peakDrawdownHalt: 0.015,
  },
  V5: {
    mode: "hybrid", baseSizeSol: 0.09, maxConcurrent: 3, maxBuysPerHour: 5,
    takeProfit: 0.14, stopLoss: 0.07, trailStart: 0.08, trailDrop: 0.04,
    maxHoldSec: 900, cooldownSec: 900, completionSizeSol: 0.015,
    hourLossStop: 0.0025, peakDrawdownHalt: 0.02,
  },
};

interface PricePoint { at: number; price: number }
interface FlowPoint { at: number; sol: number; buy: boolean; user: string }

interface MintState {
  price: number;
  firstPrice: number;
  firstAt: number;
  reserveSol: number;
  complete: boolean;
  trades: number;
  prices: PricePoint[];
  flow: FlowPoint[];
  lastExitAt: number;
  entries: number;
}

interface Position {
  tokens: bigint;
  costLamports: bigint;
  entryPrice: number;
  peakPrice: number;
  entryAt: number;
  mode: string;
  completion: boolean;
}

interface Features {
  ageSec: number;
  ret30: number;
  ret120: number;
  ret600: number;
  drawdown600: number;
  runup: number;
  buyShare: number;
  netFlow: number;
  buyers: number;
  trades: number;
  reserveSol: number;
}

const LAMPORTS = 1_000_000_000;
const MIN_ROUND_TRIP_LAMPORTS = 10_000_000n;

export class SharpeBot {
  private p: Params;
  private cash = 0n;
  private maxOpen = 5;
  private maxOrders = 16;
  private orderCapBps = 100;
  private startAt = -1;
  private now = 0;
  private mints = new Map<string, MintState>();
  private positions = new Map<string, Position>();
  private pendingBuy = new Map<string, { mode: string; completion: boolean }>();
  private pendingSell = new Set<string>();
  private boughtLamports = new Map<string, bigint>();
  private roundTrips = new Set<string>();
  private orderSeq = 0;
  private buyTimes: number[] = [];
  private equityPeak = 0;
  private hourIndex = -1;
  private hourStartEquity = 0;
  private haltedUntil = -1;

  constructor(params: Params) {
    this.p = params;
  }

  onHello(msg: any): void {
    this.cash = BigInt(msg.capital.lamports);
    this.maxOpen = Number(msg.caps.max_open_positions ?? 5);
    this.maxOrders = Number(msg.caps.max_orders_per_batch ?? 16);
    this.orderCapBps = Number(msg.caps.max_order_bps_of_real_reserve ?? 100);
    this.equityPeak = Number(this.cash) / LAMPORTS;
    this.hourStartEquity = this.equityPeak;
  }

  private state(mint: string): MintState {
    let s = this.mints.get(mint);
    if (!s) {
      s = {
        price: 0, firstPrice: 0, firstAt: 0, reserveSol: 0, complete: false,
        trades: 0, prices: [], flow: [], lastExitAt: -1_000_000_000, entries: 0,
      };
      this.mints.set(mint, s);
    }
    return s;
  }

  private noteCurve(mint: string, virtualQuote: string, virtualToken: string, realQuote: string, at: number): void {
    const s = this.state(mint);
    const vt = Number(BigInt(virtualToken));
    if (vt > 0) {
      s.price = Number(BigInt(virtualQuote)) / vt;
      if (s.firstPrice === 0) s.firstPrice = s.price;
      if (at > 0) {
        const last = s.prices[s.prices.length - 1];
        if (!last || last.at !== at || last.price !== s.price) s.prices.push({ at, price: s.price });
        while (s.prices.length > 0 && at - s.prices[0].at > 1800) s.prices.shift();
      }
    }
    s.reserveSol = Number(BigInt(realQuote)) / LAMPORTS;
  }

  private equitySol(): number {
    let eq = Number(this.cash) / LAMPORTS;
    for (const [mint, pos] of this.positions) {
      const s = this.mints.get(mint);
      if (s && s.price > 0) eq += (Number(pos.tokens) * s.price) / LAMPORTS;
    }
    return eq;
  }

  private priceAgo(s: MintState, seconds: number): number {
    const target = this.now - seconds;
    let best = 0;
    for (const point of s.prices) {
      if (point.at <= target) best = point.price;
      else break;
    }
    return best;
  }

  private features(s: MintState): Features {
    const p30 = this.priceAgo(s, 30);
    const p120 = this.priceAgo(s, 120);
    const p600 = this.priceAgo(s, 600);
    let high600 = s.price;
    for (const point of s.prices) {
      if (this.now - point.at <= 600 && point.price > high600) high600 = point.price;
    }
    let buyVol = 0;
    let sellVol = 0;
    const buyers = new Set<string>();
    for (const f of s.flow) {
      if (this.now - f.at > 300) continue;
      if (f.buy) { buyVol += f.sol; buyers.add(f.user); }
      else sellVol += f.sol;
    }
    const vol = buyVol + sellVol;
    return {
      ageSec: s.firstAt > 0 ? this.now - s.firstAt : 0,
      ret30: p30 > 0 ? s.price / p30 - 1 : 0,
      ret120: p120 > 0 ? s.price / p120 - 1 : 0,
      ret600: p600 > 0 ? s.price / p600 - 1 : 0,
      drawdown600: high600 > 0 ? s.price / high600 - 1 : 0,
      runup: s.firstPrice > 0 ? s.price / s.firstPrice : 1,
      buyShare: vol > 0 ? buyVol / vol : 0,
      netFlow: buyVol - sellVol,
      buyers: buyers.size,
      trades: s.trades,
      reserveSol: s.reserveSol,
    };
  }

  private trendScore(f: Features): number {
    if (f.reserveSol < 25 || f.ageSec < 180 || f.trades < 16) return -1;
    if (f.ret120 < 0.05 || f.ret120 > 0.35 || f.ret30 < -0.01) return -1;
    if (f.buyShare < 0.7 || f.buyers < 6 || f.netFlow < 1.5) return -1;
    if (f.drawdown600 < -0.05 || f.runup > 8) return -1;
    return 2 + f.ret120 * 4 + f.buyShare + Math.min(f.netFlow, 5) * 0.08;
  }

  private reboundScore(f: Features): number {
    if (f.reserveSol < 12 || f.trades < 14) return -1;
    if (f.drawdown600 > -0.08 || f.drawdown600 < -0.32) return -1;
    if (f.ret30 < 0.008 || f.buyShare < 0.6 || f.buyers < 4 || f.netFlow < 0.3) return -1;
    return 2 + Math.abs(f.drawdown600) * 2 + f.ret30 * 5 + f.buyShare;
  }

  private newbornScore(f: Features): number {
    if (f.ageSec > 900 || f.reserveSol < 2.5 || f.trades < 12) return -1;
    if (f.buyShare < 0.65 || f.buyers < 7 || f.netFlow < 0.5) return -1;
    if (f.ret120 < 0.04 || f.ret120 > 0.65 || f.runup > 4) return -1;
    return 2 + f.ret120 * 2 + f.buyShare + Math.min(f.buyers, 15) * 0.05;
  }

  private meanrevScore(f: Features): number {
    if (f.reserveSol < 35 || f.trades < 20) return -1;
    if (f.ret600 > -0.02 || f.ret600 < -0.13) return -1;
    if (f.ret30 < 0 || f.buyShare < 0.55 || f.buyers < 5 || f.netFlow < 0.2) return -1;
    return 2 + Math.abs(f.ret600) * 3 + f.buyShare;
  }

  private scoreFor(mode: string, f: Features): number {
    if (mode === "trend") return this.trendScore(f);
    if (mode === "rebound") return this.reboundScore(f);
    if (mode === "newborn") return this.newbornScore(f);
    if (mode === "meanrev") return this.meanrevScore(f);
    return Math.max(this.trendScore(f), this.reboundScore(f), this.newbornScore(f));
  }

  private desiredRoundTrips(elapsed: number): number {
    if (elapsed < 3600) return 3;
    if (elapsed < 7200) return 7;
    if (elapsed < 10800) return 12;
    if (elapsed < 14400) return 17;
    if (elapsed < 18000) return 22;
    return 26;
  }

  onBatch(msg: any): any[] {
    const orders: any[] = [];

    for (const ev of msg.events ?? []) {
      const ts = Number(ev.timestamp ?? 0);
      if (ts > 0) {
        if (this.startAt < 0) this.startAt = ts;
        this.now = Math.max(this.now, ts);
      }
      if (ev.event === "TradeEvent") {
        const s = this.state(ev.mint);
        this.noteCurve(ev.mint, ev.virtual_quote_reserves, ev.virtual_token_reserves, ev.real_quote_reserves, ts);
        if (s.firstAt === 0) s.firstAt = ts;
        s.trades += 1;
        s.flow.push({ at: ts, sol: Number(BigInt(ev.sol_amount)) / LAMPORTS, buy: !!ev.is_buy, user: String(ev.user ?? "") });
        while (s.flow.length > 0 && ts - s.flow[0].at > 900) s.flow.shift();
      } else if (ev.event === "CreateEvent") {
        const s = this.state(ev.mint);
        this.noteCurve(ev.mint, ev.virtual_quote_reserves, ev.virtual_token_reserves, "0", ts);
        if (s.firstAt === 0) s.firstAt = ts;
      } else if (ev.event === "CompleteEvent") {
        this.state(ev.mint).complete = true;
      }
    }
    for (const mark of msg.marks ?? []) {
      this.noteCurve(mark.mint, mark.virtual_quote_reserves, mark.virtual_token_reserves, mark.real_quote_reserves, this.now);
    }

    this.cash = BigInt(msg.account.cash_lamports);
    const held = new Set<string>();
    for (const heldPos of msg.account.positions ?? []) {
      held.add(heldPos.mint);
      const tokens = BigInt(heldPos.token_amount);
      const cost = BigInt(heldPos.cost_lamports);
      const s = this.mints.get(heldPos.mint);
      const old = this.positions.get(heldPos.mint);
      if (!old) {
        const entryPrice = tokens > 0n ? Number(cost) / Number(tokens) : (s?.price ?? 0);
        const pending = this.pendingBuy.get(heldPos.mint);
        this.positions.set(heldPos.mint, {
          tokens, costLamports: cost, entryPrice,
          peakPrice: Math.max(entryPrice, s?.price ?? 0), entryAt: this.now,
          mode: pending?.mode ?? this.p.mode, completion: pending?.completion ?? false,
        });
        const prev = this.boughtLamports.get(heldPos.mint) ?? 0n;
        if (cost > prev) this.boughtLamports.set(heldPos.mint, cost);
      } else {
        old.tokens = tokens;
        old.costLamports = cost;
        if (s && s.price > old.peakPrice) old.peakPrice = s.price;
      }
    }
    for (const mint of [...this.positions.keys()]) {
      if (!held.has(mint)) {
        this.positions.delete(mint);
        this.state(mint).lastExitAt = this.now;
        if ((this.boughtLamports.get(mint) ?? 0n) >= MIN_ROUND_TRIP_LAMPORTS) this.roundTrips.add(mint);
      }
    }
    for (const fill of msg.fills ?? []) {
      if (fill.side === "buy") this.pendingBuy.delete(fill.mint);
      if (fill.side === "sell") this.pendingSell.delete(fill.mint);
    }

    const elapsed = this.startAt >= 0 ? this.now - this.startAt : 0;
    const equity = this.equitySol();
    if (equity > this.equityPeak) this.equityPeak = equity;
    const currentHour = Math.floor(elapsed / 3600);
    if (currentHour !== this.hourIndex) {
      this.hourIndex = currentHour;
      this.hourStartEquity = equity;
    }
    const hourReturn = this.hourStartEquity > 0 ? equity / this.hourStartEquity - 1 : 0;
    const peakDrawdown = this.equityPeak > 0 ? 1 - equity / this.equityPeak : 0;
    if (peakDrawdown >= this.p.peakDrawdownHalt) this.haltedUntil = Math.max(this.haltedUntil, this.now + 1800);

    const flatten = elapsed >= 20700;
    for (const [mint, pos] of this.positions) {
      if (orders.length >= this.maxOrders) break;
      if (this.pendingSell.has(mint)) continue;
      const s = this.mints.get(mint);
      if (!s || s.price <= 0 || pos.entryPrice <= 0 || pos.tokens <= 0n) continue;
      const ret = s.price / pos.entryPrice - 1;
      const heldSec = this.now - pos.entryAt;
      const tp = pos.completion ? 0.05 : this.p.takeProfit;
      const sl = pos.completion ? 0.05 : this.p.stopLoss;
      const maxHold = pos.completion ? 300 : this.p.maxHoldSec;
      const trailHit = ret >= this.p.trailStart && s.price <= pos.peakPrice * (1 - this.p.trailDrop);
      if (flatten || s.complete || ret >= tp || ret <= -sl || trailHit || heldSec >= maxHold) {
        orders.push({
          side: "sell", client_id: `s${this.orderSeq++}`, mint,
          token_amount: pos.tokens.toString(), max_slippage_bps: 300,
        });
        this.pendingSell.add(mint);
      }
    }

    this.buyTimes = this.buyTimes.filter((t) => this.now - t < 3600);
    const behind = this.roundTrips.size + this.positions.size + this.pendingBuy.size < this.desiredRoundTrips(elapsed);
    const riskBlocked = this.now < this.haltedUntil || hourReturn <= -this.p.hourLossStop;
    const canBuy = elapsed < 19800 && this.buyTimes.length < this.p.maxBuysPerHour && (!riskBlocked || behind);
    if (!canBuy) return orders;

    const slots = Math.min(this.p.maxConcurrent, this.maxOpen) - this.positions.size - this.pendingBuy.size;
    const orderSlots = this.maxOrders - orders.length;
    if (slots <= 0 || orderSlots <= 0) return orders;

    const candidates: { mint: string; score: number; sizeSol: number; completion: boolean }[] = [];
    for (const [mint, s] of this.mints) {
      if (s.complete || s.price <= 0 || this.positions.has(mint) || this.pendingBuy.has(mint)) continue;
      if (this.now - s.lastExitAt < this.p.cooldownSec) continue;
      if (s.entries >= 2) continue;
      const f = this.features(s);
      let score = this.scoreFor(this.p.mode, f);
      let completion = false;
      if (score < 0 && behind && !this.roundTrips.has(mint)) {
        const liquidEnough = f.reserveSol >= 8 && f.buyers >= 3 && f.buyShare >= 0.5 && f.ret30 > -0.03;
        if (liquidEnough) { score = 1 + f.buyShare; completion = true; }
      }
      if (score < 0) continue;
      if (riskBlocked && !completion) continue;
      const capSol = (f.reserveSol * this.orderCapBps) / 10000;
      const cashSol = Number(this.cash) / LAMPORTS;
      const scale = completion ? 1 : Math.min(1.25, Math.max(0.7, score / 3));
      const sizeSol = Math.min((completion ? this.p.completionSizeSol : this.p.baseSizeSol * scale), capSol * 0.9, cashSol * 0.2);
      if (sizeSol < 0.011) continue;
      candidates.push({ mint, score: score + (completion ? 0.5 : 0), sizeSol, completion });
    }
    candidates.sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : 1));
    for (const c of candidates.slice(0, Math.min(slots, orderSlots))) {
      const lamports = BigInt(Math.floor(c.sizeSol * LAMPORTS));
      if (lamports < MIN_ROUND_TRIP_LAMPORTS) continue;
      orders.push({
        side: "buy", client_id: `b${this.orderSeq++}`, mint: c.mint,
        quote_lamports: lamports.toString(), max_slippage_bps: 300,
      });
      this.pendingBuy.set(c.mint, { mode: this.p.mode, completion: c.completion });
      this.state(c.mint).entries += 1;
      this.buyTimes.push(this.now);
    }
    return orders;
  }
}
