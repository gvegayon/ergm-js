# ERGM term implementation contract

This document freezes the JavaScript semantics for the directed terms requested
in issue #4. The reference is Barry's `network.hpp` at commit
`8447b2321a97ab1460e62534617933efff72dd01`. Later implementation issues should
translate these formulas directly rather than infer behavior from a term name.

## Common convention

The network is directed and loopless. Write `y[a,b]` for an indicator that the
tie `a -> b` is present. For a candidate tie `i -> j`, every `delta(net, i, j)`
must compute

```text
stat(y with y[i,j] = 1) - stat(y with y[i,j] = 0)
```

without reading the current value of `y[i,j]`. Let `out_i` and `in_j` denote
the out-degree of `i` and in-degree of `j` with the candidate cell excluded.
All sums over a third vertex `k` exclude `i` and `j`.

Parameterized model entries use `{ term, id, ...parameters }`. The `id` is the
theta-object key and statistics-output key. Theta arrays follow model order.

## Structural and degree terms

| Term | Whole-network statistic | Change for adding `i -> j` |
|---|---|---|
| `isolates` | Number of vertices with total in-degree plus out-degree zero | `-1` if `i` is isolated without the candidate, minus `1` if `j` is isolated without the candidate |
| `istar2` | `sum_v choose(indegree(v), 2)` | `in_j` |
| `ostar2` | `sum_v choose(outdegree(v), 2)` | `out_i` |
| `density` | `edges / (n * (n - 1))`, or zero when `n < 2` | `1 / (n * (n - 1))`, or zero when `n < 2` |
| `idegree15` | `sum_v indegree(v)^1.5` | `(in_j + 1)^1.5 - in_j^1.5` |
| `odegree15` | `sum_v outdegree(v)^1.5` | `(out_i + 1)^1.5 - out_i^1.5` |
| `idegree(d)` | Number of vertices with in-degree exactly `d` | `I(in_j + 1 = d) - I(in_j = d)` |
| `odegree(d)` | Number of vertices with out-degree exactly `d` | `I(out_i + 1 = d) - I(out_i = d)` |

`density` is a scalar multiple of `edges`, so a model containing both is not
identifiable even though both terms are supported.

## Attribute terms

Let `x` be `net.attrs[attr]`, and let `alpha` default to one.

| Term | Per-tie contribution and change statistic |
|---|---|
| `absdiff` | `abs(x[i] - x[j])^alpha` |
| `diff` | `(s * (x[i] - x[j]))^alpha`, where `s = 1` when `tailHead` is true and `s = -1` otherwise |
| `nodeicov` | Receiver value `x[j]` |
| `nodeocov` | Sender value `x[i]` |
| `nodecov` | `x[i] + x[j]` |
| parameterized `nodematch` | `I(x[i] = x[j])` |

The whole-network statistic is the sum of the per-tie contribution over all
present directed ties. Attribute indexes must exist; vectors must have length
`n` and contain finite numbers. `absdiff` uses a positive finite exponent.
`diff` uses a positive integer exponent so a signed difference always remains
real-valued. `tailHead` must be boolean.

## Directed triads

The transitive-triad statistic is

```text
sum over distinct ordered (a,b,c) of y[a,b] * y[a,c] * y[b,c]
```

Each transitive orientation is counted once. Its change statistic is

```text
sum_k (
  y[i,k] * y[j,k] +
  y[i,k] * y[k,j] +
  y[k,i] * y[k,j]
)
```

The cyclical-triad statistic is the number of directed 3-cycles, counting the
two orientations on a vertex triple separately but not counting the three
rotations separately:

```text
(1 / 3) * sum over distinct ordered (a,b,c) of
  y[a,b] * y[b,c] * y[c,a]
```

Its change statistic is

```text
sum_k y[j,k] * y[k,i]
```

## Minimum hand fixtures

Use vertices `0, 1, 2` unless stated otherwise.

- Empty graph: `isolates = 3`; all other listed structural statistics are zero.
- Out-star `0->1, 0->2`: `ostar2 = 1`, `istar2 = 0`, `density = 2/6`,
  `odegree15 = 2^1.5`, `idegree15 = 2`, `odegree(0) = 2`, and
  `idegree(1) = 2`.
- In-star `1->0, 2->0`: `istar2 = 1` and `ostar2 = 0`.
- Transitive triple `0->1, 0->2, 1->2`: `ttriads = 1` and `ctriads = 0`.
- Cycle `0->1, 1->2, 2->0`: `ctriads = 1` and `ttriads = 0`.
- With `x = [1, 3, 6]` and ties `0->1, 2->1`: `absdiff(alpha=1) = 5`,
  `diff(alpha=1, tailHead=true) = 1`, `nodeicov = 6`, `nodeocov = 7`,
  `nodecov = 13`, and `nodematch = 0`.

In addition to these fixtures, exhaust all loopless directed graphs through
`n = 4` and test the stat/change identity for both current states of each
candidate tie.

## Explicit exclusions

- Barry's `degree(d)` is undirected-only and is not part of this directed API.
- Counters from `network-css.hpp` require stacked true/perceived networks and
  are outside the `Net` data model.
