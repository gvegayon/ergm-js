# Releasing ergm-js

Releases go to npm as [`ergm-js`](https://www.npmjs.com/package/ergm-js);
jsDelivr and unpkg then serve them, e.g.
`https://cdn.jsdelivr.net/npm/ergm-js/src/ergm.js`.

## When to bump

[please-bump](https://github.com/gvegayon/please-bump) checks every PR
(`.github/please-bump.yaml`). A PR that changes what ships (`src/`, `vendor/`,
`index.html`, `package.json`) must bump the version once the version on `main`
has been released (has a GitHub release). Bump both `version` in
`package.json` and `VERSION` in `src/ergm.js`; the publish workflow fails if
they differ.

## Regular releases

1. Bump the version in a PR and merge it.
2. Tag the merge commit and push the tag:

   ```sh
   git tag v0.2.1 && git push origin v0.2.1
   ```

`.github/workflows/publish.yml` checks that the tag matches the version, runs
`npm test`, publishes with npm's trusted publishing (no token; the package
gets a provenance statement) and creates the GitHub release for the tag. A
version that is already on npm is not published again.

## One-time setup (done once, by the npm owner)

1. Check the name is free (`npm view ergm-js`), preview the tarball with
   `npm pack --dry-run`, then publish the first version by hand:

   ```sh
   npm login
   npm publish --provenance=false   # provenance only works from CI
   ```

2. On npmjs.com, open the package's **Settings -> Trusted publishing** and add
   a GitHub Actions publisher: user `gvegayon`, repository `ergm-js`,
   workflow `publish.yml`, environment `npm`. Create the `npm` environment in
   the repository's settings too.
3. Push the tag for that version; the workflow runs the tests, skips the
   publish (already on npm) and creates the GitHub release. Later tags publish
   on their own.
