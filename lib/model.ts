// The token radar's scoring model, round 2.
//
// One snapshot in, one ranked board out. The board holds every watchlist slug
// (the floor, never the ceiling) plus every other pre-token protocol the
// snapshot can rank, strongest implied value first. A protocol whose token
// already trades is kept apart and shown with the market's own numbers, never
// mixed into the ranking.
//
// A protocol's implied value comes from the snapshot's own figures only:
//   multiple  the market's median market-cap-to-TVL ratio, measured live
//   growth    the seven-day TVL change, clamped and weighted
//   maturity  how long it has run with no token, up to three years
//   breadth   how many chains it runs on, up to five extra
//   implied   TVL x multiple x growth x maturity x breadth, rounded
//
// Wrapped, staked and bridged products are set aside by the watchlist's own
// exclusion rule, applied to every row: they are products of tokens that
// already trade and will never launch a token of their own. The multiples are
// re-measured from each snapshot at run time, so no protocol name is ever
// special-cased and no number is assumed. Each row also carries an eight-step
// farm plan, derived from the protocol's category, chains, TVL and age.

/** One protocol as the sealed snapshot records it: exactly ten fields. */
export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}

/** The model's tunable constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number;
  unknown_age_days: number; min_category_peers: number; shrink_prior: number;
  multiple_floor: number; multiple_cap: number;
  breadth_step: number; breadth_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.45, growth_floor: -50, growth_cap: 100,
  maturity_floor: 0.6, maturity_range: 0.4, maturity_days: 1095,
  unknown_age_days: 365, min_category_peers: 4, shrink_prior: 8,
  multiple_floor: 0.05, multiple_cap: 0.8,
  breadth_step: 0.02, breadth_cap: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Live token view carries. */
export const LIVE_ROWS = 24;

/** One farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string; cost: string; time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null;
  chains: string[]; tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number; growth_pct: number;
    growth_multiplier: number; maturity_multiplier: number;
    breadth_multiplier: number; age_days: number | null;
  };
  farm_steps: string[];
}

/** A board row's compact form for data.js; the page builds the plan from it. */
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null;
  chains: string[]; tvl_usd: number; change_7d: number | null;
  mcap_usd: number | null; listed_at: string | null; age_days: number | null;
  implied_value_usd: number; category_multiple: number;
  growth_multiplier: number; maturity_multiplier: number;
  breadth_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's
 *  own value for it, not a model's. */
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the model. */
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model: ModelConstants;
  model_version: string; watchlist_size: number; board_size: number;
  early_size: number; live_size: number; market_multiple: number;
  category_multiples: Record<string, number>; watchlist: string[];
  rows: RadarRow[]; live: LiveRow[];
}

/** The headline figures: watchlist size, board size, early and live counts. */
export interface BoardSummary {
  watchlist_size: number; board_size: number;
  early_size: number; live_size: number;
}

/** Why a snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** Clamp a value into [lo, hi]. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** A finite number, else `fallback`. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a non-empty list of numbers. */
function middle(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1
    ? ordered[mid]!
    : (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/** Four decimals, for the multipliers the dashboard displays and recomputes. */
function fourDp(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Whole days from `listedAt` to `asOf`, at least zero; null when either date
 *  is absent or unparseable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(asOf + 'T00:00:00Z');
  const listed = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(start) || !Number.isFinite(listed)) return null;
  return Math.max(0, Math.floor((start - listed) / MS_PER_DAY));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * The market's own value multiples, measured from this snapshot's live-token
 * protocols: the median market-cap-to-TVL ratio overall, and per category
 * where enough live peers exist. A ratio counts only when both figures are
 * positive; the median, not the mean, so one outlier cannot move it. The
 * per-category multiple is shrunk toward the global median (prior weight 8)
 * and clamped; a category with too few peers falls back to the global median.
 */
export interface MarketMultiples {
  global: number;
  byCategory: Record<string, number>;
}

export function marketMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): MarketMultiples {
  const live = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd);
  const global = ratios.length > 0 ? middle(ratios) : 0.25;
  const byCategory: Record<string, number> = {};
  const groups = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = groups.get(key);
    if (list) list.push(p.mcap_usd! / p.tvl_usd);
    else groups.set(key, [p.mcap_usd! / p.tvl_usd]);
  }
  for (const [key, list] of groups) {
    if (list.length < model.min_category_peers) continue;
    const shrunk =
      (list.length * middle(list) + model.shrink_prior * global) /
      (list.length + model.shrink_prior);
    byCategory[key] = clamp(shrunk, model.multiple_floor, model.multiple_cap);
  }
  return { global: clamp(global, model.multiple_floor, model.multiple_cap), byCategory };
}

