# Vendored Frontend Libraries

Self-hosted third-party libraries served directly to the browser.
No frontend build step exists in this project, so exact pinned builds
live here under version control. Do not edit these files by hand —
replace them wholesale when upgrading and update this table.

| Library | Version | File | Source | License | SHA-256 |
|---|---|---|---|---|---|
| globe.gl | 2.34.4 | `globe.gl/globe.gl.min.js` | https://unpkg.com/globe.gl@2.34.4/dist/globe.gl.min.js | MIT | `46c6a2a9d1faa6097144647c0b1da87df2539570bdb89e05faa5b43a5544c3a3` |
| scrollama | 3.2.0 | `scrollama/scrollama.min.js` | Copied from local `scrollama-main/build/scrollama.min.js` (repo: https://github.com/russellsamora/scrollama) | MIT | `17d8c6db877708006d0f22a42d030b192fa68a721292253ce70a7d85301e7433` |

Downloaded / copied: 2026-07-05

Integrity: hashes computed with `shasum -a 256 <file>` against the committed
files. After any upgrade, recompute and update this column in the same commit
so drift in the vendored bundles is detectable at review time.

## Notes

- **globe.gl** is the full UMD bundle (~1.5 MB, includes Three.js). It
  defines a global `Globe` factory (`globalThis.Globe`) when loaded via
  a script tag. Verified on download: UMD banner `// Version 2.34.4
  globe.gl` and `globalThis.Globe` assignment present.
- **scrollama** is the minified UMD build. It defines a global
  `scrollama` factory (`self.scrollama`). The `scrollama-main/` source
  directory at the repo root is gitignored; this copy under `public/`
  is the one that is committed and served.
- Textures: intentionally none. The design default is a flat `#0d1117`
  sphere, so no earth texture is vendored.
