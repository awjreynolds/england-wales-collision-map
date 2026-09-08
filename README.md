# England & Wales Collision Map

A static React/MapLibre application for exploring reported road injury collisions across **England and Wales**. The national view runs entirely on GitHub Pages: a browser Web Worker reads compressed static data for exact summaries, bounded map results, collision details and explicit persistent-location analysis. A saved West of England preset remains available for **Bristol, Bath & North East Somerset, South Gloucestershire and North Somerset**.

The current national release covers the five complete calendar years **2021–2025**. It contains 493,271 England/Wales source collision rows, 493,218 mappable collision records, 624,985 recorded casualties, 7,264 fatalities, 119,791 serious injuries and 497,930 slight injuries. Fifty-three source collision rows have no valid map coordinate and remain outside map totals. The school catalogue contains 25,936 mapped establishments: 24,471 in England, 1,440 maintained schools in Wales and 25 Welsh pupil referral units. See the [static release verification](docs/static-pages-verification.md) for the current artifact audit and the [national verification record](docs/national-verification.md) for source count and coordinate checks.

The map represents **reported STATS19 personal-injury collisions**, not every incident on the road network. Collision concentrations are frequency measures, **not exposure-adjusted risk** or proof that a road is intrinsically unsafe.

## Architecture and national capabilities

The application and national data are served from the same GitHub Pages project. A compact overview stores spatial cells and filter-specific summaries. A browser Web Worker combines those summaries, loads local collision files when a viewport cuts through a cell or needs individual records, and performs the bounded hotspot analysis without blocking map interaction. Full linked collision, casualty and vehicle evidence is downloaded separately only when a collision is opened.

There is no application API server, Cloudflare dependency, database account or browser access key. The school catalogue is searched locally. Background OpenStreetMap tiles and the explicitly submitted Photon place search remain external services.

Filters within a dimension use OR; different dimensions use AND. A calendar year means the STATS19 `collision_year` field, not a rolling twelve-month period.

The sidebar shows two exact summaries. **Selected national scope** applies the active year, country, authority, severity and road-user filters without a map box. **Current map extent** applies those same filters inside the current map bounding box. Panning, zooming or clicking an aggregate cell requests a new exact viewport result. The map may switch between aggregate cells and individual points to stay within response limits, but it does not infer viewport totals by counting rendered features.

Map markers are grouped for display using their on-screen size, with a minimum six-pixel gap between circle outlines. These display groups retain their underlying records and do not change the exact totals or the persistent-location analysis. Collision counts exclude duplicated hotspot evidence; school and hotspot membership remain separate.

Persistent-location analysis is a separate, user-triggered operation over the complete filtered records in the requested map box. It requires an explicit bounding box, groups repeated collisions around deterministic anchors with a configurable 50m, 100m, 200m or 500m radius, requires at least three collisions spanning two selected calendar years, and refuses more than 10,000 matching records. Harm screens include all groups, at least one KSI collision, repeated KSI collisions and slight-only recorded harm. An edge warning identifies groups close to the analysis boundary; expand the map and rerun before interpreting them. This is an exploratory grouping method, not an official site or road assessment.

School proximity uses straight-line distance from each group anchor to the published point catalogue at 500m and 1km. Coverage percentages use the full set of groups before any school-distance filter is applied, so the denominator remains interpretable. The 80 Welsh independent schools in the official address list without authoritative coordinates are excluded rather than postcode-geocoded; the coverage response and provenance panel disclose that gap. Proximity does not infer routes, attendance, exposure or future KSI probability.

## Install and run

