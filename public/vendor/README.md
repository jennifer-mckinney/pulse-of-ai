# Vendored Frontend Libraries

Self-hosted third-party libraries served directly to the browser.
No frontend build step exists in this project, so exact pinned builds
live here under version control. Do not edit these files by hand —
replace them wholesale when upgrading and update this table.

| Library | Version | File | Source | License | SHA-256 |
|---|---|---|---|---|---|
| globe.gl | 2.34.4 | `globe.gl/globe.gl.min.js` | https://unpkg.com/globe.gl@2.34.4/dist/globe.gl.min.js | MIT | `46c6a2a9d1faa6097144647c0b1da87df2539570bdb89e05faa5b43a5544c3a3` |
| scrollama | 3.2.0 | `scrollama/scrollama.min.js` | Copied from local `scrollama-main/build/scrollama.min.js` (repo: https://github.com/russellsamora/scrollama) | MIT | `17d8c6db877708006d0f22a42d030b192fa68a721292253ce70a7d85301e7433` |
| Space Grotesk | v22 (Google Fonts API, latin subset) | `fonts/space-grotesk/space-grotesk-latin-400.woff2`<br>`fonts/space-grotesk/space-grotesk-latin-500.woff2`<br>`fonts/space-grotesk/space-grotesk-latin-600.woff2`<br>`fonts/space-grotesk/space-grotesk-latin-700.woff2` | https://fonts.gstatic.com/s/spacegrotesk/v22/ via https://gwfh.mranftl.com/api/fonts/space-grotesk | SIL OFL 1.1 | `65fd17fcbd2e2f522940b5f67ead3d23329e02891aa5495e74d11a499c0b0673`<br>`1b1a8131d9edf975d9decee81e2f2bf504812f7a4f498e5500f28a613e22e64c`<br>`685bbbf69fa616df1ef81847c85fc76be097ddfb3468ff2257be54511ab3130f`<br>`35f8aec56cfd5cbfdb03cc68733a54a0b05bb3617ffcd5fd332badc0b045ca55` |
| IBM Plex Mono | v20 (Google Fonts API, latin subset) | `fonts/ibm-plex-mono/ibm-plex-mono-latin-400.woff2`<br>`fonts/ibm-plex-mono/ibm-plex-mono-latin-500.woff2`<br>`fonts/ibm-plex-mono/ibm-plex-mono-latin-600.woff2` | https://fonts.gstatic.com/s/ibmplexmono/v20/ via https://gwfh.mranftl.com/api/fonts/ibm-plex-mono | SIL OFL 1.1 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7`<br>`01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22`<br>`0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83` |

Downloaded / copied: 2026-07-05 (libraries), 2026-07-06 (fonts)

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
- **Fonts** (Space Grotesk, IBM Plex Mono) are self-hosted woff2 files
  (latin subset only) so the page makes no requests to
  fonts.googleapis.com / fonts.gstatic.com at runtime (FR-25). Both
  families are licensed under the SIL Open Font License 1.1, which
  permits bundling and self-hosting. `@font-face` rules live in
  `public/styles/main.css` with `font-display: swap`.
