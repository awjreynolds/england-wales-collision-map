# England and Wales collision observatory: proposed expansion

Planning date: 8 September 2026. The user subsequently authorised implementation
and publication. The original proposal is retained below; the implementation
decision and verification status are recorded here and in
[national-verification.md](national-verification.md).

## Implementation decision

The first implementation uses a Cloudflare Worker with an indexed D1 database
and retains GitHub Pages for the frontend. A full local import occupies 403 MB,
including compressed, separately stored collision/vehicle/casualty evidence.
No subscription upgrade is assumed or authorised by this decision.

The initial map API returns bounded GeoJSON aggregate cells rather than vector
tiles. At local zoom it returns compact points if the selection contains at most
2,000 records. Responses are capped at 1 MB; dense selections remain aggregated.
Exact summaries use canonical coordinates independently of the rendered features.
Common national summaries and overview cells are precomputed; full collision
evidence is fetched only when a record is selected.

This simpler delivery mechanism preserves the proposed progressive browsing
behaviour without adding a tile-generation pipeline. Local reference checks
reconcile all eight tested geographic/filter selections. Remote latency, browser
behaviour and release reviews remain acceptance gates; local timings alone do
not establish the proposed network-performance targets.

## Recommendation

Keep React, TypeScript and MapLibre. Replace the full-browser dataset with a small read-only spatial query service backed by PostgreSQL/PostGIS, cached vector map tiles, and on-demand collision details. Keep the frontend static. Download national source files once during a reproducible data build, not once per visitor.

Start with England and Wales and the latest five final calendar years, currently 2021–2025. Treat Great Britain and the UK as separate future scope decisions: DfT STATS19 covers Great Britain; UK coverage would need an additional Northern Ireland source and compatibility assessment.

## Measured starting point

The existing app downloads and parses the complete collision GeoJSON, retains linked vehicle and casualty evidence, filters all records in React, calculates persistent groups on filter changes, and supplies all points to MapLibre for clustering. It works regionally but makes each visitor pay for the whole study area.

The current 8,033-record GeoJSON is 10,884,444 bytes uncompressed. A read-only count of cached annual collision CSVs, selecting ONS local-authority codes beginning E or W, gives:

| Calendar year | England/Wales source collision rows |
| --- | ---: |
| 2021 | 97,185 |
| 2022 | 101,879 |
| 2023 | 100,026 |
| 2024 | 96,760 |
| 2025 | 97,421 |
| Total | 493,271 |

These are source-scope counts before national coordinate validation and reconciliation of missing authority codes. They are not a certified count of mappable features. Straight proportional scaling of the current regional serialization suggests approximately 668 MB uncompressed; this is a sizing estimate, not a generated national artifact or a network benchmark.

## What the visitor experiences

1. Open an England-and-Wales overview with national totals and aggregated collision concentrations. No individual collision records are needed for this view.
2. Search for a town, postcode or authority, or zoom and pan. Load only the tiles covering the map and a small neighbour margin.
3. At local scale, replace aggregate cells with individual collision points. Use feature density and tile-size limits as well as zoom level; central London must remain responsive.
4. Keep two explicit summaries: the selected geography and the visible map area. Both respect the same filters. Display an updating state while a new answer is pending.
5. Click a collision to fetch its full detail, including linked casualty and vehicle evidence. Those records never belong in the initial map payload.
6. Preserve shareable URLs for location, zoom, years, filters and analysis mode. Retain the existing West of England URL as a saved geographic view or redirect with equivalent state.

## Data delivery and calculation

| Product | Delivery | Contents |
| --- | --- | --- |
| Dataset manifest | Small static JSON | Version, final years, extent, source provenance, quality notices |
| National/authority summaries | Precomputed common views; query fallback | Exact collision and casualty counts with completeness indicators |
| Map tiles | Cached vector tiles | Low zoom: filtered aggregate cells; high zoom: compact points with stable IDs |
| Visible-area summary | Read-only query | Exact counts within the requested bounds and active filters |
| Collision detail | Lookup by dataset version and collision ID | Full normalized record and linked evidence |
| Persistent-location analysis | Separate bounded analysis operation | Explicit scope, method, radius and membership |

