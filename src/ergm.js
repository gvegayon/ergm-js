/*!
 * ergm.js -- a minimal Exponential Random Graph Model simulator.
 *
 * This is a TEACHING PROTOTYPE, not a fitting/estimation package. It answers
 * one question: given a fixed parameter vector theta, what does the ERGM
 * look like? It does that by Gibbs-sampling one dyad at a time, which is
 * exact and requires no knowledge of the (intractable) normalizing constant.
 *
 * Model
 * -----
 * For a directed graph y on n nodes, an ERGM has density
 *
 *   P(Y = y; theta) = exp(theta . g(y)) / kappa(theta)
 *
 * where g(y) is a vector of "sufficient statistics" (counts of structural
 * features -- edges, homophilous ties, reciprocated ties, ...) and kappa is
 * a sum over every possible graph on n nodes, which is astronomically large
 * and never computed here.
 *
 * The trick that makes simulation possible without kappa: the full
 * conditional distribution of a SINGLE dyad y_ij, holding every other dyad
 * fixed, is just a logistic function of the "change statistic" -- how much
 * g(y) would change if y_ij were toggled on:
 *
 *   P(Y_ij = 1 | Y_-ij) = 1 / (1 + exp(-theta . delta_ij(y)))
 *
 * where delta_ij(y) = g(y with y_ij=1) - g(y with y_ij=0). kappa cancels
 * exactly because it does not depend on y_ij. Repeatedly resampling random
 * dyads this way is a Gibbs sampler whose stationary distribution is the
 * ERGM above (Hunter & Handcock 2006; this is also how ergm's MCMC works
 * under the hood).
 *
 * Usage (browser):
 *   <script src="ergm.js"></script>
 *   <script>
 *     var rng = ERGM.makeRNG(42);
 *     var net = ERGM.bernoulli(40, 5, 0.5, rng);
 *     ERGM.simulate(net, {edges: -2, nodematch: 1.5, mutual: 1}, 5000, rng);
 *   </script>
 *
 * Usage (node):
 *   const ERGM = require('./ergm.js');
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ERGM = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // RNG -- mulberry32, a small, fast, seedable PRNG. Not cryptographic;
  // good enough (and reproducible) for a teaching demo.
  // ---------------------------------------------------------------------
  function makeRNG(seed) {
    let a = (seed >>> 0) || 1;
    return function rng() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------------
  // Net -- a directed, loopless graph on n nodes with a binary node
  // attribute, stored as a flat adjacency matrix for O(1) dyad lookups
  // (all a Gibbs sweep ever needs).
  // ---------------------------------------------------------------------
  function Net(n, opts) {
    opts = opts || {};
    this.n = n;
    this.adj = opts.adj || new Uint8Array(n * n);
    // Binary node covariate used by the `nodematch` term. Defaults to an
    // alternating pattern if not supplied.
    if (opts.attr) {
      this.attr = opts.attr;
    } else {
      this.attr = new Uint8Array(n);
      for (let i = 0; i < n; i++) this.attr[i] = i % 2;
    }
  }

  Net.prototype.has = function (i, j) {
    return this.adj[i * this.n + j] === 1;
  };

  Net.prototype.set = function (i, j, value) {
    this.adj[i * this.n + j] = value ? 1 : 0;
  };

  Net.prototype.clone = function () {
    return new Net(this.n, { adj: this.adj.slice(), attr: this.attr.slice() });
  };

  // Recompute every registered term's statistic from scratch. O(n^2).
  // Used for initialization/reset and for the on-screen readout; the
  // sampler itself never needs this (it only ever needs change statistics).
  Net.prototype.statistics = function (terms) {
    terms = terms || TERMS;
    const out = {};
    for (const name in terms) out[name] = terms[name].stat(this);
    return out;
  };

  // Serialize to graphology's plain-object format, ready for
  // `graph.import(net.toGraphology())`. `layout(i)` returns {x, y} for
  // node i; `nodeAttrs(i)` / `edgeAttrs(i, j)` let callers attach
  // size/color/label.
  Net.prototype.toGraphology = function (layout, nodeAttrs, edgeAttrs) {
    const n = this.n;
    const nodes = [];
    for (let i = 0; i < n; i++) {
      const pos = layout ? layout(i, this) : { x: Math.cos(i), y: Math.sin(i) };
      const extra = nodeAttrs ? nodeAttrs(i, this) : {};
      nodes.push({
        key: String(i),
        attributes: Object.assign({ x: pos.x, y: pos.y, size: 4, label: "" + i }, extra),
      });
    }
    const edges = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || !this.has(i, j)) continue;
        const extra = edgeAttrs ? edgeAttrs(i, j, this) : {};
        edges.push({
          key: i + "->" + j,
          source: String(i),
          target: String(j),
          attributes: Object.assign({ size: 1, type: "arrow" }, extra),
        });
      }
    }
    return {
      attributes: {},
      options: { type: "directed", multi: false, allowSelfLoops: false },
      nodes: nodes,
      edges: edges,
    };
  };

  // ---------------------------------------------------------------------
  // Terms -- each has:
  //   stat(net)        -> current value of the statistic (whole-graph, O(n^2))
  //   delta(net, i, j)  -> how the statistic changes if y_ij is turned ON
  //
  // IMPORTANT: delta(net, i, j) must depend only on the REST of the graph
  // (everything except y_ij itself), never on the current value of y_ij.
  // That is what lets a single delta() serve both directions of a Gibbs
  // step: whether we are proposing to add the tie (currently 0) or remove
  // it (currently 1), delta_ij tells us the same thing -- the marginal
  // contribution of that one directed tie to the statistic. `mutual` is
  // the clearest example: it looks at y_ji (the reverse tie), never at
  // y_ij.
  // ---------------------------------------------------------------------
  const TERMS = {
    // Number of directed ties. Governs overall density.
    edges: {
      stat: function (net) {
        let s = 0;
        for (let k = 0; k < net.adj.length; k++) s += net.adj[k];
        return s;
      },
      delta: function () {
        return 1;
      },
    },

    // Number of ties where the two endpoints share the binary attribute
    // (homophily). Positive theta makes within-group ties more likely
    // relative to cross-group ties.
    nodematch: {
      stat: function (net) {
        let s = 0;
        const n = net.n;
        for (let i = 0; i < n; i++)
          for (let j = 0; j < n; j++)
            if (i !== j && net.has(i, j) && net.attr[i] === net.attr[j]) s++;
        return s;
      },
      delta: function (net, i, j) {
        return net.attr[i] === net.attr[j] ? 1 : 0;
      },
    },

    // Number of reciprocated (mutual) dyads: pairs where both y_ij and
    // y_ji are present. Positive theta rewards reciprocity.
    mutual: {
      stat: function (net) {
        let s = 0;
        const n = net.n;
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++)
            if (net.has(i, j) && net.has(j, i)) s++;
        return s;
      },
      delta: function (net, i, j) {
        // Adding y_ij creates a new mutual dyad exactly when the reverse
        // tie y_ji is already present. This reads y_ji, never y_ij.
        return net.has(j, i) ? 1 : 0;
      },
    },
  };

  // theta may be a plain object ({edges, nodematch, mutual}) or an array in
  // this order. Read fresh on every call (not cached) because the widget's
  // sliders mutate a single live theta object in place -- a cached lookup
  // would go stale the instant a slider moves mid-run.
  const TERM_ORDER = ["edges", "nodematch", "mutual"];

  function thetaValue(theta, name, idx) {
    const v = Array.isArray(theta) ? theta[idx] : theta[name];
    return v || 0;
  }

  // One Gibbs update on a uniformly random ordered pair (i, j), i != j.
  // Returns a small record describing what happened, so a caller (e.g. the
  // widget) can do an incremental UI update instead of a full redraw.
  function step(net, theta, rng) {
    const n = net.n;
    let i = Math.floor(rng() * n);
    let j = Math.floor(rng() * (n - 1));
    if (j >= i) j++; // uniform i != j without rejection sampling

    let score = 0;
    for (let k = 0; k < TERM_ORDER.length; k++) {
      const name = TERM_ORDER[k];
      const v = thetaValue(theta, name, k);
      if (v) score += v * TERMS[name].delta(net, i, j);
    }
    const p = 1 / (1 + Math.exp(-score));

    const was = net.has(i, j);
    const on = rng() < p;
    if (on !== was) net.set(i, j, on);

    return { i: i, j: j, p: p, was: was, on: on, changed: on !== was };
  }

  // Run `steps` Gibbs updates. Optional `onStep(record, k)` callback fires
  // after each one (used by the animated widget); returning `false` stops
  // early.
  function simulate(net, theta, steps, rng, onStep) {
    let k = 0;
    for (; k < steps; k++) {
      const rec = step(net, theta, rng);
      if (onStep && onStep(rec, k) === false) {
        k++;
        break;
      }
    }
    return k;
  }

  // Build a simple Bernoulli (Erdos-Renyi-style) random directed graph with
  // the given mean out-degree, i.e. each of the n*(n-1) directed dyads is
  // present independently with probability meanDegree / (n - 1). A binary
  // node attribute is assigned i.i.d. with P(attr = 1) = pGroup (defaults
  // to a balanced 0.5), which is what the `nodematch` term reads.
  function bernoulli(n, meanDegree, pGroup, rng) {
    rng = rng || makeRNG(1);
    pGroup = pGroup === undefined ? 0.5 : pGroup;
    const p = Math.max(0, Math.min(1, meanDegree / Math.max(1, n - 1)));
    const attr = new Uint8Array(n);
    for (let i = 0; i < n; i++) attr[i] = rng() < pGroup ? 1 : 0;
    const net = new Net(n, { attr: attr });
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        if (rng() < p) net.set(i, j, true);
      }
    }
    return net;
  }

  return {
    makeRNG: makeRNG,
    Net: Net,
    TERMS: TERMS,
    TERM_ORDER: TERM_ORDER,
    step: step,
    simulate: simulate,
    bernoulli: bernoulli,
  };
});
