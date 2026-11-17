// Token Radar's dashboard, round 2. It reads window.RADAR (written beside
// dashboard/ by main.ts) and renders the ranked board, a filterable table, a
// per-protocol detail drawer with the model's own inputs and the protocol's
// farm plan. No network: every byte it shows is in data.js. The farm plan
// here is the same derivation main.ts writes to board.json, so the page and
// the board always agree.
(() => {
  'use strict';

  const DATA = window.RADAR;
  if (!DATA) return;
  const app = document.getElementById('board');
  const state = {
    q: '', category: 'all', chain: 'all', watchOnly: false,
    tab: 'pre-token', sort: 'implied', dir: -1, selected: null,
  };

  // -- Formatting -----------------------------------------------------------

  const usdFmt = new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  });
  const money = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFmt.format(n);
  };
  const pct = (n) => {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  };
  const ageLabel = (days) => {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  };

  // The model in one function: the page recomputes a row from the snapshot
  // figures and checks the number board.json carries, so the page's code and
  // the board's data are visibly the same arithmetic.
  const recompute = (row, model) => {
    const growth = Math.min(
      model.growth_cap,
      Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d),
    );
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const age = row.age_days === null || row.age_days === undefined
      ? model.unknown_age_days : row.age_days;
    const maturity = model.maturity_floor +
      (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const breadth = 1 + model.breadth_step *
      Math.min(Math.max((row.chains || []).length - 1, 0), model.breadth_cap);
    return Math.max(
      1,
      Math.round(row.tvl_usd * row.category_multiple * growthMult * maturity * breadth),
    );
  };

  // -- A tiny element builder ------------------------------------------------

  const h = (tag, attrs, ...kids) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined) continue;
      if (Array.isArray(kid)) {
        for (const c of kid) if (c) node.appendChild(c);
      } else if (typeof kid === 'string') {
        node.appendChild(document.createTextNode(kid));
      } else {
        node.appendChild(kid);
      }
    }
    return node;
  };

  // -- The farm plan ---------------------------------------------------------
  // Same derivation as the model: category, chains, TVL and age decide the
  // action, the capital, the hold and every cost and time. No name is
  // special-cased.

  const chainOf = (p) => (p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain');

  const CHEAP = new Set([
    'base', 'arbitrum', 'optimism', 'polygon', 'blast', 'linea', 'scroll',
    'zksync', 'mantle', 'mode', 'binance', 'bnb chain', 'avalanche',
    'monad', 'hyperliquid l1', 'plasma',
  ]);
  const feesFor = (chain) => {
    const c = (chain || '').toLowerCase();
    if (c === 'solana') {
      return { tx: 'under $0.10 of gas', week: 'about $0.10 of gas a week', exit: 'under $0.10 of gas', amount: '$0.10' };
    }
    if (c === 'ethereum') {
      return { tx: '$3 to $8 of gas', week: 'about $4 of gas a week', exit: '$3 to $8 of gas', amount: '$8' };
    }
    if (c === 'bitcoin') {
      return { tx: '$2 to $5 of network fees', week: 'about $3 of network fees a week', exit: '$2 to $5 of network fees', amount: '$5' };
    }
    if (CHEAP.has(c)) {
      return { tx: 'under $0.50 of gas', week: 'about $0.50 of gas a week', exit: 'under $0.50 of gas', amount: '$0.50' };
    }
    return { tx: 'under $2 of gas', week: 'about $2 of gas a week', exit: 'under $2 of gas', amount: '$2' };
  };
  const stakeFor = (p) => {
    if (p.tvl_usd >= 1e9) return 250;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  };
  const holdFor = (age) => {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  };

  const FALLBACK_OPEN = (name, amount, chain) =>
    'Deposit $' + amount + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  const FALLBACK_AGAIN = (name, amount) =>
    'Repeat the deposit in a second week with $' + amount + ' more, so the activity spans two weeks.';
  const FARM_RULES = [
    {
      keys: ['lend', 'cdp', 'collateral'],
      open: (name, amount, chain) => 'Supply $' + amount + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.',
      again: (name, amount) => 'Borrow $' + amount + ' against that supply on ' + name + ' and repay it within the week, so the position shows both sides.',
    },
    {
      keys: ['dex', 'yield', 'leveraged farm'],
      open: (name, amount, chain) => 'Provide $' + amount + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.',
      again: (name, amount, chain) => 'Swap $' + amount + ' through ' + name + "'s main pool on " + chain + ' and add the proceeds to a second pool.',
    },
    {
      keys: ['bridge'],
      open: (name, amount, chain) => 'Bridge $' + amount + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.',
      again: (name, amount, chain) => 'Use the bridged funds on ' + chain + ': swap $' + amount + ' in the destination app and keep the receipt.',
    },
    {
      keys: ['staking', 'restak'],
      open: (name, amount) => 'Stake $' + amount + " of the chain's staking asset through " + name + ' and keep the receipt.',
      again: (name, amount) => 'Delegate a second $' + amount + ' tranche through ' + name + ' to a different validator or pool.',
    },
    {
      keys: ['perpetual', 'derivative'],
      open: (name, amount) => 'Deposit $' + amount + ' of USDC as margin on ' + name + ' and open one small hedge.',
      again: (name, amount) => 'Close the first hedge and open a second small trade on ' + name + ', about $' + amount + ' of margin.',
    },
    {
      keys: ['prediction'],
      open: (name, amount) => 'Fund $' + amount + ' and place one market position on ' + name + '.',
      again: (name, amount) => 'Place a second market position of about $' + amount + ' on ' + name + ', on a different outcome.',
    },
    {
      keys: ['curator', 'allocator', 'risk'],
      open: (name, amount, chain) => 'Deposit $' + amount + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.',
      again: (name, amount, chain) => 'Deposit a second $' + amount + ' into another ' + name + ' vault on ' + chain + ' and keep those shares too.',
    },
    {
      keys: ['stable'],
      open: (name, amount, chain) => 'Mint or deposit $' + amount + ' of the stable asset through ' + name + ' on ' + chain + '.',
      again: (name, amount, chain) => 'Move $' + amount + ' of the stable asset into a second use on ' + chain + ', such as a lend or a swap.',
    },
    {
      keys: ['rwa'],
      open: (name, amount, chain) => 'Mint $' + amount + " of the protocol's yield asset on " + chain + ' and hold it.',
      again: (name, amount, chain) => 'Check the yield accrued on the ' + name + ' asset and top it up by $' + amount + ' on ' + chain + '.',
    },
    {
      keys: ['insurance'],
      open: (name, amount, chain) => 'Buy $' + amount + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.',
      again: (name, amount) => 'Read the cover terms for the ' + name + ' policy and note the claim window and payout asset.',
    },
    {
      keys: ['chain'],
      open: (name, amount, chain) => 'Bridge $' + amount + ' of USDC to ' + chain + ' and try ' + name + "'s flagship app with it.",
      again: FALLBACK_AGAIN,
    },
  ];
  const ruleFor = (category) => {
    const c = (category || '').toLowerCase();
    return FARM_RULES.find((rule) => rule.keys.some((k) => c.includes(k))) || null;
  };
  const stepText = (step) => {
    let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  };
  const farmSteps = (p) => {
    const chain = chainOf(p);
    const fees = feesFor(chain);
    const stake = stakeFor(p);
    const hold = holdFor(p.age_days);
    const rule = ruleFor(p.category || '');
    const half = Math.max(25, Math.round(stake / 2));
    const open = rule ? rule.open(p.name, stake, chain) : FALLBACK_OPEN(p.name, stake, chain);
    const again = rule ? rule.again(p.name, half, chain) : FALLBACK_AGAIN(p.name, half, chain);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: fees.tx, time: '5 minutes' },
      { text: open, cost: '$' + stake + ' of capital and about ' + fees.amount + ' of gas', time: '15 minutes to set up' },
      { text: again, cost: 'about half the first deposit and ' + fees.tx, time: '15 minutes' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: fees.week, time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot, and do not withdraw early.', cost: 'the $' + stake + ' stays in the position', time: hold + ' days' },
      { text: "Once a week, open the protocol's own points or rewards page from its own site and complete only the quests it lists there.", cost: 'no fee to check, and never pay to claim', time: '10 minutes a week' },
      { text: "Check every link from the protocol's own site or docs, never pay to claim, and never sign an approval you have not read.", cost: 'nothing', time: '5 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log, re-check the TVL and seven-day change monthly, and unwind in stages, half first, keeping dust for gas.', cost: fees.exit, time: '15 minutes to unwind' },
    ].map(stepText);
  };

  // Flags a reader should see before farming: youth, a falling TVL, one
  // chain, below the floor.
  const noticesFor = (row) => {
    const flags = [];
    if (row.age_days !== null && row.age_days !== undefined && row.age_days < 90) {
      flags.push('New: first listed under 90 days ago, so the record is short.');
    }
    if (row.change_7d !== null && row.change_7d !== undefined && row.change_7d <= -20) {
      flags.push('TVL down 20% or more in seven days; check why before depositing.');
    }
    if (!row.chains || row.chains.length <= 1) {
      flags.push('Single chain: the whole position sits on one network.');
    }
    if (row.tvl_usd < DATA.floor_usd) {
      flags.push('Below the $50M watchlist floor: an early find, with a thinner record to judge it by.');
    }
    return flags;
  };

  const onWatchlist = (slug) => DATA.watchlist && DATA.watchlist.indexOf(slug) >= 0;

  // -- The location hash carries the reader's place --------------------------

  const readLocation = () => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watch') === '1') state.watchOnly = true;
  };
  const writeLocation = () => {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchOnly) params.set('watch', '1');
    if (state.selected) params.set('p', state.selected);
    const next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };

  // -- Filtering and sorting --------------------------------------------------

  const visibleRows = () => {
    const q = state.q.trim().toLowerCase();
    return DATA.rows.filter((r) => {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (!r.chains || r.chains.indexOf(state.chain) < 0)) return false;
      if (state.watchOnly && !onWatchlist(r.slug)) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  };
  const orderedRows = (list) => {
    const key = state.sort;
    return list.slice().sort((a, b) => {
      let av; let bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  };

  // -- Page sections ----------------------------------------------------------

  const topBar = () => h('header', { class: 'top' },
    h('div', { class: 'brand' },
      h('span', { class: 'mark' }),
      h('span', { class: 'brand-name', text: 'Token Radar' })),
    h('div', { class: 'top-meta' },
      h('span', { text: 'Snapshot ' + DATA.as_of }),
      h('span', { text: 'DefiLlama protocol index' }),
      h('span', { text: DATA.model_version + ' model' })));

  const intro = () => h('section', { class: 'lede' },
    h('div', null,
      h('h1', { text: DATA.board_size + ' pre-token protocols, ranked by implied value' }),
      h('p', { text: 'Every protocol in the snapshot that records no token and is not a wrapped, staked or bridged product: the ' + DATA.watchlist_size + ' on the watchlist, plus ' + DATA.early_size + ' early ones below the $' + Math.round(DATA.floor_usd / 1e6) + 'M floor. Implied value is a model, not a promise, and no token on record does not mean no token exists.' })),
    h('div', { class: 'facts' },
      h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
      h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(DATA.board_size) })),
      h('div', { class: 'fact' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(DATA.early_size) })),
      h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(DATA.live_size) }))));

  const filters = () => {
    const categories = [...new Set(DATA.rows.map((r) => r.category || 'Other'))].sort();
    const chains = [...new Set(DATA.rows.reduce((acc, r) => acc.concat(r.chains || []), []))].sort();
    const search = h('input', {
      type: 'search', id: 'q', placeholder: 'Search name, category or chain',
      value: state.q, 'aria-label': 'Search the board',
    });
    search.addEventListener('input', () => { state.q = search.value; writeLocation(); render(); });
    const categorySelect = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map((c) => h('option', { value: c, text: c, selected: c === state.category ? 'selected' : null })));
    categorySelect.addEventListener('change', () => { state.category = categorySelect.value; writeLocation(); render(); });
    const chainSelect = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map((c) => h('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null })));
    chainSelect.addEventListener('change', () => { state.chain = chainSelect.value; writeLocation(); render(); });
    const watchBox = h('input', {
      type: 'checkbox', id: 'watch',
      checked: state.watchOnly ? 'checked' : null, 'aria-label': 'Watchlist only',
    });
    watchBox.addEventListener('change', () => { state.watchOnly = watchBox.checked; writeLocation(); render(); });
    const pre = h('button', {
      type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token', onclick: () => { state.tab = 'pre-token'; render(); },
    });
    const live = h('button', {
      type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false',
      text: 'Live token', onclick: () => { state.tab = 'live'; render(); },
    });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), categorySelect),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSelect),
      h('div', { class: 'field check' }, h('label', { for: 'watch', text: 'Watchlist only' }), watchBox),
      h('div', { class: 'field' },
        h('span', { class: 'sub', text: 'Token status' }),
        h('div', { class: 'tabs' }, pre, live)),
      h('span', { class: 'count', text: state.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' }));
  };

  const sortButton = (key, label) => h('th', { scope: 'col' },
    h('button', {
      type: 'button',
      onclick: () => {
        if (state.sort === key) state.dir = -state.dir;
        else { state.sort = key; state.dir = -1; }
        render();
      },
    },
    label,
    state.sort === key ? h('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null));

  const boardTable = () => {
    const list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', {
          class: 'button primary', type: 'button', text: 'Clear filters',
          onclick: () => {
            state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchOnly = false;
            writeLocation(); render();
          },
        })));
    }
    const max = list.reduce((m, r) => Math.max(m, r.implied_value_usd), 1);
    const tbody = h('tbody');
    for (const r of list) {
      const growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      const growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const chainText = r.chains && r.chains.length
        ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain';
      const tr = h('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: () => openDetail(r.slug),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); }
        },
      },
      h('td', { class: 'num', text: String(r.rank) }),
      h('td', null, h('div', { class: 'name' },
        h('b', { text: r.name }),
        h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainText + (onWatchlist(r.slug) ? '  ·  Watchlist' : '') }))),
      h('td', { class: 'num', text: money(r.tvl_usd) }),
      h('td', { class: 'num ' + growthClass, text: growth }),
      h('td', { class: 'num', text: ageLabel(r.age_days) }),
      h('td', null, h('div', { class: 'implied' },
        h('div', { class: 'bar', 'aria-hidden': 'true' },
          h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
        h('span', { class: 'num', text: money(r.implied_value_usd) }))),
      h('td', null, h('span', { class: 'status', text: 'no token' })));
      tbody.appendChild(tr);
    }
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model, its flags and its farm plan.' }),
          h('thead', null, h('tr', null,
            sortButton('implied', 'Rank'),
            sortButton('name', 'Protocol'),
            sortButton('tvl', 'TVL'),
            sortButton('growth', '7d'),
            sortButton('age', 'Age'),
            sortButton('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' }))),
          tbody)));
  };

  const liveTable = () => {
    const tbody = h('tbody');
    for (const r of DATA.live) {
      const chainText = r.chains && r.chains.length
        ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain';
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, h('div', { class: 'name' },
          h('b', { text: r.name }),
          h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainText }))),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, h('span', { class: 'status', text: 'already trades' }))));
    }
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, h('tr', null,
            h('th', { scope: 'col', text: 'Status' }),
            h('th', { scope: 'col', text: 'Protocol' }),
            h('th', { scope: 'col', text: 'TVL' }),
            h('th', { scope: 'col', text: '7d' }),
            h('th', { scope: 'col', text: 'Market cap' }),
            h('th', { scope: 'col', text: 'Token' }))),
          tbody)));
  };

  const modelPanel = () => {
    const m = DATA.model;
    const measured = Object.keys(DATA.category_multiples || {}).sort()
      .map((k) => k + ' ' + DATA.category_multiples[k]).join(', ');
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The multiple is measured from this snapshot, not assumed.' }),
      h('div', { class: 'formula' },
        'implied = round( tvl_usd x categoryMultiple x (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 x ' + m.growth_weight + ') x (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' x ' + m.maturity_range + ') x (1 + ' + m.breadth_step + ' x min(chains - 1, ' + m.breadth_cap + ')) )'),
      h('p', { class: 'sub', text: 'categoryMultiple is the median market-cap-to-TVL ratio of the live-token protocols in this snapshot, per category where at least ' + m.min_category_peers + ' live peers exist, shrunk toward the global median of ' + DATA.market_multiple + ' and clamped to [' + m.multiple_floor + ', ' + m.multiple_cap + ']. Measured now: ' + (measured || 'global ' + DATA.market_multiple) + '. A category with too few live peers uses the global median.' }),
      h('p', { class: 'sub', text: 'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. Wrapped, staked and bridged products are set aside from the board, and the live-token protocols are set aside with their market caps shown.' }));
  };

  // -- The detail drawer ------------------------------------------------------

  const dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', () => { state.selected = null; writeLocation(); });

  const openDetail = (slug) => {
    const row = DATA.rows.filter((r) => r.slug === slug)[0];
    if (!row) return;
    state.selected = slug;
    writeLocation();
    dialog.textContent = '';
    const steps = farmSteps(row);
    const flags = noticesFor(row);
    dialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (onWatchlist(row.slug) ? '  ·  Watchlist' : '  ·  Early radar') }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: () => dialog.close() })));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Category multiple' }), h('b', { class: 'num', text: row.category_multiple.toFixed(4) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageLabel(row.age_days) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Breadth multiplier' }), h('b', { class: 'num', text: String(row.breadth_multiplier) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: money(row.implied_value_usd) }))),
      h('p', { class: 'sub', text: 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(recompute(row, DATA.model)) + (recompute(row, DATA.model) === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price.' })));
    if (flags.length > 0) {
      dialog.appendChild(h('section', { class: 'detail-section' },
        h('h3', { text: 'Before you farm it' }),
        h('ul', { class: 'flags' }, flags.map((f) => h('li', { text: f })))));
    }
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map((s) => {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  };

  // -- Render -----------------------------------------------------------------

  const render = () => {
    app.textContent = '';
    const shell = h('div', { class: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(filters());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  };

  readLocation();
  render();
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
