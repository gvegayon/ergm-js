#!/usr/bin/env node
/*
 * End-to-end checks for the two MCMC samplers ("gibbs" and "tnt").
 *
 * The central check enumerates every directed graph on 3 nodes (2^6 = 64),
 * computes the exact ERGM probabilities exp(theta . g(y)) / kappa under a
 * dyad-DEPENDENT model, runs each sampler for a long chain, and requires the
 * empirical distribution of visited graphs to match the exact one in total
 * variation distance. Three nodes is small enough to enumerate but still
 * visits the TNT proposal's edge cases (zero ties, one tie, complete graph).
 *
 * Run: node test/sampler-test.js
 */
const assert = require("assert");
const ERGM = require("../src/ergm.js");

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

// Encode the off-diagonal adjacency as a 6-bit integer, row-major.
function maskOf(net) {
  let mask = 0;
  let bit = 0;
  for (let i = 0; i < net.n; i++) {
    for (let j = 0; j < net.n; j++) {
      if (i === j) continue;
      if (net.has(i, j)) mask |= 1 << bit;
      bit++;
    }
  }
  return mask;
}

function networkFromMask(n, attr, mask) {
  const net = new ERGM.Net(n, { attr: attr });
  let bit = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) net.set(i, j, (mask >>> bit++) & 1);
    }
  }
  return net;
}

function exactDistribution(model, theta, n, attr) {
  const nMasks = 1 << (n * (n - 1));
  const weights = new Float64Array(nMasks);
  let kappa = 0;
  for (let mask = 0; mask < nMasks; mask++) {
    const stats = model.statistics(networkFromMask(n, attr, mask));
    let score = 0;
    for (const id in theta) score += theta[id] * stats[id];
    weights[mask] = Math.exp(score);
    kappa += weights[mask];
  }
  for (let mask = 0; mask < nMasks; mask++) weights[mask] /= kappa;
  return weights;
}

function empiricalDistribution(model, theta, n, attr, steps, seed) {
  const rng = ERGM.makeRNG(seed);
  const net = new ERGM.Net(n, { attr: attr });
  const counts = new Float64Array(1 << (n * (n - 1)));
  model.simulate(net, theta, 5000, rng);
  model.simulate(net, theta, steps, rng, function () {
    counts[maskOf(net)]++;
  });
  for (let k = 0; k < counts.length; k++) counts[k] /= steps;
  return counts;
}

function totalVariation(p, q) {
  let tv = 0;
  for (let k = 0; k < p.length; k++) tv += Math.abs(p[k] - q[k]);
  return tv / 2;
}

console.log("ergm.js sampler tests\n");

// Both samplers target the exact ERGM distribution under a dependent model.
{
  const n = 3;
  const attr = [0, 1, 1];
  const theta = { edges: -0.7, mutual: 1.2, istar2: 0.4, nodematch: 0.5 };
  const specs = ["edges", "mutual", "istar2", "nodematch"];
  const exact = exactDistribution(ERGM.createModel(specs), theta, n, attr);

  ["gibbs", "tnt"].forEach(function (sampler) {
    const model = ERGM.createModel(specs, { sampler: sampler });
    assert.strictEqual(model.sampler, sampler);
    const emp = empiricalDistribution(model, theta, n, attr, 1500000, 11);
    const tv = totalVariation(exact, emp);
    console.log("  " + sampler + ": TV distance to exact = " + tv.toFixed(4));
    assert.ok(tv < 0.015, sampler + " TV distance " + tv);
  });
}

// The same holds for a sparse model, where the TNT proposal ratio is far
// from 1 and a wrong correction would be most visible.
{
  const n = 3;
  const attr = [0, 0, 1];
  const theta = { edges: -2.5, mutual: 2 };
  const specs = ["edges", "mutual"];
  const exact = exactDistribution(ERGM.createModel(specs), theta, n, attr);
  const model = ERGM.createModel(specs, { sampler: "tnt" });
  const tv = totalVariation(exact, empiricalDistribution(model, theta, n, attr, 1500000, 12));
  console.log("  tnt (sparse): TV distance to exact = " + tv.toFixed(4));
  assert.ok(tv < 0.015, "sparse tnt TV distance " + tv);
}

// On a larger dyad-independent model, TNT reproduces the closed-form density
// through the legacy simulate() API.
{
  const n = 30;
  const rng = ERGM.makeRNG(5);
  const net = ERGM.bernoulli(n, 3, 0.5, rng);
  const theta = { edges: -3 };
  const opts = { sampler: "tnt" };
  ERGM.simulate(net, theta, 100000, rng, null, opts);
  let edgeSum = 0;
  const samples = 400;
  for (let s = 0; s < samples; s++) {
    ERGM.simulate(net, theta, n * (n - 1), rng, null, opts);
    edgeSum += net.statistics().edges;
  }
  const density = edgeSum / samples / (n * (n - 1));
  console.log("  tnt density " + density.toFixed(4) + " vs exact " + logistic(-3).toFixed(4));
  assert.ok(Math.abs(density - logistic(-3)) < 0.005);
  assert.strictEqual(net.edgeCount(), net.statistics().edges);
  assert.strictEqual(net.clone().edgeCount(), net.edgeCount());
}

// On a sparse graph TNT changes far more ties per step than Gibbs, which
// mostly re-confirms that empty dyads stay empty.
{
  const theta = { edges: -4, mutual: 1 };
  const changed = {};
  ["gibbs", "tnt"].forEach(function (sampler) {
    const rng = ERGM.makeRNG(21);
    const net = ERGM.bernoulli(50, 1, 0.5, rng);
    ERGM.simulate(net, theta, 50000, rng, null, { sampler: sampler });
    let count = 0;
    ERGM.simulate(
      net,
      theta,
      50000,
      rng,
      function (rec) {
        assert.ok(rec.p >= 0 && rec.p <= 1);
        if (rec.changed) count++;
      },
      { sampler: sampler }
    );
    changed[sampler] = count;
  });
  console.log("  toggles per 50k steps: gibbs " + changed.gibbs + ", tnt " + changed.tnt);
  assert.ok(changed.tnt > 5 * changed.gibbs);
}

// TNT runs are reproducible from a seed, and the default stays Gibbs.
{
  function run() {
    const rng = ERGM.makeRNG(7);
    const net = ERGM.bernoulli(12, 3, 0.5, rng);
    ERGM.simulate(net, { edges: -1, mutual: 0.5 }, 5000, rng, null, { sampler: "tnt" });
    return Array.from(net.adj);
  }
  assert.deepStrictEqual(run(), run());
  assert.strictEqual(ERGM.createModel(["edges"]).sampler, "gibbs");
  assert.deepStrictEqual(ERGM.SAMPLERS, ["gibbs", "tnt"]);
}

// Unknown samplers are rejected.
{
  const net = new ERGM.Net(3);
  const rng = ERGM.makeRNG(1);
  assert.throws(() => ERGM.createModel(["edges"], { sampler: "mh" }), /Unknown ERGM sampler "mh"/);
  assert.throws(() => ERGM.step(net, {}, rng, { sampler: "TNT" }), /Unknown ERGM sampler/);
  assert.throws(() => ERGM.simulate(net, {}, 1, rng, null, { sampler: 1 }), /Unknown ERGM sampler/);
}

console.log("\nAll checks passed.");