Use one normalized filter contract across map tiles, statistics, detail eligibility and analysis. Low-zoom tiles must aggregate *after* filtering. Hiding a subset of an already aggregated total would produce incorrect counts. Start with a small number of indexed database queries and a shared predicate builder; do not prebuild every filter combination.

Calculate visible totals from canonical point coordinates, never rendered tiles. Tile borders, buffers, geometry quantization, feature duplication and low-zoom aggregation make rendered features unsuitable for exact statistics. Specify inclusive map edges, missing-coordinate exclusions and unknown involvement semantics. Keep the map north-up and flat initially.

Use spatial indexes for viewport queries and appropriate year/authority indexes. Precompute default national and authority totals. Inspect query plans and benchmark highly selective and all-years queries before choosing database size. Nearly half a million collisions is a candidate for a modest indexed database, but latency and cost must be measured rather than assumed.

Map drawing can progress independently from statistics, but responses carry the dataset version and request/filter key. Cancel obsolete requests and ignore late results. Never show an old result as current after the user changes filters. A capped response must be marked incomplete; do not silently return a partial exact total.

## Responsiveness and bandwidth

- Request statistics after movement settles, initially with a 200–300 ms debounce. Preserve smooth map interaction while requests run.
- Cache immutable tiles by dataset version, normalized filters and tile coordinates. Reuse recently visited tiles; keep a bounded memory cache. Do not round viewport bounds merely to increase cache hits for a result labelled exact.
- Keep point tiles compact: ID, required styling/filter fields and minimal display attributes. Return detailed evidence only on click.
- Keep parsing and heavier local work off the main thread. Avoid creating a React element per collision or replacing the map instance when filters change.
- Load the manifest and shell independently. A statistics or detail error should leave an already loaded map usable, with a clear retry state.
- Use a basemap service whose usage terms and capacity fit a public national map. Preserve attribution and avoid bulk prefetching from the community OSM tile service.

Initial acceptance targets, to be tested on a defined mid-range phone and throttled connection:

| Measure | Proposed release target |
| --- | --- |
| Initial collision-data transfer | Under 1 MB compressed; measure basemap and application bundle separately |
| First useful overview | Under 3 seconds on the agreed test connection |
| Cached statistics response | p95 under 500 ms |
| Uncached ordinary statistics response | p95 under 1.5 seconds |
| Pan/zoom | No full-dataset work on the main thread; no repeated >50 ms stalls attributable to this app |
| Correctness | Exact agreement with reference queries; no double counts at tile edges |

Test London, a sparse Welsh area, the England/Wales border, repeated rapid pan/filter changes, mobile resizing, empty results, and popup selection during loading. Measure peak memory, transferred bytes and cache-hit rates over a repeatable journey, not only initial page load.

## Persistent locations need a separate decision

Ordinary map clusters are a display aid. Persistent locations are an analytical grouping over multiple years; they must not change merely because neighbouring tiles load or unload.

Do not run the existing greedy anchored grouping independently per tile. It consumes unassigned neighbours in ID order, so partitioning can change membership and rankings. A simple radius buffer is not proof of equivalence to a national run.

Recommended first national release: retain the current method for a clearly selected, bounded analysis area, run on the complete filtered records for that area. Make analysis explicit rather than recomputing on every pan. Return the scope and warn when a group is close to its edge. Set measured record/time limits; ask the visitor to narrow the area if exceeded. National map browsing and exact totals remain available at all scales.

For a later national persistent-location catalogue, benchmark a complete offline run at a few documented radii, or design an explicitly versioned stable-membership method. Filtering fixed precomputed groups is not the same as regrouping filtered records: choose and explain that semantic change rather than silently substituting it. An arbitrary live national radius slider is outside the first release.

## Build and publication pipeline