/** One protocol's multiple: its category's measured multiple, or the global. */
export function categoryMultiple(p: SnapshotProtocol, multiples: MarketMultiples): number {
  return multiples.byCategory[p.category ?? 'Other'] ?? multiples.global;
}

/** The five factors and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  multiples: MarketMultiples,
): {
  implied: number; categoryMultiple: number; growthPct: number;
  growthMult: number; maturityMult: number; breadthMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(numOr(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + growthPct / 100 * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days * model.maturity_range;
  const breadthMult =
    1 + model.breadth_step * Math.min(Math.max(protocol.chains.length - 1, 0), model.breadth_cap);
  const catMult = categoryMultiple(protocol, multiples);
  const implied = Math.max(
    1,
    Math.round(protocol.tvl_usd * catMult * growthMult * maturityMult * breadthMult),
  );
  return {
    implied, categoryMultiple: catMult, growthPct,
    growthMult, maturityMult, breadthMult, age,
  };
}

/** A name ending in a release marker is a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the watchlist rule keeps out: wrapped, staked or bridged
 *  products of a token that already trades. */
const BLOCKED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking',
  'Liquid Restaking', 'Restaked BTC', 'CEX',
]);

/** A whole wrapped / staked / staking word in a name. */
const WRAPPED_TERM = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a protocol name must not start with. */
const EXCHANGE_NAMES = [
  'Binance', 'Coinbase', 'Bybit', 'Kraken',
  'Bitget', 'OKX', 'Bitfinex', 'Gemini',
];

/** Whether a protocol is one the board may rank: pre-token, and not a wrapped,
 *  staked or bridged product of a token that already trades -- the watchlist's
 *  own exclusion, applied to every row. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && BLOCKED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_TERM.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  return true;
}

/** The snapshot's protocols keyed by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const multiples = marketMultiples(snapshot, model);
  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no
  // longer carries (it cannot, but coverage is the gate's row and is never
  // gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  // The early radar: every other pre-token protocol the snapshot can rank,
  // whatever its TVL. No cutoff beyond the snapshot's own $5M floor: the
  // radar exists to find the early ones.
  for (const p of snapshot.protocols) {
    if (!picked.has(p.slug) && isRankable(p)) picked.set(p.slug, p);
  }

  const scored = [...picked.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, multiples);
    return { protocol: p, value: v };
  });
  scored.sort(
    (a, b) =>
      b.value.implied - a.value.implied ||
      (a.protocol.slug < b.protocol.slug
        ? -1
        : a.protocol.slug > b.protocol.slug
          ? 1
          : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1, slug: s.protocol.slug, name: s.protocol.name,
    category: s.protocol.category, chains: s.protocol.chains,
    tvl_usd: s.protocol.tvl_usd, change_7d: s.protocol.change_7d,
    mcap_usd: s.protocol.mcap_usd, listed_at: s.protocol.listed_at,
    gecko_id: s.protocol.gecko_id, symbol: s.protocol.symbol,
    token_status: 'pre-token', age_days: s.value.age,
    implied_value_usd: s.value.implied,
    model: {
      // Full precision on the multiple, not rounded: the dashboard recomputes
      // this row from these figures and must land on the same integer the
      // board carries. The page formats the multiple to four decimals.
      category_multiple: s.value.categoryMultiple, growth_pct: s.value.growthPct,
      growth_multiplier: fourDp(s.value.growthMult),
      maturity_multiplier: fourDp(s.value.maturityMult),
      breadth_multiplier: fourDp(s.value.breadthMult),
      age_days: s.value.age,
    },
    farm_steps: farmSteps(s.protocol, s.value.age).map(stepText),
  }));
}

/** One step as a single string: its action, then its cost and time, within
 *  the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (s.length > 600) s = s.slice(0, 596) + '...';
  if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapshotProtocol): string {
  return p.chains[0] ?? 'its main chain';
}

/** What one transaction costs on a chain, from the chain's own fee level. */
function feesFor(chain: string): { tx: string; week: string; exit: string; amount: string } {
  const c = chain.toLowerCase();
  if (c === 'solana') {
    return {
      tx: 'under $0.10 of gas',
      week: 'about $0.10 of gas a week',
      exit: 'under $0.10 of gas',
      amount: '$0.10',
    };
  }
  if (c === 'ethereum') {
    return {
      tx: '$3 to $8 of gas',
      week: 'about $4 of gas a week',
      exit: '$3 to $8 of gas',
      amount: '$8',
    };
  }
  if (c === 'bitcoin') {
    return {
      tx: '$2 to $5 of network fees',
      week: 'about $3 of network fees a week',
      exit: '$2 to $5 of network fees',
      amount: '$5',
    };
  }
  if (CHEAP_CHAINS.has(c)) {
    return {
      tx: 'under $0.50 of gas',
      week: 'about $0.50 of gas a week',
      exit: 'under $0.50 of gas',
      amount: '$0.50',
    };
  }
  return {
    tx: 'under $2 of gas',
    week: 'about $2 of gas a week',
    exit: 'under $2 of gas',
    amount: '$2',
  };
}

