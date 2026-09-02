/*!
 * ergm-widget.js -- a small interactive front-end for ergm.js, rendered
 * with sigma.js / graphology.
 *
 * Depends on (load these three before this file):
 *   - graphology (window.graphology)
 *   - sigma      (window.Sigma)
 *   - ergm.js    (window.ERGM)
 *
 * Usage:
 *   <div id="demo"></div>
 *   <script>ERGMWidget.mount(document.getElementById("demo"));</script>
 *
 * See README.md for the full option list. This file is intentionally
 * dependency-free beyond the three above -- no framework, no bundler.
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ERGMWidget = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULTS = {
    n: 40,
    meanDegree: 4,
    pGroup: 0.5,
    theta: { edges: -2.5, nodematch: 1.5, mutual: 1 },
    seed: 42,
    stepsPerFrame: 50, // Gibbs proposals per animation frame while running
    height: 360,
    groupColors: ["#00707a", "#c0491f"], // deck $accent / rust
    edgeColorMatch: "#00707a",
    edgeColorCross: "#c9ccd1",
    autoStart: false,
    // "force": a small built-in force-directed simulation (see ForceLayout
    // below) that keeps resettling as ties come and go -- homophily pulls
    // the two groups apart into visible clusters, which the fixed circle
    // layout can't show. "circle": the original static two-arc layout.
    layout: "force",
  };

  // Injected once; every widget instance shares the same stylesheet, scoped
  // under .ergm-widget so a host page's own CSS is left alone. A host page
  // (or the deck's style.scss) can override any of this.
  const CSS = `
.ergm-widget { display: flex; flex-wrap: wrap; gap: 1em; font-family: inherit; }
.ergm-widget .ergm-graph-pane { position: relative; flex: 1 1 320px; min-width: 240px; border: 1px solid #d8dce1; border-radius: 6px; overflow: hidden; background: #fff; }
.ergm-widget .ergm-graph { position: absolute; inset: 0; }
.ergm-widget .ergm-controls { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 0.6em; font-size: 0.85em; }
.ergm-widget .ergm-row { display: flex; flex-direction: column; gap: 0.15em; }
.ergm-widget .ergm-row label { display: flex; justify-content: space-between; gap: 0.5em; }
.ergm-widget .ergm-row input[type="range"] { width: 100%; }
.ergm-widget .ergm-buttons { display: flex; gap: 0.5em; flex-wrap: wrap; }
.ergm-widget .ergm-buttons button { cursor: pointer; padding: 0.35em 0.8em; border-radius: 4px; border: 1px solid #b8bec6; background: #f4f5f7; font-size: 0.95em; }
.ergm-widget .ergm-buttons button:hover { background: #e8eaed; }
.ergm-widget .ergm-buttons button.ergm-primary { background: #00707a; color: #fff; border-color: #00707a; }
/* pre-wrap, not pre: the widget can end up in a narrow flex column (e.g. a
   reveal.js slide's side-by-side layout), and plain "pre" refuses to wrap,
   which forces the whole row wider than its flex-basis and overflows into
   whatever sits next to it. pre-wrap keeps the monospace alignment for text
   that fits and only wraps the rare long line. */