1. Discover verified final releases from DfT; record the actual included years. Never advance a year from the current date alone.
2. Cache annual source files with URL, retrieval time when known, checksum and schema version. Support upstream corrections, not just newly added years.
3. Join collision, casualty and vehicle records once in the build. Preserve nullable classifications and full source evidence in canonical storage, separate from map tiles.
4. Resolve England/Wales geography using source authority identifiers and a versioned lookup. Reconcile missing/obsolete identifiers, authority changes and coordinates; use country polygons for a documented fallback. Do not silently discard unmapped codes.
5. Reconcile by year and country, authority, severity, child join coverage and missing coordinates. Report source totals separately from mappable totals.
6. Publish an immutable dataset version, indexed database tables, default summaries and derived artifacts. Smoke-test the candidate before switching a small active-version manifest. Keep the previous version for rollback.
7. Scope recording-quality notices to the relevant forces, years and selected geography. Preserve OGL and boundary/basemap attribution. Show reported severity and any future adjusted estimates as distinct measures.

## Hosting choices

The static application can remain on GitHub Pages initially. Keep large source files and national artifacts out of the Git repository and Pages deployment. GitHub documents a 1 GB published-site limit and a 100 GB/month soft bandwidth limit.

Use object storage/CDN for immutable artifacts and a small hosted read-only service with PostGIS for queries. Add request limits, caching, query timeouts and bounded response sizes. Provider selection follows the benchmark and estimated visits; avoid promising zero cost. Estimate monthly cost from initial bytes, tiles per journey, uncached queries, storage and retention.

PMTiles is a useful alternative for immutable, precomputed map views: clients read only needed byte ranges and it integrates with MapLibre. It does not by itself answer arbitrary filtered exact totals. Consider PMTiles for the default overview if measurements justify it; do not introduce a second tile delivery implementation before it earns its complexity. A completely static solution is possible with carefully indexed summary partitions, but would require more bespoke work to preserve arbitrary filters and exact viewport totals.

## Delivery sequence and gates

1. **Measure and validate national data.** Generate compact canonical England/Wales records, reference totals and a benchmark report. Confirm the scope before changing the public map.
2. **Prove the delivery architecture.** Build a vertical slice with one dense and one sparse test area: map tiles, exact summary and click detail. Compare against the current regional snapshot and reference queries. Select hosting from measured results.
3. **National browsing.** Add country/authority navigation, search, full filter semantics, on-demand details and loading/error behaviour. Run the performance/correctness matrix, including all-years national queries.
4. **Bounded persistent analysis.** Add explicit scope and resource limits, edge disclosure and reference-method comparisons. Keep it separate from display clusters.
5. **Release.** Preview the national app, verify provenance and accessibility, run the requested Luna implementation/Astra review workflow, publish versioned artifacts and preserve the West of England entry point. Enable operational metrics and retain rollback.

No new infrastructure, application changes or publication are part of this planning step. The next concrete deliverable should be the national data benchmark and the tile/statistics/detail vertical slice, rather than a full UI rewrite.

## Proposed safety and school-proximity analysis

Planning refinement: distinguish collision recurrence, casualty harm and road context. Do not turn all three into an unexplained combined risk score.

- Recurrence: number of collisions, years represented, annual distribution and recency. The existing three-collision/two-year threshold is an exploratory product rule, not an official designation.
- Harm: fatalities, seriously injured people, slightly injured people, and the separate number of collisions involving KSI. One fatal collision remains discoverable even when it fails the recurrence threshold. A single collision with several severe casualties is not evidence of repeated severe collisions.
- Road users: pedestrian/cycle/motorcycle casualties by severity, child casualties and unknown age/type coverage. Attribute harm through the casualty records, not by applying a collision's worst severity to every involved road user.
- Context: proximity to schools. Recorded slight injuries are evidence of harm; they do not establish a future KSI probability. Route analysis and network/infrastructure assessment are outside this scope.

Keep place membership consistent when comparing harm profiles, or explicitly label regrouped results. A severity filter can otherwise change the underlying grouping and make two supposedly comparable locations different sets of records. At national scale, show separate aggregate measures for collisions and KSI casualties; drill-down must preserve their definitions.

### Schools pilot

Start with public establishment locations, operational status and school phase from DfE GIAS for England and the Welsh Government school-location sources for Wales. Check licensing and coordinate quality before publication. Retain source dates and account for school openings, closures and relocations relative to the collision period. Do not ingest pupil identities or home addresses.

