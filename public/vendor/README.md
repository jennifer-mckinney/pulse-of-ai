# Vendored Frontend Assets

Self-hosted third-party assets served directly to the browser (FR-25: no
CDN, no Google Fonts, no external map or tile services at runtime). No
frontend build step exists in this project, so exact pinned files live here
under version control. Do not edit them by hand. Replace them wholesale when
upgrading and update this table in the same commit.

There are no vendored JavaScript libraries. The globe (`public/js/globe.js`)
is a vanilla Canvas-2D renderer and the scroll story (`public/js/story.js`)
is plain DOM code, so the globe.gl and scrollama bundles vendored for the
superseded 2026-07-05 globe.gl plan were removed on 2026-09-28.

| Asset | Version | File | Source | License | SHA-256 |
|---|---|---|---|---|---|
| world-atlas (land, 110m) | 2.0.2 | `world-atlas/land-110m-geo.json` | https://unpkg.com/world-atlas@2.0.2/land-110m.json (TopoJSON, SHA-256 `ead5f68119c49a9250902e7da303bcb209341bbb8fefe7369a439b48b704658a`), converted to GeoJSON with topojson-client@3.1.0 `feature()` | ISC | `837db91532bb2f632eb822ad1159dbe687316d1e63e931327adcdd0a558f8db6` |
| Space Grotesk | v22 (Google Fonts API, latin subset) | `fonts/space-grotesk/space-grotesk-latin-400.woff2`<br>`fonts/space-grotesk/space-grotesk-latin-500.woff2`<br>`fonts/space-grotesk/space-grotesk-latin-600.woff2`<br>`fonts/space-grotesk/space-grotesk-latin-700.woff2` | https://fonts.gstatic.com/s/spacegrotesk/v22/ via https://gwfh.mranftl.com/api/fonts/space-grotesk | SIL OFL 1.1 | `65fd17fcbd2e2f522940b5f67ead3d23329e02891aa5495e74d11a499c0b0673`<br>`1b1a8131d9edf975d9decee81e2f2bf504812f7a4f498e5500f28a613e22e64c`<br>`685bbbf69fa616df1ef81847c85fc76be097ddfb3468ff2257be54511ab3130f`<br>`35f8aec56cfd5cbfdb03cc68733a54a0b05bb3617ffcd5fd332badc0b045ca55` |
| IBM Plex Mono | v20 (Google Fonts API, latin subset) | `fonts/ibm-plex-mono/ibm-plex-mono-latin-400.woff2`<br>`fonts/ibm-plex-mono/ibm-plex-mono-latin-500.woff2`<br>`fonts/ibm-plex-mono/ibm-plex-mono-latin-600.woff2` | https://fonts.gstatic.com/s/ibmplexmono/v20/ via https://gwfh.mranftl.com/api/fonts/ibm-plex-mono | SIL OFL 1.1 | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7`<br>`01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22`<br>`0d1f0b8d0722224e32e9f28261bdc86c79115be73444ae5eceb73976a1bcdf83` |

Downloaded: 2026-07-05 (world-atlas), 2026-07-06 (fonts). Hashes were
re-verified with `shasum -a 256 <file>` on 2026-09-28 against the committed
files. After any upgrade, recompute them and update this column in the same
commit, so that drift in vendored files shows up at review time.

## Notes

- **world-atlas land geometry** is converted from TopoJSON to GeoJSON
  offline, so no topojson-client ships to the browser. The file is a
  `FeatureCollection` with one `MultiPolygon` feature (125 land polygons).
  `public/js/globe.js` fetches it (`LAND_URL`) and samples it into the dot
  globe's land dots. If the fetch fails, globe.js falls back to a Fibonacci
  dot sphere. To regenerate the file, download the TopoJSON source above,
  run `topojson.feature(topo, topo.objects.land)` with
  topojson-client@3.1.0, and wrap the result in a FeatureCollection.
- **Fonts** (Space Grotesk, IBM Plex Mono) are self-hosted woff2 files
  (latin subset only), so the page never requests fonts.googleapis.com or
  fonts.gstatic.com at runtime. Both families are licensed under the SIL
  Open Font License 1.1, which permits bundling and self-hosting. The
  `@font-face` rules live in `public/styles/main.css` with
  `font-display: swap`.
- The strict CSP (`default-src 'self'`, set in `src/server.js`) depends on
  every asset being here. A new third-party asset must be vendored, never
  linked.
