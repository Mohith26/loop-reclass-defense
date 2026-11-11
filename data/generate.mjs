// Seeded generator for the Reclass Defense demo.
// Writes data/dataset.json (one shipper, one open month) and data/results.json
// (200-month backtest of the decision rule vs two baselines).
// Run: node data/generate.mjs
import { writeFileSync } from 'node:fs';
import {
  rng, cubeFt3, classForDensity, classRank, profileStats, inspectionScore, rerate,
  decideBatch, selectionQuality, rateShipment, round2,
} from '../src/core.js';

// ---------------------------------------------------------------- world spec
// Fictional mid-market CPG shipper. Pallet profiles are seeded from typical
// published snack/candy/beverage pallet configs (48x40 GMA, 40-72 in tall).
// stale: master-data height is shorter than reality (packaging change), so the
// BOL under-declares class and a carrier reclass is legitimately correct.
export const PROFILES = [
  ['P01', 'Pretzel twists 16oz · 12ct', 48, 40, 62, 520, 1.1, 0.025, 0],
  ['P02', 'Kettle chips 8oz · 24ct', 48, 40, 70, 310, 1.4, 0.03, 0],
  ['P03', 'Tortilla chips 13oz · 12ct', 48, 40, 68, 405, 1.2, 0.028, 4],
  ['P04', 'Gummy bears 5lb bag · 6ct', 48, 40, 52, 1180, 0.8, 0.018, 0],
  ['P05', 'Chocolate bars 1.5oz · 36ct', 48, 40, 48, 1290, 0.7, 0.015, 0],
  ['P06', 'Hard candy 40oz · 12ct', 48, 40, 50, 1410, 0.7, 0.016, 0],
  ['P07', 'Sparkling water 12pk cans', 48, 40, 54, 1960, 0.6, 0.012, 0],
  ['P08', 'Cold brew 11oz · 12ct', 48, 40, 50, 1520, 0.6, 0.014, 0],
  ['P09', 'Granola 11oz · 12ct', 48, 40, 60, 690, 1.0, 0.022, 0],
  ['P10', 'Trail mix 26oz · 6ct', 48, 40, 58, 820, 0.9, 0.02, 3],
  ['P11', 'Popcorn 3pk · 12ct', 48, 40, 72, 260, 1.5, 0.035, 0],
  ['P12', 'Rice cakes 4.5oz · 12ct', 48, 40, 70, 240, 1.4, 0.035, 0],
  ['P13', 'Licorice twists 16oz · 12ct', 48, 40, 54, 1050, 0.8, 0.02, 0],
  ['P14', 'Peanut butter cups 12ct', 48, 40, 50, 1180, 0.7, 0.017, 0],
  ['P15', 'Crackers 8oz · 12ct', 48, 40, 64, 560, 1.1, 0.026, 0],
  ['P16', 'Protein bars 12ct · 8 cases', 48, 40, 46, 1015, 0.7, 0.018, 3],
  ['P17', 'Snack mix variety 30ct', 48, 40, 66, 470, 1.2, 0.027, 0],
  ['P18', 'Juice boxes 6.75oz · 32ct', 48, 40, 52, 1650, 0.6, 0.013, 0],
  ['P19', 'Display shipper, mixed candy', 48, 40, 60, 640, 1.6, 0.04, 0],
  ['P20', 'Seasonal tins, mixed', 48, 48, 64, 540, 1.3, 0.03, 0],
].map(([id, name, l, w, h, wt, hsd, wcv, stale]) => ({ id, name, l, w, h, wt, hsd, wcv, stale }));

export const CARRIERS = [
  ['PRAIRIE LINE FREIGHT INC', 0.16], ['SUMMIT LTL CARRIERS', 0.27], ['BLUE RIVER EXPRESS LLC', 0.21],
  ['GRANITE STATE FREIGHT', 0.12], ['MIDWAY FREIGHT LINES', 0.24], ['COASTAL CONSOLIDATED LTL', 0.19],
];

const ORIGINS = [['Joliet, IL', 'JOL'], ['Reno, NV', 'RNO'], ['Lancaster, PA', 'LNS']];
const DESTS = ['Columbus, OH', 'Atlanta, GA', 'Dallas, TX', 'Denver, CO', 'Phoenix, AZ', 'Charlotte, NC',
  'Kansas City, MO', 'Nashville, TN', 'Minneapolis, MN', 'Salt Lake City, UT', 'Albany, NY', 'Orlando, FL'];