Use Node.js 22.12+ or 24 LTS and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The checked-in static national release is available under `public/data/national/`; no separate server or environment variable is required. Background map tiles require an internet connection.

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run preview
```

The production build is a self-contained static `dist/` directory containing the application, browser worker and compressed data files.

## Publish to GitHub Pages

The public build is published at [awjreynolds.github.io/england-wales-collision-map](https://awjreynolds.github.io/england-wales-collision-map/). The repository's [Pages workflow](.github/workflows/pages.yml) runs on pushes to `main` and can also be started manually. It installs with `npm ci`, runs lint, typecheck, tests and the production build, then deploys `dist/` through the official GitHub Pages actions.

Vite is configured for the repository subpath `/england-wales-collision-map/`; when previewing a production build locally, open the `/england-wales-collision-map/` path served by `npm run preview`. The application resolves its generated data and boundary assets through Vite's `BASE_URL`, so the same build works from the Pages project path.

## Terminology

A **collision** is an event; a **casualty** is a person injured or killed in it. Collision severity and individual casualty severity are separate fields. Fatal collisions are not a count of fatalities. **KSI casualties** means people killed or seriously injured, never the sum of fatal and serious collision counts. Unknown fields are not zero. See [the domain glossary](CONTEXT.md).

## Data and provenance

The national source build reads Department for Transport **STATS19** collision, vehicle and casualty CSVs for 2021–2025. England and Wales are selected from the source authority-code prefixes `E` and `W`; Northern Ireland is outside this release. Collision, casualty and vehicle rows are joined by collision index within each calendar year. Coordinates, nullable classifications, join coverage and excluded rows remain documented in the generated manifest and summary. The deployed manifest is authoritative for the actual included years, counts and quality notices.

School points are built from the current DfE [Get Information about Schools](https://get-information-schools.service.gov.uk/Downloads) catalogue and Welsh Government [DataMapWales](https://datamap.gov.wales/) maintained-school and pupil-referral-unit layers. Welsh independent schools without an authoritative public coordinate are disclosed as a coverage gap rather than geocoded from postcodes. Source URLs, checksums, timestamps, source bundles and output counts are retained in the generated provenance files.

The Swift Assist Bristol page was inspected as a functional reference; the application does not depend on its API. Direct DfT ingestion keeps the UI independent from a third-party presentation schema. Source files are licensed under the Open Government Licence v3.0. See [the data-source investigation](docs/research/data-source.md) and the in-app provenance panel for source URLs, timestamps and limitations.

The four-authority study area includes North Somerset as requested; it should not be interpreted as a statement about combined-authority membership. Authority membership comes from source council codes, rather than a hand-drawn rectangle.

## Avon and Somerset recording warning

DfT reports recording-system and processing issues following Avon and Somerset's system change during 2022. Its 2023 reporting also warns that collisions may have been misrecorded or not recorded. Completeness and reliability in the affected period may therefore be compromised. Do not interpret apparent changes through 2022–23 as a clean trend or extrapolate forecasts from them. The warning is centralized in metadata and displayed in the application. See [primary-source evidence and interpretation](docs/research/quality-and-method.md).

## Filters and persistent locations

Summary figures distinguish the selected national scope from the exact current map viewport. The selected scope applies the active filters without a bounding box; the viewport summary applies the same filters inside the current map extent. Values selected within one filter combine with OR; different filter dimensions combine with AND. A calendar year is the STATS19 `collision_year` value, not a rolling period. Road-user involvement depends on linked source evidence, and unknown values must not silently become negative observations.

The map uses aggregate cells at dense national scales and individual points when the response can remain bounded. Clicking an aggregate cell narrows the map; clicking a point requests its full collision detail. The summary query is independent of rendered features, so viewport counts remain exact.

Map aggregates are a display aid. Persistent-location analysis is an explicit bounded operation over the complete filtered records in the selected map extent. It uses a configurable ground-distance radius of 50m, 100m, 200m or 500m, with a minimum of three collisions across two distinct selected calendar years, a 10,000-record cap and an edge warning. Harm filters can keep all groups, groups with KSI, groups with repeated KSI collisions or groups with slight-only recorded harm. It is an exploratory grouping method, not an official assessment of sites or roads. School proximity at 500m and 1km uses straight-line distance from each group anchor; coverage denominators are calculated before school filtering and the 80-coordinate Welsh independent-school gap is disclosed. See [the method evidence](docs/research/quality-and-method.md), [expansion plan](docs/england-wales-expansion-plan.md), [national verification](docs/national-verification.md) and [verification record](docs/verification.md).

## Architecture and future extensions

The normalized collision/casualty model is independent of source adapters. Ingestion produces canonical local artifacts; the static publisher builds spatial summaries and compressed local files; the browser worker performs filtering and bounded analysis while the map renders points and cells. This keeps national raw data out of the static bundle while preserving a reusable domain model for future KRN/SATN compilers.

Future hierarchy: **region → authority → corridor → road segment → junction → collision**. Extension contracts can represent scheme geometry, intervention date and explicit before/after periods, and attach traffic, vehicle-distance, walking or cycling exposure evidence. These contracts do not imply that spatial joins, scheme effects or exposure-adjusted rates have already been implemented.

The responsive Leaflet map in `agentic-krn-compiler` informed the layout and the stack evaluation. See [map technology tradeoffs](docs/decisions/map-stack.md). A stable map instance, efficient point rendering and responsive controls matter more than choosing a framework by default.

## Implementation record

[Clarified build specification](.scratch/observatory/spec.md) · [Wayfinder decision map](.scratch/observatory/map.md)

This repository records the prompt's resolved ambiguities and source decisions alongside the implementation. Raw national downloads, dependencies and build output are excluded from Git.

## Authority boundaries

The optional outline uses the ONS December 2024 Local Authority District BGC product, generalized to 20m and clipped to the coastline. It is for map context, not a precise historical boundary audit. The refresh script selects the four official council codes and requests WGS84 GeoJSON. Its separate [boundary provenance](public/data/boundaries.provenance.json) includes the official query and attribution.

Source: Office for National Statistics licensed under the Open Government Licence v.3.0. Contains OS data © Crown copyright and database right 2024.

## Licensing

Original application and service source code are released under the [MIT License](LICENSE), copyright (c) 2026 Adam Reynolds. DfT STATS19, DfE GIAS, Welsh Government DataMapWales and ONS authority data are upstream products licensed under the Open Government Licence v3.0, with the boundary attribution retaining the statement about OS data © Crown copyright and database right 2024. The MIT licence applies to this repository's code; it does not replace the upstream data terms.

## Rebuild national, school and regional data

Raw downloads and generated national/school artifacts are ignored by Git. The national builder reuses verified annual files under `data/raw/`, records their hashes in `.national-acquisition.json`, downloads missing files, writes a content-addressed generation under `data/national/generations/` and advances the `data/national/2021-2025/` alias. Set `WECA_NATIONAL_REFRESH=1` when an upstream revision must be fetched again. The school builder retains an immutable source bundle under `data/schools/sources/`; its `active.json` pointer lets a later run use the exact retained inputs offline.

Run the reproducible builders from the repository root:

```bash
# Build the England/Wales STATS19 generation (downloads missing annual inputs).
npm exec tsx scripts/national/build.ts