User scope correction: use simple straight-line school proximity, with a proposed default of 500 metres and a wider 1 kilometre option. These are exploratory distance settings, not adopted catchments, walking distances or official thresholds. No route finding, route assessment or school-journey inference is required.

Offer a filter for persistent locations within the selected distance of any school, plus individual-school selection and an optional distance circle. Keep the persistent grouping radius (initially 100m) separate from the school-proximity radius (500m/1km). Changing school distance changes which existing locations qualify; it does not regroup collisions.

Define location proximity using its documented representative anchor, and return nearest-school distance and associated school IDs. Whole-group harm counts remain explicitly group counts because some members may lie beyond the school circle. If showing collisions within a school's radius, calculate those separately from each collision's actual coordinates. Do not present whole-group totals as exact in-circle totals.

Show recurrence and harm breakdowns, including KSI and slight injuries, without requiring child casualties or school-time filters. Those can be separate future refinements if requested. Do not infer school attendance or journey purpose from distance.

School buffers overlap: a collision may be relevant to several schools, but must be counted once in a combined-area total. Describe results as collisions near a school, not pupils injured at that school. Avoid a 'most dangerous schools' league table.

Assess how selective the filter is: report the number and percentage of persistent locations near any school at both distances, relative to all matching locations in the same selected geography. If 1km includes nearly everything in a dense area, show that transparently. Keep distinct-location and collision totals deduplicated across overlapping school circles. Precompute/index school associations so this adds little download or interaction cost.

### Policy interpretation and evaluation

CWIS3 is the third Cycling and Walking Investment Strategy, published in June 2026 and applicable to England. It supports school-route investment and includes participation and safety outcomes. The GB Road Safety Strategy adopts Safe System and sets casualty-reduction targets. Wales has its own Road Safety Partnership Plan and target definitions. Store jurisdiction, metric, age range, baseline, target date and source version as explicit policy metadata; never present an England/Wales subset as the GB national target result.

The five-year browsing window is insufficient for every policy baseline. Retain older baseline data separately, including years needed for Wales. Use official severity-adjustment methodology for target tracking and keep adjusted estimates distinct from individual reported casualties. Do not label a raw mapped KSI series as official target progress.

This proximity screen supports investigation of recorded harm near schools; it is not a complete Safe System assessment. STATS19 alone cannot measure active-travel participation, perceived safety, near misses or intervention effectiveness. Policy alignment does not require expanding the product into routes or an infrastructure assessment tool.

Suggested delivery: first add transparent harm/recurrence profiles; then pilot the 500m/1km school-proximity filter in one English and one Welsh area, measuring coverage and checking school coordinates and overlapping circles. Scale the same bounded feature nationally. Publish this as proximity screening evidence, with traceable sources and limitations.

Additional primary sources:

- [Final CWIS3 strategy](https://www.gov.uk/government/publications/the-third-cycling-and-walking-investment-strategy/active-travel-active-england-the-third-cycling-and-walking-investment-strategy-cwis3).
- [GB Road Safety Strategy](https://assets.publishing.service.gov.uk/media/695e2cff8832ab3a48513809/road-safety-strategy.pdf).
- [Welsh Road Safety Partnership Plan](https://www.gov.wales/sites/default/files/publications/2026-03/road-safety-partnership-plan.pdf).
- [DfE Get Information about Schools](https://www.gov.uk/guidance/get-information-about-schools).
- [Welsh school locations](https://datamap.gov.wales/maps/schools-in-wales/).

## Sources checked

- [DfT road safety open data](https://www.gov.uk/government/statistical-data-sets/road-safety-open-data): final 2025 release, record scope and source files.
- [PostGIS spatial queries](https://postgis.net/docs/en/using_postgis_query.html): indexed exact spatial predicates.
- [PMTiles concepts](https://docs.protomaps.com/pmtiles/): range-based tile retrieval.
- [PMTiles with MapLibre](https://docs.protomaps.com/pmtiles/maplibre): supported integration.
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits): static hosting limits.
- [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/): basemap usage requirements.