const MONTH_SHIPMENTS = 640;
const INSPECTION_RATE = 0.14;
const HISTORY_MONTHS = 12;

function buildLanes(r) {
  const lanes = {};
  for (const [o, oc] of ORIGINS) for (const d of DESTS) {
    const id = oc + '-' + d.split(',')[0].replace(/\s/g, '').slice(0, 3).toUpperCase();
    lanes[id] = {
      origin: o, dest: d,
      base50: round2(26 + r() * 38), discount: round2(0.69 + r() * 0.07),
      minCharge: 110 + Math.round(r() * 35), fsc: round2(0.29 + r() * 0.05),
    };
  }
  return lanes;
}

function trueUnit(p, r) {
  return {
    l: p.l, w: p.w,
    h: p.h + p.stale + p.hsd * r.normal(),
    weight: p.wt * (1 + p.wcv * r.normal()),
  };
}

// Each simulated shipper differs in master-data staleness, carrier error
// rates and pallet-build variability, so the backtest covers easy and hard
// shippers. Seed 1 (the demo shipper) keeps the base profile table.
function worldProfiles(r, seed) {
  if (seed === 1) return { profiles: PROFILES, errScale: 1, staleShare: PROFILES.filter((p) => p.stale).length / PROFILES.length };
  const staleShare = r() * 0.45, errScale = 0.5 + r(), varScale = 0.7 + r() * 0.9;
  const profiles = PROFILES.map((p) => ({
    ...p, hsd: p.hsd * varScale, wcv: p.wcv * varScale,
    stale: r() < staleShare ? 2 + Math.floor(r() * 6) : 0,
  }));
  return { profiles, errScale, staleShare };
}

// Profiles with no DC dimensioner coverage fall back to the measurements on
// past carrier inspection certificates that were upheld (accurate inspections:
// heights rounded up to the inch, occasional +1 in footprint reads).
export const CERT_SOURCED = ['P11', 'P12', 'P19'];

function scanProfiles(r, PROFILES) {
  const scans = {};
  for (const p of PROFILES) {
    const cert = CERT_SOURCED.includes(p.id);
    const n = cert ? 40 + Math.floor(r() * 40) : 80 + Math.floor(r() * 120);
    scans[p.id] = Array.from({ length: n }, () => {
      const t = trueUnit(p, r);
      if (cert) return { l: p.l + (r() < 0.15 ? 1 : 0), w: p.w + (r() < 0.15 ? 1 : 0), h: Math.ceil(t.h + 0.25 * r.normal()), weight: Math.round(t.weight * (1 + 0.003 * r.normal())) };
      return { l: p.l, w: p.w, h: round2(t.h + 0.2 * r.normal()), weight: round2(t.weight * (1 + 0.002 * r.normal())) };
    });
  }
  return scans;
}

// One carrier inspection of a shipment's true units, optionally with an error.
function measure(units, r, mode) {
  let m = units.map((u) => ({
    l: u.l + (r() < 0.15 ? 1 : 0), w: u.w + (r() < 0.15 ? 1 : 0), h: Math.ceil(u.h + 0.25 * r.normal()), weight: u.weight * (1 + 0.003 * r.normal()),
  }));
  if (mode === 'highpoint') {
    const k = Math.floor(r() * m.length); m[k] = { ...m[k], h: m[k].h + 1 + Math.floor(r() * 7) };
  } else if (mode === 'overhang') {
    const dl = 2 + Math.floor(r() * 3), dw = r() < 0.5 ? 0 : 2 + Math.floor(r() * 3);
    m = m.map((u) => ({ ...u, l: u.l + dl, w: u.w + dw }));
  } else if (mode === 'scale') {
    const f = 1.04 + r() * 0.22; m = m.map((u) => ({ ...u, weight: u.weight * f }));
  } else if (mode === 'count') {
    const big = m.reduce((a, b) => (cubeFt3(b.l, b.w, b.h) > cubeFt3(a.l, a.w, a.h) ? b : a));
    m = [...m, { ...big, weight: 0 }];
  }
  const weight = Math.round(m.reduce((a, u) => a + u.weight, 0));
  const cube = m.reduce((a, u) => a + cubeFt3(u.l, u.w, u.h), 0);
  return { units: m, weight, cube, density: weight / cube };
}

