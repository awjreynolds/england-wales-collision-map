# West of England Road Collision Observatory — clarified implementation prompt

Build and verify a local Git repository providing a credible first regional collision observatory. Run autonomously through source investigation, implementation, tests and commits. Implement with Luna Max; review with Astra Low (the available light effort). This specification resolves ambiguous wording in the supplied prompt; source-dependent facts are captured in linked research tickets.

## Product and geographic scope

Cover Bristol, Bath & North East Somerset, South Gloucestershire and North Somerset, selected by official local-authority codes. “West of England” is this four-council study area, not a claim about combined-authority membership. Display the requested title and subtitle. This is reported STATS19 personal-injury collision evidence, not a census of every road incident.

## Source, dates and missingness

Inspect the public Swift Assist Bristol implementation to learn useful functionality and its schema. Prefer direct licensed DfT STATS19 data when accessible. Ship at least five complete published years if readily available; 2021–2025 is a preference, not permission to invent or mix partial 2025 data with full years. Drive controls and labels from the generated manifest. Record URLs, retrieval/generation timestamps, licence, schema/version, processing rules, exclusions and validation counts. Keep raw downloads ignored and regenerate processed outputs with a Node command. Commit the compact regional processed snapshot so the application runs immediately after installation.

Normalize upstream fields before the UI. Preserve collision and casualty identities and distinct severities. Unknown values remain unknown, including road-user involvement; zero means an observed zero, never missing data. Derive involvement from linked casualty/vehicle evidence only where supported. Unknown or partial casualty coverage must be visible, and unsupported filters must be disabled. Fatal plus serious collision counts must never be labelled KSI casualties.

## Interaction and analytical rules

Map is dominant, with a compact summary, filters, council breakdown and concentration ranking. Filter by available years, authority, collision severity and supported road-user involvement. Multiple values within one dimension combine with OR; different dimensions combine with AND. Totals describe all matching regional records, not only the viewport, and must say so. Changing filters updates points, summaries and concentration ranking together. Panning must not recompute analytical grouping or recreate the map. Preserve zoom and centre on filter changes, with an explicit reset-to-region control.

Zoom clustering is a screen-space display aid and must be separate from metre-based concentration analysis. Individual points have centralized severity colours and safe, missing-aware popups. Use a configurable default radius of 100m for a deterministic, documented bounded grouping method; do not imply every linked chain of points is within that radius. A persistent location requires at least three collisions across at least two distinct years in the active selection. Report collision severity counts, years represented and supported involvement counts. Selecting a ranked location must locate it on the map. Clearly label concentration as frequency, not exposure-adjusted risk, a causal finding, or an official site assessment. A single-year selection can legitimately produce no persistent locations.

## Technology decision and responsiveness

The preferred stack is negotiable. Compare the responsive map in `/Users/awjre/Work/agentic-krn-compiler` before selecting. That reference uses plain JavaScript, Leaflet and raster tiles; its responsive layout and stable map are requirements to learn from, not evidence that React or MapLibre are automatically better. Choose an appropriate local static stack and record the tradeoff. Avoid a DOM element per collision. Validate actual full-data filter responsiveness, desktop and narrow mobile layout, map resizing, cluster expansion, point popups and concentration navigation. Application/data must run locally without an application server beyond static file serving; online basemap dependence must be stated rather than claiming full offline operation.

## Quality and provenance

A shared metadata warning must precisely reflect primary-source evidence about Avon and Somerset recording issues; investigate the approximate 2022–23 claim instead of repeating it as a verified fact. Keep the warning visible even when filters change. Do not add trend extrapolations or forecasts. Show source, included years, retrieval/generation dates, licence, transformations and limitations in the product and README. Regional boundaries are desirable when a practical attributable source can be obtained; do not draw an invented boundary.

## Architecture and exclusions

Separate normalized data, ingestion adapters, analysis and map rendering. Provide typed/documented extension seams for GeoJSON corridors, road segments, junctions, scheme overlays, intervention dates/periods and exposure measures. This milestone does not implement KRN/SATN compilation, scheme impact estimates, exposure-adjusted risk, public deployment or a backend.

## Acceptance

`npm install`, `npm run dev`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` work. Include meaningful tests for transformation, joins/missingness, summary/filter semantics and grouping radius/year thresholds. Inspect a running browser with real processed records, not just build output. Resolve review findings. README covers purpose, four councils, terminology, data issue, setup/run/refresh/build, architecture and future compiler integration. Create logical commits; exclude raw data, dependencies and build output. Record any residual limitation honestly.