.ergm-widget .ergm-stats { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em; line-height: 1.5; background: #f7f8f9; border: 1px solid #e2e4e8; border-radius: 4px; padding: 0.5em 0.7em; white-space: pre-wrap; word-break: break-word; }
.ergm-widget .ergm-hint { font-size: 0.8em; color: #6b7280; }
`;
  let cssInjected = false;
  function ensureCSS() {
    if (cssInjected || typeof document === "undefined") return;
    const style = document.createElement("style");
    style.setAttribute("data-ergm-widget", "");
    style.textContent = CSS;
    document.head.appendChild(style);
    cssInjected = true;
  }

  function fmtPct(x) {
    return (x * 100).toFixed(1) + "%";
  }

  // Fixed circular layout, nodes ordered by group so each group occupies a
  // contiguous arc with a visible gap between arcs. Positions are computed
  // once at Reset and never move during a run: the viewer's eye tracks
  // edges appearing/disappearing, not nodes drifting, and homophily reads
  // as "chords collapse into the two arcs".
  function circleLayout(net) {
    const n = net.n;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a, b) => net.attr[a] - net.attr[b]);

    // Split the circle into two halves, each shrunk by `gap` on both ends,
    // and spread one group's nodes evenly across each half.
    const gap = 0.35; // radians of dead space between the two arcs, total
    const half = Math.PI - gap;
    const nGroup0 = order.filter((i) => net.attr[i] === 0).length;
    const positions = new Array(n);
    for (let pos = 0; pos < n; pos++) {
      const nodeId = order[pos];
      const inSecondGroup = pos >= nGroup0;
      const groupSize = inSecondGroup ? n - nGroup0 : nGroup0;
      const withinGroupIdx = inSecondGroup ? pos - nGroup0 : pos;
      const t = groupSize > 1 ? withinGroupIdx / (groupSize - 1) : 0.5;
      const arcStart = inSecondGroup ? Math.PI + gap / 2 : gap / 2;
      const a = arcStart + t * half;
      positions[nodeId] = { x: Math.cos(a), y: Math.sin(a) };
    }
    return positions;
  }

  // ---------------------------------------------------------------------
  // ForceLayout -- a small, dependency-free force-directed simulation
  // (Fruchterman-Reingold / d3-force style: pairwise node repulsion + edge
  // springs + weak centering gravity), ticked incrementally so it can keep
  // resettling live as the Gibbs sampler adds and removes ties. O(n^2) per
  // tick, which is fine at this widget's node-count range (<= 120).
  //
  // Unlike circleLayout, this layout actually shows homophily and
  // reciprocity structurally: raise theta_nodematch and the two groups
  // visibly separate into clusters (many within-group springs pulling them
  // together, few cross-group springs pulling them apart); mutual ties are
  // additionally pulled to a shorter target length, so reciprocated pairs
  // sit closer together than one-directional ones.
  // ---------------------------------------------------------------------
  const FORCE = {
    repulsion: 0.35, // Coulomb-like pairwise push-apart strength
    spring: 0.12, // Hooke's-law pull along each tie
    springLength: 0.9, // target length for a one-directional tie
    mutualLengthFactor: 0.55, // reciprocated ties pull to a shorter length
    center: 0.02, // weak gravity toward the origin, keeps the layout framed
    damping: 0.82, // velocity decay per tick
    alphaDecay: 0.985, // "temperature" decay per tick when not reheated
    alphaMin: 0.006, // below this, treat the layout as settled and stop ticking
  };

  function ForceLayout(n) {
    this.n = n;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this._fx = new Float64Array(n);
    this._fy = new Float64Array(n);
    this.alpha = 0;
  }

  // Random initial scatter (a filled disc, not a single point), and full
  // reheat so the first tick() calls actually move things.
  ForceLayout.prototype.seed = function (rng) {
    for (let i = 0; i < this.n; i++) {
      const r = 0.2 + 0.8 * rng();
      const a = rng() * Math.PI * 2;
      this.x[i] = r * Math.cos(a);
      this.y[i] = r * Math.sin(a);
      this.vx[i] = 0;
      this.vy[i] = 0;
    }
    this.alpha = 1;
  };

  // Bump the temperature back up so the layout visibly readjusts -- called
  // whenever a tie is added/removed. Never lowers alpha (a small reheat
  // mid-cooldown shouldn't undo a bigger one still in progress).
  ForceLayout.prototype.reheat = function (amount) {
    this.alpha = Math.max(this.alpha, amount === undefined ? 1 : amount);
  };

  // One simulation step. Returns nothing; read `.alpha` to decide whether
  // to keep ticking.
  ForceLayout.prototype.tick = function (net) {
    const n = this.n;
    const x = this.x,
      y = this.y,
      fx = this._fx,
      fy = this._fy;
    fx.fill(0);
    fy.fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = x[i] - x[j];
        const dy = y[i] - y[j];
        const d2 = dx * dx + dy * dy + 0.01; // epsilon avoids a 1/0 singularity
        const d = Math.sqrt(d2);

        // Repulsion: every pair pushes apart, strength ~ 1/d^2.
        const rep = FORCE.repulsion / d2;
        fx[i] += dx * rep;
        fy[i] += dy * rep;
        fx[j] -= dx * rep;
        fy[j] -= dy * rep;

        // Attraction: only tied pairs pull together, toward a target
        // length (shorter when the tie is reciprocated).
        const fwd = net.has(i, j);
        const rev = net.has(j, i);
        if (fwd || rev) {
          const targetLen = fwd && rev ? FORCE.springLength * FORCE.mutualLengthFactor : FORCE.springLength;
          const spr = (FORCE.spring * (d - targetLen)) / d;
          fx[i] -= dx * spr;
          fy[i] -= dy * spr;
          fx[j] += dx * spr;
          fy[j] += dy * spr;
        }
      }

      // Weak centering gravity so the whole layout doesn't drift away from
      // where sigma's camera was originally framed.
      fx[i] -= x[i] * FORCE.center;
      fy[i] -= y[i] * FORCE.center;
    }

    for (let i = 0; i < n; i++) {
      this.vx[i] = (this.vx[i] + fx[i] * this.alpha) * FORCE.damping;
      this.vy[i] = (this.vy[i] + fy[i] * this.alpha) * FORCE.damping;
      x[i] += this.vx[i];
      y[i] += this.vy[i];
    }

    this.alpha *= FORCE.alphaDecay;
  };

  function Widget(el, opts) {
    ensureCSS();
    this.el = el;
    this.opts = Object.assign({}, DEFAULTS, opts, {
      theta: Object.assign({}, DEFAULTS.theta, (opts && opts.theta) || {}),
    });
    this.running = false;
    this.stepCount = 0;
    this.renderer = null;
    this.graph = null;
    this._rafId = null;
    this._mounted = false;
    this._visible = false;

    this._buildDOM();
    this._reset(); // builds net + graph, but does not start rendering yet
    this._wireLazyInit();
  }

  Widget.prototype._buildDOM = function () {
    const el = this.el;
    el.classList.add("ergm-widget");
    el.innerHTML = "";

    const pane = document.createElement("div");
    pane.className = "ergm-graph-pane";
    pane.style.height = this.opts.height + "px";
    const graphDiv = document.createElement("div");
    graphDiv.className = "ergm-graph";
    pane.appendChild(graphDiv);

    const controls = document.createElement("div");
    controls.className = "ergm-controls";

    const sliders = [
      { key: "theta.edges", label: "θ edges (density)", min: -5, max: 1, step: 0.1 },
      { key: "theta.nodematch", label: "θ nodematch (homophily)", min: -2, max: 4, step: 0.1 },
      { key: "theta.mutual", label: "θ mutual (reciprocity)", min: -2, max: 4, step: 0.1 },
      { key: "n", label: "n (nodes)", min: 20, max: 120, step: 1, resetOnly: true },
      { key: "meanDegree", label: "mean out-degree", min: 1, max: 10, step: 0.5, resetOnly: true },
    ];

    this._inputs = {};
    const self = this;
    sliders.forEach(function (spec) {
      const row = document.createElement("div");
      row.className = "ergm-row";
      const label = document.createElement("label");
      const valueSpan = document.createElement("span");
      label.textContent = spec.label + " ";
      label.appendChild(valueSpan);
      const input = document.createElement("input");
      input.type = "range";
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
      input.value = self._getPath(spec.key);
      valueSpan.textContent = Number(input.value).toFixed(spec.step < 1 ? 1 : 0);

      // theta.* sliders write straight into this.opts.theta, which step()
      // reads fresh on every call -- so they take effect immediately, even
      // mid-run. n / meanDegree rebuild the network, which is too expensive
      // to redo on every 'input' tick while dragging -- the label still
      // updates live, but the actual rebuild waits for 'change' (drag
      // release, or a single keyboard step), so it still happens
      // automatically without a separate Reset click.
      input.addEventListener("input", function () {
        valueSpan.textContent = Number(input.value).toFixed(spec.step < 1 ? 1 : 0);
        self._setPath(spec.key, parseFloat(input.value));
      });
      if (spec.resetOnly) {
        input.addEventListener("change", function () {
          self._reset();
        });
      }

      row.appendChild(label);
      row.appendChild(input);
      controls.appendChild(row);
      this._inputs[spec.key] = { input: input, valueSpan: valueSpan, spec: spec };
    }, this);

    const buttons = document.createElement("div");
    buttons.className = "ergm-buttons";
    const runBtn = document.createElement("button");
    runBtn.className = "ergm-primary";
    runBtn.textContent = "Run";
    runBtn.addEventListener("click", function () {
      self.toggleRun();
    });
    const stepBtn = document.createElement("button");
    stepBtn.textContent = "Step ×100";
    stepBtn.addEventListener("click", function () {
      self.stepN(100);
    });
    const resetBtn = document.createElement("button");
    resetBtn.textContent = "Reset";
    resetBtn.addEventListener("click", function () {
      self._reset();
    });
    buttons.appendChild(runBtn);
    buttons.appendChild(stepBtn);
    buttons.appendChild(resetBtn);
    this._runBtn = runBtn;

    const stats = document.createElement("div");
    stats.className = "ergm-stats";
    stats.textContent = "…";

    const hint = document.createElement("div");
    hint.className = "ergm-hint";
    hint.textContent = "Directed network: reciprocity (θ mutual) needs direction, so this demo is one-mode, not bipartite.";

    controls.appendChild(buttons);
    controls.appendChild(stats);
    controls.appendChild(hint);

    el.appendChild(pane);
    el.appendChild(controls);

    this._graphPane = pane;
    this._graphDiv = graphDiv;
    this._statsEl = stats;

    // Prevent slider/button interaction from also driving reveal.js slide
    // navigation (arrow keys, space, page up/down all advance slides under
    // navigation-mode: linear).
    const capturedKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "PageUp", "PageDown", "Home", "End"];
    el.addEventListener("keydown", function (ev) {
      if (capturedKeys.indexOf(ev.key) !== -1) ev.stopPropagation();
    });
  };

  Widget.prototype._getPath = function (path) {
    const parts = path.split(".");
    let v = this.opts;
    for (const p of parts) v = v[p];
    return v;
  };

  Widget.prototype._setPath = function (path, value) {
    const parts = path.split(".");
    let obj = this.opts;
    for (let k = 0; k < parts.length - 1; k++) obj = obj[parts[k]];
    obj[parts[parts.length - 1]] = value;
  };

  // Build a fresh network from current n / meanDegree / seed, lay it out,
  // and (re)build the graphology + sigma instances. Safe to call whether or
  // not sigma has been constructed yet.
  Widget.prototype._reset = function () {
    this.stepCount = 0;
    this._rng = ERGM.makeRNG(this.opts.seed);
    this.net = ERGM.bernoulli(this.opts.n, this.opts.meanDegree, this.opts.pGroup, this._rng);

    if (this.opts.layout === "circle") {
      this._circlePositions = circleLayout(this.net);
      this._force = null;
    } else {
      // A separate, fixed-offset RNG stream from the sampler's own -- the
      // layout's random seeding has nothing to do with the ERGM trajectory,
      // and keeping them independent means changing one doesn't perturb
      // the other's reproducibility.
      this._force = new ForceLayout(this.net.n);
      this._force.seed(ERGM.makeRNG(((this.opts.seed || 1) * 2654435761) >>> 0));
      this._circlePositions = null;
    }

    const self = this;
    const graphData = this.net.toGraphology(
      function (i) {
        return self.opts.layout === "circle" ? self._circlePositions[i] : { x: self._force.x[i], y: self._force.y[i] };
      },
      function (i, net) {
        return { size: 4, label: "", color: self.opts.groupColors[net.attr[i]] };
      },
      function (i, j, net) {
        const match = net.attr[i] === net.attr[j];
        return { size: 1, type: "arrow", color: match ? self.opts.edgeColorMatch : self.opts.edgeColorCross };
      }
    );

    if (typeof graphology === "undefined") {
      this._statsEl.textContent = "graphology not loaded -- see README.md";
      return;
    }
    const GraphCtor = graphology.Graph || graphology;
    this.graph = new GraphCtor({ type: "directed", multi: false, allowSelfLoops: false });
    this.graph.import(graphData);

    if (this.renderer) this.renderer.setGraph(this.graph);
    if (this._visible) this._ensureRenderer();
    this._updateStats();
    this._ensureLoop(); // let the force layout start settling right away
  };

  // Push the force simulation's current positions into the live graphology
  // graph. sigma listens for these attribute updates and redraws on its own
  // (same mechanism _applyRecord already relies on for edge add/drop).
  Widget.prototype._applyPositions = function () {
    const f = this._force;
    for (let i = 0; i < this.net.n; i++) {
      this.graph.setNodeAttribute(String(i), "x", f.x[i]);
      this.graph.setNodeAttribute(String(i), "y", f.y[i]);
    }
  };

  // Construct the sigma renderer lazily -- only once the widget is actually
  // visible. Constructing sigma on a hidden/zero-size element (every slide
  // is present in the DOM at load in reveal.js) yields a broken canvas.
  Widget.prototype._ensureRenderer = function () {
    if (this.renderer || typeof Sigma === "undefined" || !this.graph) return;
    this.renderer = new Sigma(this.graph, this._graphDiv, {
      renderEdgeLabels: false,
      defaultEdgeType: "arrow",
      minEdgeThickness: 0.5,
      enableEdgeEvents: false,
    });
  };

  // Lazy init + pause-when-hidden, with three fallbacks depending on what
  // the host page provides:
  //   1. reveal.js is present -> hook slidechanged, only touch sigma when
  //      the slide containing this widget is the current one.
  //   2. no reveal.js, but IntersectionObserver exists -> use visibility.
  //   3. neither -> just render immediately (e.g. a plain static page).
  Widget.prototype._wireLazyInit = function () {
    const self = this;

    function show() {
      self._visible = true;
      self._ensureRenderer();
      if (self.renderer) self.renderer.refresh();
      if (self.opts.autoStart && !self.running) self.toggleRun();
      self._ensureLoop(); // resume any layout settling left over from before hide()
    }
    function hide() {
      // Full stop, not just pausing the sampler: cancel the shared rAF
      // outright so neither the sampler nor the layout burns CPU while the
      // widget is off-screen. Simulation state (positions/velocities/alpha)
      // is untouched, so show() picks back up where this left off.
      self._visible = false;
      self.running = false;
      if (self._runBtn) self._runBtn.textContent = "Run";
      if (self._rafId !== null) {
        cancelAnimationFrame(self._rafId);
        self._rafId = null;
      }
    }

    if (typeof Reveal !== "undefined" && Reveal && typeof Reveal.on === "function") {
      const slideEl = this.el.closest ? this.el.closest("section") : null;
      const check = function () {
        const current = Reveal.getCurrentSlide ? Reveal.getCurrentSlide() : null;
        if (slideEl && current === slideEl) show();
        else hide();
      };
      Reveal.on("slidechanged", check);
      Reveal.on("ready", check);
      check();
      return;
    }

    if (typeof IntersectionObserver !== "undefined") {
      const io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) show();
          else hide();
        });
      });
      io.observe(this.el);
      return;
    }

    show();
  };

  Widget.prototype._updateStats = function () {
    const st = this.net.statistics();
    const nDyads = this.net.n * (this.net.n - 1);
    const density = nDyads ? st.edges / nDyads : 0;
    const meanDeg = this.net.n ? st.edges / this.net.n : 0;
    const homophPct = st.edges ? st.nodematch / st.edges : 0;
    const nDyadPairs = (this.net.n * (this.net.n - 1)) / 2;
    const reciprocity = st.edges ? (2 * st.mutual) / st.edges : 0;
    this._statsEl.textContent = [
      "step        " + this.stepCount,
      "edges       " + st.edges,
      "density     " + fmtPct(density),
      "mean degree " + meanDeg.toFixed(2),
      "homophilous " + st.nodematch + " (" + fmtPct(homophPct) + " of ties)",
      "mutual pairs " + st.mutual + " / " + nDyadPairs,
      "reciprocity " + fmtPct(reciprocity),
    ].join("\n");
  };

  // Apply one ERGM Gibbs record to the live graphology graph -- add/drop
  // the single edge that changed rather than rebuilding the whole graph.
  Widget.prototype._applyRecord = function (rec) {
    if (!rec.changed) return;
    // A structural change: nudge the layout back into motion so it
    // resettles around the new tie. A small bump, not a full reheat -- a
    // single flipped dyad shouldn't scatter an otherwise-settled layout.
    if (this._force) this._force.reheat(0.35);
    const key = rec.i + "->" + rec.j;
    if (rec.on) {
      if (!this.graph.hasEdge(key)) {
        const match = this.net.attr[rec.i] === this.net.attr[rec.j];
        this.graph.addEdgeWithKey(key, String(rec.i), String(rec.j), {
          size: 1,
          type: "arrow",
          color: match ? this.opts.edgeColorMatch : this.opts.edgeColorCross,
        });
      }
    } else if (this.graph.hasEdge(key)) {
      this.graph.dropEdge(key);
    }
  };

  Widget.prototype.stepN = function (count) {
    const self = this;
    ERGM.simulate(this.net, this.opts.theta, count, this._rng, function (rec) {
      self._applyRecord(rec);
    });
    this.stepCount += count;
    this._updateStats();
    this._ensureLoop(); // let the layout animate the settle even if Run isn't on
  };

  // A single animation loop drives two independent things, both gated on
  // the widget being visible:
  //   - the Gibbs sampler, while `running` is true (Run/Pause);
  //   - the force layout settling, while it's still "hot" (`alpha` above
  //     threshold) -- which happens after Reset and after any edge change,
  //     regardless of whether the sampler itself is running.
  // The loop reschedules itself only as long as one of those is still
  // doing something, so it goes idle on its own once both are quiet.
  Widget.prototype._loopTick = function () {
    this._rafId = null;
    let needMore = false;

    if (this._force && this._force.alpha > FORCE.alphaMin) {
      this._force.tick(this.net);
      this._applyPositions();
      needMore = true;
    }

    if (this.running) {
      this.stepN(this.opts.stepsPerFrame); // may itself call _ensureLoop(); harmless re-entrant no-op
      needMore = true;
    }

    if (needMore) this._ensureLoop();
  };

  Widget.prototype._ensureLoop = function () {
    if (this._rafId !== null || !this._visible) return;
    const layoutNeedsWork = this._force && this._force.alpha > FORCE.alphaMin;
    if (!this.running && !layoutNeedsWork) return;
    const self = this;
    this._rafId = requestAnimationFrame(function () {
      self._loopTick();
    });
  };

  Widget.prototype.toggleRun = function () {
    if (this.running) {
      this.running = false;
      if (this._runBtn) this._runBtn.textContent = "Run";
      return;
    }
    this.running = true;
    if (this._runBtn) this._runBtn.textContent = "Pause";
    this._ensureLoop();
  };

  function mount(el, opts) {
    return new Widget(el, opts || {});
  }

  return { mount: mount, DEFAULTS: DEFAULTS };
});
