// Reclass Defense core: density-based NMFC classing, LTL rerating, conformal
// p-values for carrier inspection adjustments, and Benjamini-Hochberg selection.
// Pure functions, no DOM. Used by the browser app, the data script and the tests.

// FCDC standard 13-subprovision density scale, NMFTA Docket 2025-1,
// Disposition Bulletin 1371, effective 19 July 2025. [lower bound pcf, class]
export const NMFC_SCALE = [
  [50, 50], [35, 55], [30, 60], [22.5, 65], [15, 70], [12, 85], [10, 92.5],
  [8, 100], [6, 125], [4, 175], [2, 250], [1, 300], [0, 400],
];

export const CLASS_ORDER = [50, 55, 60, 65, 70, 85, 92.5, 100, 125, 175, 250, 300, 400];

export function classForDensity(pcf) {
  if (!(pcf >= 0) || !Number.isFinite(pcf)) throw new Error('density must be a finite number >= 0');
  for (const [lo, cls] of NMFC_SCALE) if (pcf >= lo) return cls;
  return 400;
}

// Density band [lo, hi) that maps to a class.
export function densityBand(cls) {
  const i = NMFC_SCALE.findIndex(([, c]) => c === cls);
  if (i < 0) throw new Error('class not on the 13-sub density scale: ' + cls);
  const lo = NMFC_SCALE[i][0];
  const hi = i === 0 ? Infinity : NMFC_SCALE[i - 1][0];
  return [lo, hi];
}

export const classRank = (cls) => CLASS_ORDER.indexOf(cls);

// Cubic feet of a handling unit given inches.
export const cubeFt3 = (l, w, h) => (l * w * h) / 1728;

// Shipment density is total weight over total cube of all handling units.
export function shipmentDensity(units) {
  let wt = 0, cu = 0;
  for (const u of units) { wt += u.weight; cu += cubeFt3(u.l, u.w, u.h); }
  if (cu <= 0) throw new Error('empty cube');
  return wt / cu;
}

// Class rate multipliers relative to class 50 (illustrative tariff shape; the
// demo rates are synthetic, the density scale above is the real NMFC table).
export const CLASS_MULT = {
  50: 1.0, 55: 1.08, 60: 1.16, 65: 1.24, 70: 1.33, 85: 1.52, 92.5: 1.63,
  100: 1.77, 125: 2.13, 175: 2.82, 250: 3.86, 300: 4.56, 400: 5.76,
};

// Rate an LTL shipment: tariff CWT for class 50 on the lane, carrier discount,
// absolute minimum charge, fuel surcharge on the discounted linehaul.
export function rateShipment({ weight, cls, base50, discount, minCharge, fsc }) {
  const cwt = base50 * CLASS_MULT[cls];
  if (cwt === undefined || Number.isNaN(cwt)) throw new Error('unknown class ' + cls);
  const gross = (weight / 100) * cwt;
  const linehaul = Math.max(minCharge, gross * (1 - discount));
  const fuel = linehaul * fsc;
  return { linehaul: round2(linehaul), fuel: round2(fuel), total: round2(linehaul + fuel) };
}

export const round2 = (x) => Math.round(x * 100) / 100;

// Robust per-profile statistics from the shipper's own dimensioner scans.
export function profileStats(scans) {
  if (!scans.length) throw new Error('no scans');
  const lw = scans.map((s) => Math.log(s.weight));
  const ld = scans.map((s) => Math.log(s.weight / cubeFt3(s.l, s.w, s.h)));
  const lc = scans.map((s) => Math.log(cubeFt3(s.l, s.w, s.h)));
  return {
    n: scans.length,
    mw: median(lw), sw: Math.max(robustSd(lw), 0.004),
    md: median(ld), sd: Math.max(robustSd(ld), 0.008),
    mc: median(lc), sc: Math.max(robustSd(lc), 0.006),
    mh: median(scans.map((s) => s.h)), sh: Math.max(robustSd(scans.map((s) => s.h)), 0.25),
    l: median(scans.map((s) => s.l)), w: median(scans.map((s) => s.w)),
    densities: scans.map((s) => s.weight / cubeFt3(s.l, s.w, s.h)).sort((a, b) => a - b),
  };
}

