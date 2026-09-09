#!/usr/bin/env node
/*
 * Analytic correctness checks for ergm.js.
 *
 * With the `mutual` term switched off, every directed dyad is conditionally
 * independent of every other one (the full conditional of y_ij depends only
 * on theta and the node attributes, never on the rest of y). That gives us
 * closed-form target probabilities to check the Gibbs sampler against:
 *
 *   P(y_ij = 1) = logistic(theta_edges + theta_nodematch * match_ij)
 *
 * We also check that turning mutual reciprocity on measurably increases the
 * number of mutual dyads relative to a baseline with mutual = 0, holding
 * edges/nodematch fixed -- a directional check, since there is no equally
 * simple closed form once mutual correlates the dyads.
 *
 * Run: node test/selftest.js
 */
const ERGM = require("../src/ergm.js");
const packageInfo = require("../package.json");

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok   " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (detail ? "  (" + detail + ")" : ""));
  }
}

function logistic(x) {
  return 1 / (1 + Math.exp(-x));
}

function burnAndMeasure(n, theta, opts) {
  opts = opts || {};
  const rng = ERGM.makeRNG(opts.seed || 12345);
  const net = ERGM.bernoulli(n, opts.meanDegree || 3, opts.pGroup, rng);
  // Burn-in.
  ERGM.simulate(net, theta, opts.burn || 200000, rng);
  // Measure: average statistics over many post-burn-in samples, thinning
  // between samples so consecutive draws aren't dominated by one dyad.
  const nDyads = n * (n - 1);
  const nSamples = opts.samples || 400;
  const thin = opts.thin || nDyads;
  let edgeSum = 0,
    matchSum = 0,
    mutualSum = 0,
    crossSum = 0;
  let matchDyads = 0,
    crossDyads = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (net.attr[i] === net.attr[j]) matchDyads++;
      else crossDyads++;
    }

  for (let s = 0; s < nSamples; s++) {
    ERGM.simulate(net, theta, thin, rng);
    const st = net.statistics();
    edgeSum += st.edges;
    matchSum += st.nodematch;
    mutualSum += st.mutual;
    crossSum += st.edges - st.nodematch;
  }
  return {
    density: edgeSum / nSamples / nDyads,
    matchRate: matchSum / nSamples / matchDyads,
    crossRate: crossSum / nSamples / crossDyads,
    meanMutual: mutualSum / nSamples,
  };
}

console.log("ergm.js self-test\n");

// --- 0. Public version ------------------------------------------------
console.log("0. public semantic version");
check(
  "ERGM.VERSION matches package.json",
  ERGM.VERSION === packageInfo.version && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(ERGM.VERSION),
  "got " + ERGM.VERSION + " vs " + packageInfo.version
);

// --- 1. Pure density (edges only) -------------------------------------
console.log("1. edges-only -> density matches logistic(theta_edges)");
{
  const theta = { edges: -2, nodematch: 0, mutual: 0 };
  const target = logistic(-2); // 0.1192
  const res = burnAndMeasure(24, theta, { seed: 1 });
  const tol = 0.02;
  check(
    "density ~ " + target.toFixed(3),
    Math.abs(res.density - target) < tol,
    "got " + res.density.toFixed(4)
  );
}

// --- 2. Homophily: within-group vs cross-group tie rates ---------------
console.log("\n2. nodematch -> within-group tie rate > cross-group tie rate");
{
  const theta = { edges: -2, nodematch: 1.5, mutual: 0 };
  const targetWithin = logistic(-2 + 1.5); // 0.3775
  const targetCross = logistic(-2); // 0.1192
  const res = burnAndMeasure(24, theta, { seed: 2, pGroup: 0.5 });
  const tol = 0.03;
  check(
    "within-group rate ~ " + targetWithin.toFixed(3),
    Math.abs(res.matchRate - targetWithin) < tol,
    "got " + res.matchRate.toFixed(4)
  );
  check(
    "cross-group rate ~ " + targetCross.toFixed(3),
    Math.abs(res.crossRate - targetCross) < tol,
    "got " + res.crossRate.toFixed(4)
  );
  check(
    "within-group rate > cross-group rate",
    res.matchRate > res.crossRate,
    res.matchRate.toFixed(4) + " vs " + res.crossRate.toFixed(4)
  );
}

// --- 3. Reciprocity: mutual dyad count rises with theta_mutual ---------
console.log("\n3. mutual -> more reciprocated dyads than a mutual=0 baseline");
{
  const base = burnAndMeasure(24, { edges: -2, nodematch: 0, mutual: 0 }, { seed: 3 });
  const boosted = burnAndMeasure(24, { edges: -2, nodematch: 0, mutual: 2 }, { seed: 3 });
  check(
    "mean mutual dyads: baseline " +
      base.meanMutual.toFixed(2) +
      " < boosted " +
      boosted.meanMutual.toFixed(2),
    boosted.meanMutual > base.meanMutual
  );
  // Sanity: baseline should be close to the independence prediction
  // n(n-1)/2 * p^2 where p = logistic(-2).
  const n = 24;
  const p = logistic(-2);
  const predictedBase = (n * (n - 1) / 2) * p * p;
  check(
    "baseline mutual dyads ~ independence prediction (" + predictedBase.toFixed(2) + ")",
    Math.abs(base.meanMutual - predictedBase) < 1.0,
    "got " + base.meanMutual.toFixed(2)
  );
}

// --- 4. Determinism: same seed -> identical trajectory ------------------
console.log("\n4. same seed -> reproducible simulation");
{
  const rngA = ERGM.makeRNG(7);
  const netA = ERGM.bernoulli(12, 3, 0.5, rngA);
  ERGM.simulate(netA, { edges: -1, nodematch: 1, mutual: 0.5 }, 5000, rngA);

  const rngB = ERGM.makeRNG(7);
  const netB = ERGM.bernoulli(12, 3, 0.5, rngB);
  ERGM.simulate(netB, { edges: -1, nodematch: 1, mutual: 0.5 }, 5000, rngB);

  let identical = netA.adj.length === netB.adj.length;
  if (identical) {
    for (let k = 0; k < netA.adj.length; k++) {
      if (netA.adj[k] !== netB.adj[k]) {
        identical = false;
        break;
      }
    }
  }
  check("adjacency matrices match bit-for-bit", identical);
}

// --- 5. toGraphology() shape sanity -------------------------------------
console.log("\n5. toGraphology() output shape");
{
  const rng = ERGM.makeRNG(9);
  const net = ERGM.bernoulli(6, 2, 0.5, rng);
  const g = net.toGraphology();
  check("options.type === 'directed'", g.options.type === "directed");
  check("6 nodes", g.nodes.length === 6);
  check(
    "edge count matches statistics().edges",
    g.edges.length === net.statistics().edges,
    g.edges.length + " vs " + net.statistics().edges
  );
  const e = g.edges[0];
  check(
    "edge has key/source/target",
    e && typeof e.key === "string" && typeof e.source === "string" && typeof e.target === "string"
  );
}

console.log("\n" + (failures === 0 ? "All checks passed." : failures + " check(s) FAILED."));
process.exit(failures === 0 ? 0 : 1);
