import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classForDensity, densityBand, NMFC_SCALE, cubeFt3, shipmentDensity, rateShipment, profileStats,
  conformalPValue, benjaminiHochberg, assignUnits, inspectionScore, decideBatch, reclassRisk, rng,
  COUNT_MISMATCH_SCORE, rerate,
} from '../src/core.js';
import { buildWorld, calibrationScores, evaluate } from '../data/generate.mjs';

test('NMFC 13-sub scale: band edges map to the published classes', () => {
  // Disposition Bulletin 1371: <1 -> 400, 1 -> 300, 2 -> 250, ... 50+ -> 50
  const expect = [[0.5, 400], [1, 300], [1.99, 300], [2, 250], [4, 175], [6, 125], [8, 100], [10, 92.5],
    [12, 85], [15, 70], [22.49, 70], [22.5, 65], [30, 60], [35, 55], [49.9, 55], [50, 50], [300, 50]];
  for (const [d, c] of expect) assert.equal(classForDensity(d), c, `density ${d}`);
  assert.equal(NMFC_SCALE.length, 13);
});

test('classForDensity rejects invalid input', () => {
  assert.throws(() => classForDensity(-1));
  assert.throws(() => classForDensity(NaN));
});

test('densityBand inverts classForDensity on random densities (property)', () => {
  const r = rng(42);
  for (let i = 0; i < 2000; i++) {
    const d = r() * 70;
    const [lo, hi] = densityBand(classForDensity(d));
    assert.ok(d >= lo && d < hi, `${d} not in [${lo}, ${hi})`);
  }
});

test('cube and shipment density on a 48x40x48 pallet of 640 lb = 12 pcf', () => {
  assert.equal(cubeFt3(48, 40, 48), 53.333333333333336);
  assert.ok(Math.abs(shipmentDensity([{ l: 48, w: 40, h: 48, weight: 640 }]) - 12) < 1e-9);
});

test('rating is monotone in class and respects the minimum charge', () => {
  const lane = { base50: 40, discount: 0.72, minCharge: 125, fsc: 0.3 };
  const a = rateShipment({ weight: 1200, cls: 70, ...lane });
  const b = rateShipment({ weight: 1200, cls: 100, ...lane });
  assert.ok(b.total > a.total);
  const tiny = rateShipment({ weight: 50, cls: 50, ...lane });
  assert.equal(tiny.linehaul, 125);
  assert.equal(tiny.total, 162.5);
});

test('profileStats uses robust spread: one wild scan does not move the median height', () => {
  const scans = Array.from({ length: 40 }, (_, i) => ({ l: 48, w: 40, h: 60 + (i % 5) * 0.2, weight: 800 }));
  const s1 = profileStats(scans);
  const s2 = profileStats([...scans, { l: 48, w: 40, h: 96, weight: 800 }]);
  assert.ok(Math.abs(s1.mh - s2.mh) < 0.21);
  assert.ok(s2.sh < 1);
});

test('conformal p-value matches its rank definition', () => {
  const cal = [0.1, 0.5, 1, 2, 3].sort((a, b) => a - b);
  assert.equal(conformalPValue(2, cal), (1 + 2) / 6);
  assert.equal(conformalPValue(10, cal), 1 / 6);
  assert.equal(conformalPValue(-5, cal), 1);
});

test('conformal p-values are super-uniform for exchangeable nulls (randomized)', () => {
  const r = rng(7);
  let hits = 0, trials = 4000;
  for (let t = 0; t < trials; t++) {
    const cal = Array.from({ length: 99 }, () => r.normal()).sort((a, b) => a - b);
    if (conformalPValue(r.normal(), cal) <= 0.1) hits++;
  }
  // P(p <= 0.1) = 10/100 exactly in theory; allow binomial noise
  assert.ok(hits / trials <= 0.1 + 3 * Math.sqrt(0.09 / trials), `rate ${hits / trials}`);
});

test('Benjamini-Hochberg step-up picks the largest k with p(k) <= qk/m', () => {
  const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
  const { selected, k } = benjaminiHochberg(p, 0.05);
  assert.equal(k, 2);
  assert.deepEqual([...selected].sort(), [0, 1]);
  assert.equal(benjaminiHochberg([0.5, 0.9], 0.1).k, 0);
});

test('BH controls FDR on simulated mixtures (randomized property)', () => {
  const r = rng(11);
  let fdpSum = 0; const reps = 300;
  for (let t = 0; t < reps; t++) {
    const m = 60, nulls = 45;
    const p = Array.from({ length: m }, (_, i) => (i < nulls ? r() : r() * 0.002));
    const { selected } = benjaminiHochberg(p, 0.1);
    const fp = [...selected].filter((i) => i < nulls).length;
    fdpSum += selected.size ? fp / selected.size : 0;
  }
  assert.ok(fdpSum / reps <= 0.1, `FDR ${fdpSum / reps}`);
});