export function median(xs) {
  const a = [...xs].sort((x, y) => x - y), n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// 1.4826 * MAD, a consistent robust estimate of sigma under normality.
export function robustSd(xs) {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

// Expected shipment weight and density (log scale) with uncertainty, from the
// handling units' profiles. Units are independent; delta method on the sums.
export function expectedShipment(unitProfiles, stats) {
  let W = 0, C = 0, vW = 0, vC = 0;
  for (const pid of unitProfiles) {
    const s = stats[pid];
    if (!s) throw new Error('unknown profile ' + pid);
    const w = Math.exp(s.mw), c = Math.exp(s.mc);
    W += w; C += c; vW += (w * s.sw) ** 2; vC += (c * s.sc) ** 2;
  }
  const sdLogW = Math.sqrt(vW) / W;
  const sdLogC = Math.sqrt(vC) / C;
  return {
    weight: W, cube: C, density: W / C,
    sdLogW, sdLogD: Math.sqrt(sdLogW ** 2 + sdLogC ** 2),
  };
}

// Optimal assignment of the carrier's measured handling units to the BOL's
// handling units (minimum total squared height and footprint z-scores). Exhaustive over
// permutations for up to 7 units (cost also penalizes footprint mismatch), which covers LTL shipments; greedy beyond.
export function assignUnits(profileIds, measured, stats) {
  const n = profileIds.length;
  const cost = (i, j) => {
    const s = stats[profileIds[i]], m = measured[j];
    const z = (m.h - 0.5 - s.mh) / Math.hypot(s.sh, 0.35);
    const f = (Math.abs(m.l - s.l) + Math.abs(m.w - s.w)) / 0.6;
    return z * z + f * f;
  };
  if (n > 7) {
    const used = new Set(), perm = [];
    for (let i = 0; i < n; i++) {
      let best = -1, bc = Infinity;
      for (let j = 0; j < n; j++) if (!used.has(j) && cost(i, j) < bc) { bc = cost(i, j); best = j; }
      used.add(best); perm.push(best);
    }
    return perm;
  }
  let best = null, bestCost = Infinity;
  const perm = [], used = new Array(n).fill(false);
  (function rec(i, acc) {
    if (acc >= bestCost) return;
    if (i === n) { bestCost = acc; best = [...perm]; return; }
    for (let j = 0; j < n; j++) if (!used[j]) {
      used[j] = true; perm.push(j); rec(i + 1, acc + cost(i, j)); perm.pop(); used[j] = false;
    }
  })(0, 0);
  return best;
}

export const COUNT_MISMATCH_SCORE = 99;

// Nonconformity score of a carrier inspection: the largest standardized
// residual between what the carrier measured and what the shipper's own scans
// predict, over (a) shipment density (low = worse class), (b) shipment weight
// (high), (c) each matched unit's height (taller), (d) each unit's footprint
// (bigger), and (e) handling-unit count. Larger = less plausible for an
// accurate inspection. Every component is one-sided toward overbilling.
export function inspectionScore(adj, stats, floor = 0.012) {
  const e = expectedShipment(adj.units, stats);
  const zD = (Math.log(e.density) - Math.log(adj.carrier.density)) / Math.hypot(e.sdLogD, floor);
  const zW = (Math.log(adj.carrier.weight) - Math.log(e.weight)) / Math.hypot(e.sdLogW, floor);
  const measured = adj.carrier_measured ? adj.carrier_measured.units : null;
  let zH = -Infinity, zF = -Infinity, perm = null, countMismatch = false;
  if (measured) {
    if (measured.length !== adj.units.length) countMismatch = true;
    else {
      perm = assignUnits(adj.units, measured, stats);
      adj.units.forEach((pid, i) => {
        const s = stats[pid], m = measured[perm[i]];
        zH = Math.max(zH, (m.h - 0.5 - s.mh) / Math.hypot(s.sh, 0.35));
        zF = Math.max(zF, (m.l - s.l) / 0.6, (m.w - s.w) / 0.6);
      });
    }
  }
  const score = countMismatch ? COUNT_MISMATCH_SCORE : Math.max(zD, zW, zH, zF);
  const parts = { density: zD, weight: zW, height: zH, footprint: zF };
  const driver = countMismatch ? 'count' : Object.entries(parts).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return { score, zD, zW, zH, zF, countMismatch, driver, perm, expected: e };
}

// Split-conformal p-value (Vovk; Bates et al. 2023, "Testing for outliers with
// conformal p-values"): rank of the test score among calibration scores of
// verified-correct inspections. Super-uniform under exchangeability.
export function conformalPValue(score, calSortedAsc) {
  // count of calibration scores >= score via binary search
  let lo = 0, hi = calSortedAsc.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (calSortedAsc[mid] < score) lo = mid + 1; else hi = mid; }
  const ge = calSortedAsc.length - lo;
  return (1 + ge) / (calSortedAsc.length + 1);
}

// Benjamini-Hochberg step-up. Returns {selected:Set(indices), threshold}.
export function benjaminiHochberg(pvals, q) {
  const m = pvals.length;
  const order = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let k = 0;
  for (let r = 1; r <= m; r++) if (order[r - 1][0] <= (q * r) / m) k = r;
  const selected = new Set(order.slice(0, k).map(([, i]) => i));
  return { selected, k, threshold: k ? (q * k) / m : 0 };
}

// What the shipper should have been billed vs what the carrier billed.
export function rerate(adj, lane) {
  const billed = rateShipment({ weight: adj.carrier.weight, cls: adj.carrier.cls, ...lane });
  const expected = rateShipment({ weight: adj.bol.weight, cls: adj.bol.cls, ...lane });
  return { billed, expected, delta: round2(billed.total - expected.total) };
}

// Full decision pass over an open batch of inspection adjustments.
export function decideBatch({ batch, stats, calScores, lanes, q }) {
  const cal = [...calScores].sort((a, b) => a - b);
  const rows = batch.map((adj) => {
    const s = inspectionScore(adj, stats);
    const p = conformalPValue(s.score, cal);
    const r = rerate(adj, lanes[adj.lane]);
    const expCls = classForDensity(s.expected.density);
    return { ...adj, score: s.score, zD: s.zD, zW: s.zW, zH: s.zH, zF: s.zF, driver: s.driver, perm: s.perm, countMismatch: s.countMismatch, expected: s.expected, expectedCls: expCls, p, rerate: r };
  });
  const bh = benjaminiHochberg(rows.map((r) => r.p), q);
  rows.forEach((r, i) => { r.decision = bh.selected.has(i) ? 'dispute' : 'accept'; });
  const disputed = rows.filter((r) => r.decision === 'dispute');
  return {
    rows, k: bh.k, threshold: bh.threshold, q,
    disputeAmount: round2(disputed.reduce((a, r) => a + r.rerate.delta, 0)),
    totalAmount: round2(rows.reduce((a, r) => a + r.rerate.delta, 0)),
  };
}

// Probability that an accurate carrier inspection of one handling unit of this
// profile lands in a worse (higher) class than declared, using the empirical
// distribution of the shipper's own scans with a height change (what-if) and
// carrier measurement rounding (heights rounded up to the next inch).
export function reclassRisk(stats, scans, declaredCls, heightDeltaIn = 0) {
  let bad = 0;
  for (const s of scans) {
    const h = Math.ceil(s.h + heightDeltaIn - 1e-9);
    const d = s.weight / cubeFt3(s.l, s.w, Math.max(1, h));
    if (classRank(classForDensity(d)) > classRank(declaredCls)) bad++;
  }
  return bad / scans.length;
}

// Empirical FDP and power for a selection, given ground truth flags.
export function selectionQuality(rows, isSelected) {
  let sel = 0, falseSel = 0, wrongTotal = 0, wrongCaught = 0;
  for (const r of rows) {
    const s = isSelected(r);
    if (s) { sel++; if (!r.truth.carrierWrong) falseSel++; }
    if (r.truth.carrierWrong) { wrongTotal += r.truth.overbilled; if (s) wrongCaught += r.truth.overbilled; }
  }
  return {
    selected: sel, falseSelected: falseSel,
    fdp: sel ? falseSel / sel : 0,
    dollarPower: wrongTotal ? wrongCaught / wrongTotal : 1,
    recovered: round2(wrongCaught), overbilled: round2(wrongTotal),
  };
}

// Seeded PRNG (mulberry32) and Gaussian, shared by the data script and tests.
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.normal = () => {
    const u = Math.max(next(), 1e-12), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return next;
}

// Predictive distribution of the shipment's density from the shipper's own
// scans: resample one scan per handling unit (seeded, deterministic). Used for
// the expected-range column and the evidence chart.
export function predictiveDensities(unitProfiles, scans, n = 400, seed = 1) {
  const r = rng(seed);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let wt = 0, cu = 0;
    for (const pid of unitProfiles) {
      const list = scans[pid];
      const s = list[Math.floor(r() * list.length)];
      wt += s.weight; cu += cubeFt3(s.l, s.w, s.h);
    }
    out[i] = wt / cu;
  }
  return out.sort((a, b) => a - b);
}

export function quantileSorted(a, p) {
  const x = (a.length - 1) * p, i = Math.floor(x), f = x - i;
  return i + 1 < a.length ? a[i] * (1 - f) + a[i + 1] * f : a[i];
}

export function hashSeed(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
