# Verification — 8 September 2026

## Automated acceptance

The final source passed:

- `npm run lint` — clean.
- `npm run typecheck` — application, configuration and ingestion scripts checked.
- `npm test` — 26 tests across ingestion, GeoJSON normalization, filtering/summaries, viewport totals and spatial grouping.
- `npm run build` — successful static production build.
- STATS19 ingestion followed by `npm run data:validate` — successful regeneration and 8,033 unique collision IDs for 2021–2025.
- `git diff --check` — clean.

Vite emits a bundle-size advisory: JavaScript is 1,290.14 kB uncompressed / 358.49 kB gzip, principally including MapLibre. It is not a build failure. The stack evaluation records this tradeoff; the threshold has not been hidden or raised.

## Real-data checks

The generated snapshot contains 8,033 mapped collisions for 2021–2025: 91 fatal, 1,295 serious and 6,647 slight. Its 9,731 linked casualty records contain 97 fatalities and 1,396 seriously injured casualties, or 1,493 KSI casualties. All collision/casualty/vehicle child joins are complete and child keys unique. All regional collision rows in this window have usable coordinates.

Unknown type classifications remain distinct from absent involvement: 344 pedestrian, 407 cycle and 435 motorcycle flags are null. This does not erase known casualty severities. The 2022–23 recording warning remains visible independently of filters.

The refreshed manifest records direct DfT retrieval URLs, per-file SHA-256 hashes,
byte sizes, source and regional row counts, and local file modification times.
Exact retrieval time is unknown for the initial pre-existing cache and is not
invented; newly downloaded files record their local timestamp separately from
generation time. The optional boundary snapshot remains four unique ONS
authority features in WGS84.

## Spatial reference comparison

An independent brute-force haversine implementation produced exactly the same member-ID sets as the optimized 100m grouping on all 8,033 records (806 groups; 528ms for the comparison):

| Radius | Persistent groups | Optimized grouping time |
| --- | ---: | ---: |
| 50m | 679 | 18.2ms |
| 100m | 806 | 11.1ms |
| 200m | 841 | 10.1ms |
| 500m | 570 | 7.9ms |

Timings are single runs on the development machine, not cross-device performance guarantees. The grouping is independent of pan/zoom; each group's representative coordinate is its fixed anchor. Regression tests cover the near-radius candidate-cell edge and prevent transitive chain merging.

## Running-browser acceptance

The actual production build was checked in the Codex in-app browser using `npm run preview` at `http://localhost:4174/`:

- Full regional points, screen-space clusters, official outlines and severity styles render.
- Cluster selection expands the map; individual collision popups show available source facts safely. A checked B4040 record showed 2021-11-13, fatal, South Gloucestershire, 50mph, one casualty and motorcycle involvement.
- 2024 alone gives 1,637 collisions; 2024 + Bristol + cycle involvement gives 244. These agree with independent parsing of the generated GeoJSON.
- Cycle involvement “Not recorded” gives 407, preserving unknowns instead of counting them as negative.
- One selected year yields no persistent groups, as required by the two-year threshold.
- Selecting a ranked location immediately after a regional reset focuses the location near Bristol's Old Market. A subsequent year filter preserves that local map extent and updates points.
- The persistent overlay can be toggled independently; selecting a ranking enables it.
- At 390×844, the map canvas is 375×473 CSS pixels, appears before longer panels, and the document has no horizontal overflow. Desktop uses a constrained map viewport and independently scrolling sidebar.
- Provenance displays the 2021–2025 source years, licence, generated date, direct DfT source files and ONS boundary attribution.
- No production-origin console errors were recorded during the final interaction sequence.

MapLibre receives only coordinates, ID and severity for collision rendering; full linked evidence remains in the application data for inspection. Basemap tiles depend on internet connectivity and rendering requires WebGL. No separate physical-phone or assistive-technology audit was performed.

## Review

Astra at Low effort reviewed supplied source snapshots; Luna at Max implemented and corrected the findings. The final application source review found no remaining issues among its seven prior findings. Further browser checks identified and verified the fix for post-load focus scheduling. Boundary type/timestamp findings and ingestion unknown/duplicate/road-code/coverage findings were fixed and covered by focused checks. See [review scope](review.md).