/** Chains whose fees stay under fifty cents a transaction. */
const CHEAP_CHAINS = new Set([
  'base', 'arbitrum', 'optimism', 'polygon', 'blast', 'linea', 'scroll',
  'zksync', 'mantle', 'mode', 'binance', 'bnb chain', 'avalanche',
  'monad', 'hyperliquid l1', 'plasma',
]);

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer
 *  qualifying window. */
function holdFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/**
 * The farm actions by category. Each rule names the category words that
 * select it and the two actions it yields: the opening move and the second
 * qualifying move. Rules are tried in order; the first whose words appear in
 * the category wins. The fallback (no rule matches) is a plain deposit, and
 * the chain rule's second move is the fallback's, since a chain category has
 * no second move of its own. No protocol name is special-cased: the category
 * alone decides the plan.
 */
interface FarmRule {
  keys: string[];
  open: (name: string, amount: number, chain: string) => string;
  again: (name: string, amount: number, chain: string) => string;
}

const FALLBACK_OPEN = (name: string, amount: number, chain: string): string =>
  'Deposit $' + amount + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
const FALLBACK_AGAIN = (name: string, amount: number, chain: string): string =>
  'Repeat the deposit in a second week with $' + amount + ' more, so the activity spans two weeks.';

const FARM_RULES: FarmRule[] = [
  {
    keys: ['lend', 'cdp', 'collateral'],
    open: (name, amount, chain) =>
      'Supply $' + amount + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.',
    again: (name, amount) =>
      'Borrow $' + amount + ' against that supply on ' + name + ' and repay it within the week, so the position shows both sides.',
  },
  {
    keys: ['dex', 'yield', 'leveraged farm'],
    open: (name, amount, chain) =>
      'Provide $' + amount + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.',
    again: (name, amount, chain) =>
      'Swap $' + amount + ' through ' + name + "'s main pool on " + chain + ' and add the proceeds to a second pool.',
  },
  {
    keys: ['bridge'],
    open: (name, amount, chain) =>
      'Bridge $' + amount + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.',
    again: (name, amount, chain) =>
      'Use the bridged funds on ' + chain + ': swap $' + amount + ' in the destination app and keep the receipt.',
  },
  {
    keys: ['staking', 'restak'],
    open: (name, amount) =>
      'Stake $' + amount + " of the chain's staking asset through " + name + ' and keep the receipt.',
    again: (name, amount) =>
      'Delegate a second $' + amount + ' tranche through ' + name + ' to a different validator or pool.',
  },
  {
    keys: ['perpetual', 'derivative'],
    open: (name, amount) =>
      'Deposit $' + amount + ' of USDC as margin on ' + name + ' and open one small hedge.',
    again: (name, amount) =>
      'Close the first hedge and open a second small trade on ' + name + ', about $' + amount + ' of margin.',
  },
  {
    keys: ['prediction'],
    open: (name, amount) =>
      'Fund $' + amount + ' and place one market position on ' + name + '.',
    again: (name, amount) =>
      'Place a second market position of about $' + amount + ' on ' + name + ', on a different outcome.',
  },
  {
    keys: ['curator', 'allocator', 'risk'],
    open: (name, amount, chain) =>
      'Deposit $' + amount + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.',
    again: (name, amount, chain) =>
      'Deposit a second $' + amount + ' into another ' + name + ' vault on ' + chain + ' and keep those shares too.',
  },
  {
    keys: ['stable'],
    open: (name, amount, chain) =>
      'Mint or deposit $' + amount + ' of the stable asset through ' + name + ' on ' + chain + '.',
    again: (name, amount, chain) =>
      'Move $' + amount + ' of the stable asset into a second use on ' + chain + ', such as a lend or a swap.',
  },
  {
    keys: ['rwa'],
    open: (name, amount, chain) =>
      'Mint $' + amount + " of the protocol's yield asset on " + chain + ' and hold it.',
    again: (name, amount, chain) =>
      'Check the yield accrued on the ' + name + ' asset and top it up by $' + amount + ' on ' + chain + '.',
  },
  {
    keys: ['insurance'],
    open: (name, amount, chain) =>
      'Buy $' + amount + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.',
    again: (name, amount) =>
      'Read the cover terms for the ' + name + ' policy and note the claim window and payout asset.',
  },
  {
    keys: ['chain'],
    open: (name, amount, chain) =>
      'Bridge $' + amount + ' of USDC to ' + chain + ' and try ' + name + "'s flagship app with it.",
    again: FALLBACK_AGAIN,
  },
];