// Carrier bills the inspected weight if it beats the BOL by > 1% and the
// inspected class if it is worse than the declared class.
function bill(bol, meas) {
  const cls = classForDensity(meas.density);
  const worseCls = classRank(cls) > classRank(bol.cls);
  const heavier = meas.weight > bol.weight * 1.01;
  return {
    adjusted: worseCls || heavier,
    weight: heavier ? meas.weight : bol.weight,
    cls: worseCls ? cls : bol.cls,
    density: meas.density, kind: worseCls && heavier ? 'Reweigh + reclass' : worseCls ? 'Reclass' : 'Reweigh',
  };
}

const MODES = ['highpoint', 'overhang', 'scale', 'count'];
const MODE_LABEL = { highpoint: 'Measured to highest point', overhang: 'Footprint measured with overhang', scale: 'Scale read includes other freight', count: 'Handling-unit count off by one' };

function simulateMonth(r, ctx, monthIdx, seqStart) {
  const { lanes, laneIds, profiles: PROFILES, errScale } = ctx;
  const out = [];
  for (let i = 0; i < MONTH_SHIPMENTS; i++) {
    if (r() > INSPECTION_RATE) continue;
    const nUnits = 1 + Math.floor(r() * r() * 6);
    const unitProfiles = Array.from({ length: nUnits }, () => PROFILES[Math.floor(r() * PROFILES.length)].id);
    const prof = (id) => PROFILES.find((p) => p.id === id);
    const truth = unitProfiles.map((id) => trueUnit(prof(id), r));
    // BOL from master data (nominal profile, no stale correction)
    const bolW = Math.round(unitProfiles.reduce((a, id) => a + prof(id).wt, 0));
    const bolCube = unitProfiles.reduce((a, id) => a + cubeFt3(prof(id).l, prof(id).w, prof(id).h), 0);
    const bol = { weight: bolW, density: bolW / bolCube, cls: classForDensity(bolW / bolCube) };
    const ci = Math.floor(r() * CARRIERS.length);
    const [carrier, errRate] = CARRIERS[ci];
    const mode = r() < errRate * errScale ? MODES[Math.floor(r() * MODES.length)] : null;
    const rs = r(); // shared draw so accurate and actual measurements match except for the error
    const meas = measure(truth, rng(Math.floor(rs * 2 ** 31)), mode);
    const acc = measure(truth, rng(Math.floor(rs * 2 ** 31)), null);
    const billed = bill(bol, meas);
    if (!billed.adjusted) continue;
    const lane = laneIds[Math.floor(r() * laneIds.length)];
    const accBill = bill(bol, acc);
    const L = lanes[lane];
    const billedTotal = rateShipment({ weight: billed.weight, cls: billed.cls, ...L }).total;
    const accTotal = rateShipment({ weight: accBill.weight, cls: accBill.cls, ...L }).total;
    const overbilled = round2(billedTotal - accTotal);
    const carrierWrong = !!mode;
    const seq = seqStart + out.length;
    out.push({
      id: 'S' + (113200000 + seq * 37),
      invoice: String(7400000 + seq * 13),
      pro: String(40000000 + seq * 7919).slice(0, 9),
      cert: 'WI-' + (880000 + seq * 3),
      month: monthIdx, carrierName: carrier, lane, units: unitProfiles,
      bol,
      carrier_measured: { units: meas.units.map((u) => ({ l: u.l, w: u.w, h: u.h, weight: Math.round(u.weight) })) },
      carrier: { weight: billed.weight, cls: billed.cls, density: round2(billed.density), measuredWeight: meas.weight },
      kind: billed.kind,
      truth: { carrierWrong, mode, modeLabel: mode ? MODE_LABEL[mode] : null, overbilled: carrierWrong ? Math.max(0, overbilled) : 0, accurateCls: accBill.cls, accurateWeight: accBill.weight },
    });
  }
  return out;
}

export function buildWorld(seed) {
  const r = rng(seed);
  const lanes = buildLanes(r);
  const laneIds = Object.keys(lanes);
  const wp = worldProfiles(r, seed);
  const scans = scanProfiles(r, wp.profiles);
  const stats = Object.fromEntries(Object.entries(scans).map(([k, v]) => [k, profileStats(v)]));
  const ctx = { lanes, laneIds, profiles: wp.profiles, errScale: wp.errScale };
  const history = [];
  for (let m = 0; m < HISTORY_MONTHS; m++) history.push(...simulateMonth(r, ctx, m, history.length));
  const open = simulateMonth(r, ctx, HISTORY_MONTHS, 100000);
  return { lanes, scans, stats, history, open, staleShare: wp.staleShare, errScale: wp.errScale };
}

