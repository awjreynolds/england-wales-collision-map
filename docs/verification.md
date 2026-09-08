# Verification — 8 September 2026

## Automated acceptance

The final source passed:

- `npm run lint` — clean.
- `npm run typecheck` — application, configuration and ingestion scripts checked.
- `npm test` — 23 tests across ingestion, GeoJSON normalization, filtering/summaries and spatial grouping.
- `npm run build` — successful static production build.
- `npm run data:refresh` followed by `npm run data:validate` — successful regeneration, live ONS boundary refresh and 7,785 unique collision IDs.
- `git diff --check` — clean.

Vite emits a bundle-size advisory: JavaScript is 1,290.14 kB uncompressed / 358.49 kB gzip, principally including MapLibre. It is not a build failure. The stack evaluation records this tradeoff; the threshold has not been hidden or raised.

## Real-data checks

The generated snapshot contains 7,785 mapped collisions for 2020–2024: 87 fatal, 944 serious and 6,754 slight. Its 9,474 linked casualty records contain 91 fatalities and 1,021 seriously injured casualties, or 1,112 KSI casualties. All collision/casualty/vehicle child joins are complete and child keys unique. One further regional collision has unusable coordinates and is explicitly omitted from map-based totals.

Unknown type classifications remain distinct from absent involvement: 292 pedestrian, 341 cycle and 368 motorcycle flags are null. This does not erase known casualty severities. The 2022–23 recording warning remains visible independently of filters.

The collision GeoJSON was byte-identical before and after a full refresh using the cached national CSVs:

```text
SHA-256 ac0be308a641a95812e168baa83eaa1e828107ec4c5b1cb97d9bab3084cec170
```

The refresh also fetched four unique ONS authority boundary features in WGS84. Raw input URLs, hashes, byte sizes and row counts are recorded in generated provenance. Exact retrieval time is unknown for the initial pre-existing cache and is not invented; newly downloaded files record it separately from generation time.

## Spatial reference comparison

An independent brute-force haversine implementation produced exactly the same member-ID sets as the optimized grouping on all 7,785 records:

| Radius | Persistent groups | Optimized grouping time |
| --- | ---: | ---: |
| 50m | 633 | 19.7ms |
| 100m | 750 | 12.5ms |
| 200m | 805 | 14.7ms |
| 500m | 573 | 11.2ms |

Timings are single runs on the development machine, not cross-device performance guarantees. The grouping is independent of pan/zoom; each group's representative coordinate is its fixed anchor. Regression tests cover the near-radius candidate-cell edge and prevent transitive chain merging.

## Running-browser acceptance

The actual production build was checked in the Codex in-app browser using `npm run preview` at `http://localhost:4174/`:

- Full regional points, screen-space clusters, official outlines and severity styles render.
- Cluster selection expands the map; individual collision popups show available source facts safely. A checked B4040 record showed 2021-11-13, fatal, South Gloucestershire, 50mph, one casualty and motorcycle involvement.
- 2024 alone gives 1,637 collisions; 2024 + Bristol + cycle involvement gives 244. These agree with independent parsing of the generated GeoJSON.
- Cycle involvement “Not recorded” gives 341, preserving unknowns instead of counting them as negative.
- One selected year yields no persistent groups, as required by the two-year threshold.
- Selecting a ranked location immediately after a regional reset focuses the location near Bristol's Old Market. A subsequent year filter preserves that local map extent and updates points.
- The persistent overlay can be toggled independently; selecting a ranking enables it.
- At 390×844, the map canvas is 375×473 CSS pixels, appears before longer panels, and the document has no horizontal overflow. Desktop uses a constrained map viewport and independently scrolling sidebar.
- Provenance displays source years, licence, generated date, archival-source limitations and ONS boundary attribution.
- No production-origin console errors were recorded during the final interaction sequence.

MapLibre receives only coordinates, ID and severity for collision rendering; full linked evidence remains in the application data for inspection. Basemap tiles depend on internet connectivity and rendering requires WebGL. No separate physical-phone or assistive-technology audit was performed.

## Review

Astra at Low effort reviewed supplied source snapshots; Luna at Max implemented and corrected the findings. The final application source review found no remaining issues among its seven prior findings. Further browser checks identified and verified the fix for post-load focus scheduling. Boundary type/timestamp findings and ingestion unknown/duplicate/road-code/coverage findings were fixed and covered by focused checks. See [review scope](review.md).