/** The rule a category selects, or null when none matches. */
function ruleFor(category: string): FarmRule | null {
  const c = category.toLowerCase();
  for (const rule of FARM_RULES) {
    if (rule.keys.some((k) => c.includes(k))) return rule;
  }
  return null;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names. Costs follow the chain's fee
 * level and the position's size; times are the minutes or days each step takes.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = firstChain(p);
  const fees = feesFor(chain);
  const stake = stakeFor(p);
  const hold = holdFor(age);
  const rule = ruleFor(p.category ?? '');
  const half = Math.max(25, Math.round(stake / 2));
  const open = rule ? rule.open(p.name, stake, chain) : FALLBACK_OPEN(p.name, stake, chain);
  const again = rule ? rule.again(p.name, half, chain) : FALLBACK_AGAIN(p.name, half, chain);
  return [
    {
      text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      cost: fees.tx,
      time: '5 minutes',
    },
    {
      text: open,
      cost: '$' + stake + ' of capital and about ' + fees.amount + ' of gas',
      time: '15 minutes to set up',
    },
    {
      text: again,
      cost: 'about half the first deposit and ' + fees.tx,
      time: '15 minutes',
    },
    {
      text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
      cost: fees.week,
      time: '10 minutes a week',
    },
    {
      text:
        'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot, and do not withdraw early.',
      cost: 'the $' + stake + ' stays in the position',
      time: hold + ' days',
    },
    {
      text: "Once a week, open the protocol's own points or rewards page from its own site and complete only the quests it lists there.",
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes a week',
    },
    {
      text: "Check every link from the protocol's own site or docs, never pay to claim, and never sign an approval you have not read.",
      cost: 'nothing',
      time: '5 minutes',
    },
    {
      text: 'Write the wallet, the dates and every transaction in a farm log, re-check the TVL and seven-day change monthly, and unwind in stages, half first, keeping dust for gas.',
      cost: fees.exit,
      time: '15 minutes to unwind',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const trading = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  trading.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return trading.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category,
    chains: row.chains, tvl_usd: row.tvl_usd, change_7d: row.change_7d,
    mcap_usd: row.mcap_usd, listed_at: row.listed_at, age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const multiples = marketMultiples(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model, model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length, board_size: board.length,
    early_size: early, live_size: live.length,
    market_multiple: fourDp(multiples.global),
    category_multiples: Object.fromEntries(
      Object.entries(multiples.byCategory).map(([k, v]) => [k, fourDp(v)]),
    ),
    watchlist: snapshot.watchlist, rows: board.map(radarRow), live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = doc.protocols.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = entry as Record<string, unknown>;
    if (
      typeof p.slug !== 'string' ||
      typeof p.name !== 'string' ||
      typeof p.tvl_usd !== 'number' ||
      !Number.isFinite(p.tvl_usd)
    ) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: p.tvl_usd,
      change_7d:
        typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd:
        typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd,
    protocols, watchlist: doc.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order,
 *  one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (
    board.length >= 2 &&
    board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
  ) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      if (s.length < 20 || s.length > 600) {
        return `${r.slug} has a farm step of ${s.length} characters`;
      }
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}
