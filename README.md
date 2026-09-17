# ergm-js

A small, dependency-light JavaScript simulator for **Exponential Random Graph
Models (ERGMs)**, built for teaching and for slides. Drop it into a static
site or a reveal.js/Quarto presentation to show, live, how an ERGM generates
networks -- density, homophily, and reciprocity all visibly reacting to their
parameters.

**This is a prototype, not an estimation package.** It simulates from a
*given* parameter vector theta; it does not fit theta to data, does not
compute standard errors, and implements exactly three model terms. For real
ERGM fitting, see [`ergm`](https://cran.r-project.org/package=ergm) (R) or
[`ergmito`](https://github.com/USCCANA/ergmito) for small/pooled networks.

[**Live demo**](https://gvegayon.github.io/ergm-js/)

## Quick start

Four `<script>` tags, one `<div>`, one call:

```html
<div id="demo"></div>

<script src="vendor/graphology.umd.min.js"></script>
<script src="vendor/sigma.min.js"></script>
<script src="src/ergm.js"></script>
<script src="src/ergm-widget.js"></script>
<script>
  ERGMWidget.mount(document.getElementById("demo"), {
    n: 40,
    meanDegree: 4,
    model: ["edges", "nodematch", "mutual"],
    theta: { edges: -2.5, nodematch: 1.5, mutual: 1 },
  });
</script>
```

Open `index.html` locally to see it running (no build step):

```bash
python3 -m http.server -d ergm-js 8000
# then open http://localhost:8000
```

## GitHub Pages

Deployed by [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on
every push to `main` (Settings &rarr; Pages &rarr; Source: **GitHub
Actions**). No build step -- the workflow uploads the repo root as-is;
`.nojekyll` at the root tells Pages to serve it verbatim instead of running
it through Jekyll. `index.html` at the root lands at
`https://<user>.github.io/<repo>/`.

## The model

An ERGM assigns a directed graph **y** on *n* nodes the probability

```
P(Y = y; theta) = exp(theta . g(y)) / kappa(theta)
```

where `g(y)` is a vector of **sufficient statistics** -- counts of structural
features of the graph -- and `kappa(theta)` is a sum over *every possible
graph on n nodes*, which is astronomically large and never computed here (or,
generally, anywhere).

The three terms implemented:

| term | statistic `g(y)` | reads as |
|---|---|---|
| `edges` | number of directed ties | overall density |
| `nodematch` | ties where both endpoints share a binary attribute | homophily |
| `mutual` | reciprocated dyads (both `y_ij` and `y_ji` present) | reciprocity |

Reciprocity only makes sense on a *directed* graph, so the demo network is
one-mode and directed throughout.

### Why simulation doesn't need `kappa`

You never need `kappa(theta)` to *simulate* from this model, only to
*evaluate* its density exactly. The **full conditional** of a single dyad
`y_ij`, holding every other dyad fixed, is a plain logistic function of the
**change statistic** -- how much `g(y)` would change if `y_ij` were switched
on:

```
P(Y_ij = 1 | Y_-ij) = 1 / (1 + exp(-theta . delta_ij(y)))

delta_ij(y) = g(y with y_ij = 1) - g(y with y_ij = 0)
```

`kappa` cancels exactly, because it doesn't depend on the one dyad you're
resampling. Repeating this over random dyads is a Gibbs sampler whose
stationary distribution is the ERGM above (Hunter & Handcock 2006) -- and
it's how MCMC-based ERGM fitting works under the hood, minus the fitting.

The simulation loop, in full:

```
initialize y as a Bernoulli random graph with the target mean degree
repeat many times:
    pick a random ordered pair (i, j), i != j
    compute delta_ij(y) for every term
    p = logistic(theta . delta_ij(y))
    set y_ij = 1 with probability p, else 0
```

Change statistics for the three terms:

| term | `delta_ij(y)` (effect of turning `y_ij` on) |
|---|---|
| `edges` | `1` |
| `nodematch` | `1` if `attr[i] == attr[j]` else `0` |
| `mutual` | `1` if `y_ji` is already present else `0` |

Note `delta_ij` never looks at `y_ij` itself -- only at the rest of the graph
(`mutual` reads the *reverse* tie `y_ji`). That's what lets one `delta()`
serve both directions of the Gibbs step, whether you're proposing to add a
currently-absent tie or considering removing a present one.

## API (`src/ergm.js`)

Loads as `window.ERGM` in a browser, or via `require("./ergm.js")` in Node.
No dependencies.

```js
ERGM.makeRNG(seed)
// -> a seeded PRNG function `() => number in [0, 1)` (mulberry32).
//    Deterministic: same seed -> same simulation, every time.

ERGM.VERSION
// -> the current semantic version string, e.g. "0.2.1".

ERGM.Net(n, { attr, rng })
// -> a directed, loopless graph on n nodes.
//    attr:  Uint8Array(n) binary node covariate (default: alternating 0/1).
//    .has(i, j)              -> boolean
//    .set(i, j, value)       -> void
//    .clone()                -> deep copy
//    .statistics(terms?)     -> { edges, nodematch, mutual }
//    .toGraphology(layout?, nodeAttrs?, edgeAttrs?) -> graphology-shaped object

ERGM.bernoulli(n, meanDegree, pGroup, rng)
// -> a Net where every directed dyad is present i.i.d. with probability
//    meanDegree / (n - 1), and each node's binary attribute is drawn i.i.d.
//    with P(attr = 1) = pGroup (default 0.5).

ERGM.step(net, theta, rng)
// -> one Gibbs update on a random dyad. theta is {edges, nodematch, mutual}
//    (or an array in that order). Returns
//    { i, j, p, was, on, changed } describing what happened -- `changed`
//    is false when the proposal left the tie as it was.
//    theta is read fresh on every call, so mutating it between calls
//    (e.g. from a live slider) takes effect immediately.

ERGM.simulate(net, theta, steps, rng, onStep?)
// -> runs `steps` Gibbs updates in a row. onStep(record, k), if given,
//    fires after each one and can return `false` to stop early.

ERGM.TERMS
// -> { edges: {stat, delta}, nodematch: {stat, delta}, mutual: {stat, delta} }
//    the term table itself -- see "Adding a term" below.
```

## Data format (graphology / sigma.js)

`net.toGraphology()` returns graphology's plain serialized object, so it
drops straight into `graph.import(...)`:

```js
const net = ERGM.bernoulli(20, 4, 0.5, ERGM.makeRNG(1));
const graph = new graphology.Graph({ type: "directed" });
graph.import(net.toGraphology());

const renderer = new Sigma(graph, document.getElementById("graph-div"));
```

Shape:

```js
{
  attributes: {},
  options: { type: "directed", multi: false, allowSelfLoops: false },
  nodes: [
    { key: "0", attributes: { x, y, size, label, color } },
    ...
  ],
  edges: [
    { key: "0->3", source: "0", target: "3", attributes: { size, color, type: "arrow" } },
    ...
  ],
}
```

`toGraphology(layout, nodeAttrs, edgeAttrs)` takes three optional callbacks
if you want your own node positions or styling:

```js
net.toGraphology(
  (i, net) => ({ x: Math.cos(i), y: Math.sin(i) }),   // layout(i, net)
  (i, net) => ({ color: net.attr[i] ? "#c0491f" : "#00707a" }), // nodeAttrs(i, net)
  (i, j, net) => ({ color: "#999" })                  // edgeAttrs(i, j, net)
);
```

## Widget API (`src/ergm-widget.js`)

Requires `graphology`, `Sigma`, and `ERGM` to already be loaded as globals.

```js
ERGMWidget.mount(el, options)
```

| option | default | meaning |
|---|---|---|
| `n` | `40` | node count -- rebuilds the network as soon as the slider is released or stepped (see "Live sliders" below), no Reset click needed |
| `meanDegree` | `4` | target mean out-degree of the initial Bernoulli graph -- same live-rebuild behavior as `n` |
| `pGroup` | `0.5` | P(node attribute = 1) (applied on Reset) |
| `model` | `["edges", "nodematch", "mutual"]` | ordered list of active ERGM terms; determines which θ sliders are shown |
| `theta` | `{edges: -2.5, nodematch: 1.5, mutual: 1}` | live model parameters for active terms, bound to the sliders |
| `controls` | `{n: true, meanDegree: true}` | show/hide the `n` and initial mean out-degree sliders independently |
| `seed` | `42` | RNG seed, for reproducible runs |
| `stepsPerFrame` | `50` | Gibbs proposals per animation frame while running |
| `height` | `360` | pixel height of the graph pane |
| `layout` | `"force"` | `"force"` (see below) or `"circle"`, the original fixed two-arc layout |
| `groupColors` | `["#00707a", "#c0491f"]` | node fill per attribute group |
| `edgeColorMatch` / `edgeColorCross` | teal / gray | edge color by whether it's homophilous |
| `autoStart` | `false` | start running as soon as the widget becomes visible |

`mount()` returns the widget instance (`toggleRun()`, `stepN(count)` also
callable directly if you want your own buttons).

### Choosing model terms

Pass `model` as a string array to choose the ERGM terms used by one widget.
The array order controls the order of the θ sliders:

```js
ERGMWidget.mount(document.getElementById("demo"), {
  model: ["edges", "mutual"],
  theta: { edges: -2.5, mutual: 1.5 },
  controls: { n: true, meanDegree: false },
});
```

Only active terms receive a slider and contribute to the sampler; a supplied
coefficient for an inactive term is ignored. Omitting `model` retains the
three-term default. Repeated names are deduplicated in first-seen order, so
`["edges", "mutual", "edges"]` is equivalent to `["edges", "mutual"]`.
`model: []` is valid and produces a zero-term model, where every dyad has
conditional tie probability 0.5. `model` must be an array of strings: a
non-array or non-string entry throws `TypeError`, and an unknown term throws
`RangeError` at mount time.

### Live sliders

Every slider takes effect without a separate Reset click. `theta.*` sliders
write straight into the live `theta` object that `step()` reads fresh on
every call, so they act immediately, mid-run. `n` and `meanDegree` rebuild
the network (too expensive to redo on every pixel of a drag), so the numeric
label updates continuously as you drag but the actual rebuild fires on the
browser's `change` event -- release the slider (or press an arrow key, which
fires `input` and `change` together) and the graph updates automatically.
The **Reset** button re-runs the same rebuild on demand, useful if you just
want to rewind to the deterministic starting point at the current settings.

### Layout: `"force"` vs `"circle"`

`"force"` (the default) is a small, dependency-free force-directed
simulation (`ForceLayout` in `ergm-widget.js`): every pair of nodes repels,
every tie pulls its two endpoints together (with reciprocated ties pulling
to a *shorter* target length -- a visual cue for reciprocity, on top of the
double arrowheads sigma already draws), and a weak centering force keeps the
whole thing framed. It ticks once per animation frame -- alongside the Gibbs
sampler, or on its own right after Reset -- and cools down (`alpha` decays)
once positions stop changing much, so it goes idle rather than burning CPU
forever; adding or removing a tie reheats it just enough to resettle around
the change. This is what actually **shows** homophily and reciprocity
structurally: push `theta.nodematch` up and the two groups visibly pull
apart into separate clusters, something a fixed layout can't do.

`"circle"` is the original static layout: nodes ordered by group onto two
arcs, positions fixed for the whole run, so the eye tracks edges
appearing/disappearing rather than nodes moving. Pass `layout: "circle"` to
use it instead.

The widget builds its own DOM (a graph pane + sliders + Run/Step/Reset +
stats readout) inside `el`, and injects a small scoped stylesheet
(`.ergm-widget ...`) once per page -- override any of it from your own CSS,
it just needs to come after.

The graph pane shows a clickable `ergm-js v…` badge, read directly from
`ERGM.VERSION` and linked to the GitHub repository.

## Versioning

The project uses [semantic versioning](https://semver.org/). `package.json`
is the release manifest checked by the `node-package` preset in
[`please-bump`](https://github.com/gvegayon/please-bump); the pull-request
workflow requires a version increase when public source, vendored assets, or
the demo page changes. `ERGM.VERSION` is covered by the self-test and must
match `package.json`, keeping the in-diagram badge synchronized with the
release version.

## Using it in reveal.js / Quarto

The recommended way to use this widget in Quarto (`html`, websites, books,
or `revealjs` decks) is the
[**ergm-quarto**](https://github.com/gvegayon/ergm-quarto) extension:

```bash
quarto add gvegayon/ergm-quarto
```

```markdown
{{< ergm-widget n=60 theta-nodematch=2 height=420 >}}
```

It vendors this library (so `embed-resources: true` and fully offline
rendering both keep working), exposes every widget option as a shortcode
kwarg or a document-level YAML default, adds automatic light/dark theming,
and -- notably for reveal.js -- mounts widgets at `DOMContentLoaded` rather
than via an inline `<script>` next to each `<div>`. reveal.js itself loads
at the *end* of `<body>`, after all slide markup, so an inline script would
run before `window.Reveal` exists and the widget's own lazy-init logic would
take its `IntersectionObserver` fallback instead of its per-slide `Reveal`
branch -- wrong inside a deck, where every slide is already in the DOM. See
the extension's [docs](https://gvegayon.github.io/ergm-quarto/) for the full
reasoning and option reference.

If you'd rather not add the extension, you can still load the four scripts
by hand and call `ERGMWidget.mount()` yourself in an `include-in-header` /
inline-script recipe -- see the widget's own lazy-init handling below for
what that manual route has to work around.

The widget handles four reveal.js-specific issues on its own (whether you
mount it via the extension or by hand):

1. **Lazy init.** Every slide exists in the DOM from page load. The widget
   waits for `Reveal.on('slidechanged')` (falling back to an
   `IntersectionObserver`, then to immediate init if neither is present)
   before constructing the sigma renderer -- building it against a
   hidden/zero-size element produces a broken canvas.
2. **Pause when hidden.** The animation loop stops on slide exit so it
   doesn't burn CPU for the rest of the talk.
3. **Keyboard capture.** Arrow keys / space / page keys on a focused slider
   are stopped from bubbling, so they adjust the slider instead of also
   advancing the deck.
4. **Sizing under reveal's `transform: scale()`.** sigma sizes its canvases
   from `offsetWidth`/`offsetHeight`, which are transform-immune, so this
   works fine as long as the container has an explicit height -- the widget
   sets one by default (`height` option) and calls `renderer.refresh()` on
   slide entry. One residual limitation: sigma maps *mouse* coordinates
   through `getBoundingClientRect()`, which reveal's scaling does distort,
   so hover/drag directly on the canvas will be offset when the deck isn't
   at 1:1 scale. The HTML controls (sliders/buttons) are unaffected; the
   widget doesn't rely on canvas mouse interaction for anything.

## Adding a term

Everything routes through the `TERMS` table in `src/ergm.js`. To add one,
give it a `stat(net)` (whole-graph value, for the readout) and a
`delta(net, i, j)` (change from turning `y_ij` on, reading only the rest of
the graph):

```js
TERMS.triangle = {
  // number of directed 2-paths i -> k -> j that would be "closed" by i -> j
  stat: function (net) {
    let s = 0;
    for (let i = 0; i < net.n; i++)
      for (let j = 0; j < net.n; j++) {
        if (i === j || !net.has(i, j)) continue;
        for (let k = 0; k < net.n; k++)
          if (k !== i && k !== j && net.has(i, k) && net.has(k, j)) s++;
      }
    return s;
  },
  delta: function (net, i, j) {
    let s = 0;
    for (let k = 0; k < net.n; k++)
      if (k !== i && k !== j && net.has(i, k) && net.has(k, j)) s++;
    return s;
  },
};
TERM_ORDER.push("triangle");
```

Then add its slider metadata to `TERM_CONTROLS` in `ergm-widget.js`, and
include it in a widget's `model` array (or drive `theta.triangle`
programmatically). `step()`/`simulate()` need no changes, since they loop
over `TERM_ORDER`.

## Tests

```bash
npm test
# or: node test/selftest.js
```

`test/selftest.js` checks the sampler against closed-form targets: with
`mutual` off, dyads are conditionally independent, so equilibrium tie
probabilities have an exact logistic formula to check against; with `mutual`
on, it checks the mutual-dyad count rises relative to a `mutual = 0`
baseline. It also checks that a fixed seed reproduces an identical run
bit-for-bit, and that `toGraphology()`'s output shape is well-formed.
`test/widget-test.js` checks model normalization, slider selection, optional
setup controls, and validation errors with a lightweight DOM stand-in.

## Vendored dependencies

See [`vendor/README.md`](vendor/README.md) -- graphology 0.26.0 and sigma.js
3.0.3, both MIT licensed, vendored locally so the demo works offline.

## License

MIT -- see [LICENSE.md](LICENSE.md).
