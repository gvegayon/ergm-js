# Vendored dependencies

Both files here are vendored (not fetched from a CDN at runtime), so the demo
works fully offline and can be embedded in a build with
`embed-resources: true` (Quarto/reveal.js) without a network round-trip at
render time.

| file | package | version | source |
|---|---|---|---|
| `graphology.umd.min.js` | [graphology](https://www.npmjs.com/package/graphology) | 0.26.0 | `dist/graphology.umd.min.js`, exposes `window.graphology` |
| `sigma.min.js` | [sigma](https://www.npmjs.com/package/sigma) | 3.0.3 | `dist/sigma.min.js`, exposes `window.Sigma` |

To refresh (or change versions):

```bash
curl -sSLo vendor/graphology.umd.min.js https://cdn.jsdelivr.net/npm/graphology@0.26.0/dist/graphology.umd.min.js
curl -sSLo vendor/sigma.min.js https://cdn.jsdelivr.net/npm/sigma@3.0.3/dist/sigma.min.js
```

Both are MIT licensed. See their respective npm pages for full license text.