test('assignUnits finds the optimal matching of measured units to BOL units', () => {
  const stats = { A: { mh: 48, sh: 1, l: 48, w: 40 }, B: { mh: 70, sh: 1, l: 48, w: 40 } };
  const perm = assignUnits(['A', 'B', 'A'], [{ h: 71, l: 48, w: 40 }, { h: 49, l: 48, w: 40 }, { h: 48, l: 48, w: 40 }], stats);
  assert.equal(perm[1], 0);
  assert.deepEqual([perm[0], perm[2]].sort(), [1, 2]);
});

test('inspection score flags a count mismatch and an inflated height', () => {
  const r = rng(3);
  const scans = Array.from({ length: 120 }, () => ({ l: 48, w: 40, h: 60 + r.normal(), weight: 800 * (1 + 0.02 * r.normal()) }));
  const stats = { P: profileStats(scans) };
  const units = [{ l: 48, w: 40, h: 61, weight: 800 }];
  const base = { units: ['P'], carrier: { weight: 800, density: shipmentDensity(units) }, carrier_measured: { units } };
  const ok = inspectionScore(base, stats);
  assert.ok(ok.score < 3, `accurate score ${ok.score}`);
  const tall = [{ l: 48, w: 40, h: 68, weight: 800 }];
  const bad = inspectionScore({ ...base, carrier: { weight: 800, density: shipmentDensity(tall) }, carrier_measured: { units: tall } }, stats);
  assert.ok(bad.score > 5 && ['height', 'density'].includes(bad.driver), bad.driver);
  const extra = inspectionScore({ ...base, carrier_measured: { units: [...units, units[0]] } }, stats);
  assert.equal(extra.score, COUNT_MISMATCH_SCORE);
});

test('reclassRisk falls when pallets get shorter (what-if monotonicity)', () => {
  const r = rng(5);
  const scans = Array.from({ length: 200 }, () => ({ l: 48, w: 40, h: 60 + 1.2 * r.normal(), weight: 640 }));
  const stats = profileStats(scans);
  const r0 = reclassRisk(stats, scans, 85, 0), r2 = reclassRisk(stats, scans, 85, -2), r4 = reclassRisk(stats, scans, 85, -4);
  assert.ok(r0 >= r2 && r2 >= r4, `${r0} ${r2} ${r4}`);
});

test('rerate delta equals billed minus expected', () => {
  const lane = { base50: 35, discount: 0.7, minCharge: 120, fsc: 0.32 };
  const adj = { carrier: { weight: 1500, cls: 100 }, bol: { weight: 1450, cls: 85 } };
  const r = rerate(adj, lane);
  assert.equal(r.delta, Math.round((r.billed.total - r.expected.total) * 100) / 100);
  assert.ok(r.delta > 0);
});

test('decision pass on the committed demo month matches dataset and stays under target on truth', () => {
  const ds = JSON.parse(readFileSync(new URL('../data/dataset.json', import.meta.url)));
  const stats = Object.fromEntries(Object.entries(ds.scans).map(([k, v]) => [k, profileStats(v)]));
  const w = buildWorld(ds.seed);
  const cal = calibrationScores(w.history, w.stats);
  assert.equal(cal.length, ds.calibration.length);
  const res = decideBatch({ batch: ds.open, stats, calScores: ds.calibration, lanes: ds.lanes, q: 0.1 });
  assert.equal(res.rows.length, ds.open.length);
  assert.ok(res.k > 0);
  const disputed = res.rows.filter((r) => r.decision === 'dispute');
  const wrong = disputed.filter((r) => !r.truth.carrierWrong).length;
  assert.ok(wrong / disputed.length <= 0.25);
});

test('headline numbers in results.json reproduce from the generator (seeds 1-200, q=0.1)', () => {
  const res = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
  const h = res.by_q['0.1'];
  let fdp = 0, pow = 0, rfdp = 0;
  for (let s = 1; s <= res.seeds; s++) {
    const e = evaluate(buildWorld(s), 0.1);
    fdp += e.ours.fdp; pow += e.ours.dollarPower; rfdp += e.rule.fdp;
  }
  assert.equal(Math.round((fdp / res.seeds) * 1e4) / 1e4, h.reclass_defense.fdr);
  assert.equal(Math.round((pow / res.seeds) * 1e4) / 1e4, h.reclass_defense.dollar_power);
  assert.equal(Math.round((rfdp / res.seeds) * 1e4) / 1e4, h.rule_10pct.fdr);
  // the guarantee: average false-dispute rate at or below the 10% target
  assert.ok(h.reclass_defense.fdr <= 0.1);
});

test('predictive density range brackets the profile median and is deterministic', async () => {
  const { predictiveDensities, quantileSorted } = await import('../src/core.js');
  const r = rng(9);
  const scans = { P: Array.from({ length: 150 }, () => ({ l: 48, w: 40, h: 60 + r.normal(), weight: 800 * (1 + 0.02 * r.normal()) })) };
  const a = predictiveDensities(['P', 'P'], scans, 300, 5), b = predictiveDensities(['P', 'P'], scans, 300, 5);
  assert.deepEqual(a, b);
  const med = 1600 / (2 * cubeFt3(48, 40, 60));
  assert.ok(quantileSorted(a, 0.05) < med && med < quantileSorted(a, 0.95));
});