export function calibrationScores(history, stats) {
  // verified-correct adjustments: carrier upheld with inspection evidence
  return history.filter((h) => !h.truth.carrierWrong).map((h) => inspectionScore(h, stats).score);
}

export function evaluate(world, q) {
  const cal = calibrationScores(world.history, world.stats);
  const res = decideBatch({ batch: world.open, stats: world.stats, calScores: cal, lanes: world.lanes, q });
  const ours = selectionQuality(res.rows, (r) => r.decision === 'dispute');
  const all = selectionQuality(res.rows, () => true);
  const ruleAt = (t) => selectionQuality(res.rows, (r) => r.carrier.density < r.bol.density * (1 - t) || r.carrier.weight > r.bol.weight * (1 + t / 2));
  return { ours, all, rule: ruleAt(0.1), rule5: ruleAt(0.05), rule20: ruleAt(0.2), n: res.rows.length, nCal: cal.length };
}

function mean(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

if (process.argv[1] && process.argv[1].endsWith('generate.mjs')) {
  const SEEDS = 200;
  const QS = [0.05, 0.1, 0.2];
  const acc = {};
  for (const q of QS) acc[q] = { ours: [], all: [], rule: [], rule5: [], rule20: [] };
  let nOpen = [], nCal = [];
  for (let s = 1; s <= SEEDS; s++) {
    const w = buildWorld(s);
    for (const q of QS) {
      const e = evaluate(w, q);
      acc[q].ours.push(e.ours); acc[q].all.push(e.all); acc[q].rule.push(e.rule); acc[q].rule5.push(e.rule5); acc[q].rule20.push(e.rule20);
      if (q === 0.1) { nOpen.push(e.n); nCal.push(e.nCal); }
    }
  }
  const summarize = (list) => ({
    fdr: round4(mean(list.map((x) => x.fdp))),
    fdp_p90_across_shippers: round4(quantile(list.map((x) => x.fdp), 0.9)),
    share_of_shippers_fdp_over_20pct: round4(list.filter((x) => x.fdp > 0.2).length / list.length),
    dollar_power: round4(mean(list.map((x) => x.dollarPower))),
    disputes_per_month: round2(mean(list.map((x) => x.selected))),
    wrong_disputes_per_month: round2(mean(list.map((x) => x.falseSelected))),
    recovered_per_month: round2(mean(list.map((x) => x.recovered))),
    overbilled_per_month: round2(mean(list.map((x) => x.overbilled))),
  });
  const results = {
    generated_by: 'data/generate.mjs', seeds: SEEDS, months_history: HISTORY_MONTHS,
    open_adjustments_per_month: round2(mean(nOpen)), calibration_size_mean: round2(mean(nCal)),
    by_q: Object.fromEntries(QS.map((q) => [q, {
      reclass_defense: summarize(acc[q].ours), dispute_everything: summarize(acc[q].all),
      rule_5pct: summarize(acc[q].rule5), rule_10pct: summarize(acc[q].rule), rule_20pct: summarize(acc[q].rule20),
    }])),
  };
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(results, null, 2));

  const DEMO_SEED = 1;
  const w = buildWorld(DEMO_SEED);
  const dataset = {
    seed: DEMO_SEED, shipper: 'Northfield Snacks Co.', month: 'October 2026', cert_sourced: CERT_SOURCED,
    profiles: PROFILES, lanes: w.lanes,
    scans: w.scans,
    calibration: calibrationScores(w.history, w.stats).map((x) => Math.round(x * 1e4) / 1e4),
    history_counts: { adjustments: w.history.length, verified_correct: w.history.filter((h) => !h.truth.carrierWrong).length },
    open: w.open,
  };
  writeFileSync(new URL('./dataset.json', import.meta.url), JSON.stringify(dataset));
  console.log(JSON.stringify(results.by_q['0.1'], null, 1), 'open', w.open.length);
}

function quantile(xs, p) { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
function round4(x) { return Math.round(x * 1e4) / 1e4; }
