# West of England Road Collision Observatory

A local, static web application for exploring reported road injury collisions across **Bristol, Bath & North East Somerset, South Gloucestershire and North Somerset**. It supports regional road-safety evidence work and is designed to accept future KRN and SATN corridor layers.

The map represents **reported STATS19 personal-injury collisions**, not every incident on the road network. Collision concentrations are frequency measures, **not exposure-adjusted risk** or proof that a road is intrinsically unsafe.

## Install and run

Use Node.js 22.12+ or 24 LTS and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Processed regional data is included, so a first run does not require downloading national source files. The application and collision data run locally; background map tiles require an internet connection.

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

The production build is a static `dist/` directory. No application backend, API key or database is required.

## Publish to GitHub Pages

The public build is published at [awjreynolds.github.io/weca-collision-map](https://awjreynolds.github.io/weca-collision-map/). The repository's [Pages workflow](.github/workflows/pages.yml) runs on pushes to `main` and can also be started manually. It installs with `npm ci`, runs lint, typecheck, tests and the production build, then deploys `dist/` through the official GitHub Pages actions.

Vite is configured for the repository subpath `/weca-collision-map/`; when previewing a production build locally, open the `/weca-collision-map/` path served by `npm run preview`. The application resolves its generated data and boundary assets through Vite's `BASE_URL`, so the same build works from the Pages project path.

## Terminology

A **collision** is an event; a **casualty** is a person injured or killed in it. Collision severity and individual casualty severity are separate fields. Fatal collisions are not a count of fatalities. **KSI casualties** means people killed or seriously injured, never the sum of fatal and serious collision counts. Unknown fields are not zero. See [the domain glossary](CONTEXT.md).

## Data and provenance

The source investigation selected Department for Transport **STATS19** collision, vehicle and casualty records for the latest five complete final years available to this build: **2020–2024**. The original 2021–2025 preference does not justify including partial or unavailable data. The generated manifest is authoritative for the actual included years. The shipped snapshot contains **7,785 mapped collisions** and **9,474 linked casualties**; one further regional collision has no usable coordinates and is excluded from map-based totals. The 2021–2024 files come from DfT; the removed 2020 annual files are retrieved from fixed Internet Archive captures of the original DfT downloads, with URLs recorded in provenance.

The Swift Assist Bristol page was inspected as a functional reference; the application does not depend on its API. Direct DfT ingestion keeps the UI independent from a third-party presentation schema. Source files are licensed under the Open Government Licence v3.0. See [the data-source investigation](docs/research/data-source.md) and the in-app provenance panel for source URLs, timestamps and limitations.

The four-authority study area includes North Somerset as requested; it should not be interpreted as a statement about combined-authority membership. Authority membership comes from source council codes, rather than a hand-drawn rectangle.

## Avon and Somerset recording warning

DfT reports recording-system and processing issues following Avon and Somerset's system change during 2022. Its 2023 reporting also warns that collisions may have been misrecorded or not recorded. Completeness and reliability in the affected period may therefore be compromised. Do not interpret apparent changes through 2022–23 as a clean trend or extrapolate forecasts from them. The warning is centralized in metadata and displayed in the application. See [primary-source evidence and interpretation](docs/research/quality-and-method.md).

## Filters and persistent locations

Summary figures cover **all regional records matching the filters**, independent of the current map viewport. Values selected within one filter combine with OR; different filter dimensions combine with AND. Road-user involvement depends on linked source evidence, and unknown values must not silently become negative observations.

Map clusters are only a zoom-dependent display aid. Persistent-location analysis instead uses a configurable ground-distance radius, initially 100m, with a minimum of three collisions across two distinct selected years. It is an exploratory grouping method, not an official assessment of sites or roads. Filtering to one year can correctly produce no persistent locations. Records are sorted by stable collision ID; each first unassigned record anchors a group and absorbs still-unassigned records within the haversine radius. Every member is within the radius of its anchor, but the group diameter can reach twice that radius. Groups are exploratory and order-dependent, with the fixed ID order making a given selection repeatable. See [the method evidence](docs/research/quality-and-method.md) and [verification record](docs/verification.md).

## Architecture and future extensions

The normalized collision/casualty model is independent of source adapters. Ingestion produces local static data; the browser performs filtering and descriptive spatial grouping. Map rendering is separate from domain analysis. This allows KRN/SATN compilers to exchange GeoJSON without sharing the same frontend library.

Future hierarchy: **region → authority → corridor → road segment → junction → collision**. Extension contracts can represent scheme geometry, intervention date and explicit before/after periods, and attach traffic, vehicle-distance, walking or cycling exposure evidence. These contracts do not imply that spatial joins, scheme effects or exposure-adjusted rates have already been implemented.

The responsive Leaflet map in `agentic-krn-compiler` informed the layout and the stack evaluation. See [map technology tradeoffs](docs/decisions/map-stack.md). A stable map instance, efficient point rendering and responsive controls matter more than choosing a framework by default.

## Implementation record

[Clarified build specification](.scratch/observatory/spec.md) · [Wayfinder decision map](.scratch/observatory/map.md)

This repository records the prompt's resolved ambiguities and source decisions alongside the implementation. Raw national downloads, dependencies and build output are excluded from Git.

## Authority boundaries

The optional outline uses the ONS December 2024 Local Authority District BGC product, generalized to 20m and clipped to the coastline. It is for map context, not a precise historical boundary audit. The refresh script selects the four official council codes and requests WGS84 GeoJSON. Its separate [boundary provenance](public/data/boundaries.provenance.json) includes the official query and attribution.

Source: Office for National Statistics licensed under the Open Government Licence v.3.0. Contains OS data © Crown copyright and database right 2024.

## Licensing

Original application source code is released under the [MIT License](LICENSE), copyright (c) 2026 Adam Reynolds. The generated STATS19 records and ONS authority boundaries are upstream data products and keep their own terms: DfT STATS19 and the ONS product are licensed under the Open Government Licence v3.0, and the boundary attribution retains the statement about OS data © Crown copyright and database right 2024. The MIT licence does not replace those upstream data terms.

## Refresh data

```bash
npm run data:refresh
npm run data:validate
```

`npm run data:refresh` also refreshes the authority outlines; use `npm run ingest:boundaries` to refresh those alone. The STATS19 refresh downloads missing national annual files to ignored `data/raw/`, reuses existing cached files, normalizes the four-council subset, joins vehicle/casualty evidence, and regenerates the files under `public/data/`. Allow time and disk space for the national downloads. The archive-backed 2020 sources and live upstream services must be reachable for a fresh download; the committed regional snapshot keeps ordinary application startup independent of those services. Inspect the regenerated provenance and validation counts before committing a refreshed snapshot.

To fetch upstream revisions, move the relevant cached CSVs out of `data/raw/` before rerunning. To extend the period, update the ingestion script’s `YEARS` configuration only after verifying final publication and schema compatibility; the UI reads years from generated data. Per-file provenance includes hashes and local file modification times. Exact retrieval timestamps are recorded for script-managed downloads; they are intentionally unavailable for the pre-existing cache used to create this snapshot.

## Current limitations

Basemap tiles require internet access, and MapLibre requires WebGL. The production JavaScript is about 1.2 MB before compression (358 kB gzip); Vite reports its standard large-chunk advisory. The regional GeoJSON includes linked evidence and is about 10 MB before HTTP compression. Use compression when hosting. Unknown road-user type codes remain unknown: this snapshot has 292 pedestrian, 341 cycle and 368 motorcycle involvement flags not recorded. Casualty severity totals are complete relative to the mapped source records; this does not remove STATS19 under-reporting or the Avon and Somerset quality caveat.
