# Establish the data-quality caveat and concentration interpretation
Type: research
Label: wayfinder:research
Status: closed
Assignee: quality-research
Parent: ../map.md
Blocked by:

## Question
What do primary sources say about Avon and Somerset recording problems and the affected years, and what transparent 100m grouping definition avoids claiming exposure-adjusted risk? Investigate practical official authority boundary sources.

## Resolution

The Department for Transport's [known data issues](https://www.gov.uk/government/publications/reported-road-casualty-statistics-background-quality-report/road-casualty-statistics-known-data-issues)
page records that Avon and Somerset Police changed collision recording systems
during 2022. Formatting and export issues, including missing key data, affected
local processing and validation and delayed supply; some data may therefore
have been missing or incomplete at publication. The [DfT 2023 annual
report](https://www.gov.uk/government/statistics/reported-road-casualties-great-britain-annual-report-2023/reported-road-casualties-great-britain-annual-report-2023)
also says that unexpected collection issues mean recorded collisions in Avon
and Somerset may be misrecorded or not recorded at all, so local geographic
comparisons need caution. The product uses a visible 2022–23 caution window,
with no imputation, trend inference or forecast.

Persistent locations use a deterministic anchored grouping: sort by collision
id, take the first unassigned record as the anchor, assign unassigned records
within 100 metres by true haversine distance, repeat, and keep groups with at
least 3 collisions across at least 2 known calendar years. The representative
point is the anchor. This avoids transitive chain grouping and is explicitly a
collision concentration, not exposure-adjusted risk or an official site
assessment. Map display clustering remains separate.

The boundary source is the official ONS [Local Authority Districts (December
2024) Boundaries UK BGC dataset](https://www.data.gov.uk/dataset/af158609-c1ec-40a6-a8ee-0b0feb698463/local-authority-districts-december-2024-boundaries-uk-bgc).
The tested command `npm run ingest:boundaries` queried the ONS FeatureServer
for `E06000022` (Bath and North East Somerset), `E06000023` (Bristol, City of),
`E06000024` (North Somerset), and `E06000025` (South Gloucestershire), requested
`outSR=4326` GeoJSON, validated four unique Polygon/MultiPolygon features, and
wrote `public/data/boundaries.geojson` and
`public/data/boundaries.provenance.json`. The provenance file records the
query URL, source and output CRS, dataset vintage, licence, attribution,
feature count and processing steps. Findings and source details are expanded
in [`docs/research/quality-and-method.md`](../../docs/research/quality-and-method.md).