# Build the DfE/DataMapWales school catalogue and provenance.
npm exec tsx scripts/schools/ingest.ts

# Build the GitHub Pages static release from the canonical artifacts.
npm exec tsx scripts/static/build.ts
```

The national builder asserts its expected regression totals before publishing an active generation. The static publisher reads the canonical collision and school artifacts and emits a versioned manifest, overview, local collision files, school catalogue and compressed detail files. Inspect the generated counts and provenance before publishing a refresh.

The `service/` directory records the earlier Cloudflare implementation. It is not used by the Pages application or deployment workflow. Existing Cloudflare resources are not automatically modified or removed by this repository.

The existing West of England static snapshot has a separate refresh path:

```bash
npm run data:refresh
npm run data:validate
```

`npm run data:refresh` refreshes the regional application snapshot and authority outlines; use `npm run ingest:boundaries` to refresh those outlines alone. It does not replace the national static build. Allow time and disk space for fresh upstream downloads; live source services must be reachable when no retained input bundle is available.

To fetch upstream revisions, set `WECA_NATIONAL_REFRESH=1` for the national builder or remove the relevant cached regional CSVs before rerunning. To extend the period, update the builder's `YEARS` configuration only after verifying final publication and schema compatibility; the UI reads years from generated data. Per-file provenance includes hashes and local file modification times. The national manifest's `generatedAt` records when the normalized snapshot was written.

## Static publication and rollback

Run `node --experimental-strip-types scripts/static/verify.ts` to verify every published file, both compressed and decoded checksums, record coverage and overview totals. Run lint, typecheck, tests and the production build before committing the generated release. The Pages workflow repeats these checks and publishes `dist/` when `main` changes.

The publisher replaces its output only after validating a complete generation. For rollback, restore the previous application and `public/data/national/` release together and republish through Pages. Browser requests include the dataset version and artifact hash so mixed cached generations fail integrity validation rather than returning mismatched evidence.

## Current limitations

Basemap tiles require internet access, and MapLibre requires WebGL. The production JavaScript is about 1.2 MB before compression (358 kB gzip); Vite reports its standard large-chunk advisory. The saved West of England regional GeoJSON includes linked evidence and is about 10 MB before HTTP compression; use compression when hosting. The national view uses bounded map responses and fetches the full joined collision, casualty and vehicle evidence lazily for an individual collision, so that detail corpus is not sent with the initial map payload. Unknown national road-user involvement remains nullable: the active summary reports 5,449 pedestrian, 7,510 cycle and 7,761 motorcycle involvement values as unknown. The school catalogue covers mapped England establishments, maintained Welsh schools and Welsh pupil referral units; 80 Welsh independent schools in the official address list lack authoritative coordinates and are excluded rather than postcode-geocoded. Casualty severity totals are complete relative to the mapped source records; this does not remove STATS19 under-reporting or the Avon and Somerset quality caveat.
