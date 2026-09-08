# Select reproducible collision and casualty data for all four authorities
Type: research
Label: wayfinder:research
Status: resolved
Assignee: data-research
Parent: ../map.md
Blocked by:

## Resolution

Use the Department for Transport STATS19 collision, vehicle and casualty CSV
files for the five complete final years 2021–2025. DfT's open-data page names
2025 as the latest final validated year and records that it was added on 30
July 2026. The refresh script filters the four target ONS district codes and
joins the three files by collision index within each year. All current inputs
use the canonical DfT URLs. Raw national files are ignored, while the shipped
manifest records each canonical URL, retrieval URL, SHA-256, byte count,
source-row count, regional-row count and local file timestamp.

The normalized GeoJSON contains 8,033 regional collision features. Every
regional collision row in this window has usable coordinates. All retained
collisions have complete casualty and vehicle row
joins, with individual child references, casualty severity/type codes and
vehicle type codes retained in `sourceProperties.casualtyRecords` and
`sourceProperties.vehicleRecords`. Counts derived from joined casualty rows are
nullable when classification is incomplete; involvement flags are tri-state so
an unknown classification does not become a false negative. The DfT 2025 data
guide is the supported code lookup: 90 is “other”, 99 is unknown self-reported
vehicle type, and electric motorcycles use code 23.

Evidence and implementation details:

- [Data source decision](../../../docs/research/data-source.md)
- [Generated provenance manifest](../../../public/data/provenance.json)
- [Ingestion and validation scripts](../../../scripts/ingest-stats19.ts)
- [Source normalization tests](../../../src/domain/data-source.test.ts)
- [DfT Road Safety Open Data](https://www.gov.uk/government/statistical-data-sets/road-safety-open-data)
- [DfT 2025 coded data guide](https://assets.publishing.service.gov.uk/media/6a63900b2dc18ebe4c3b2bc8/dft-road-casualty-statistics-road-safety-open-dataset-data-guide-2025.xlsx)

## Final review correction

The final data review separated casualty severity coverage from casualty type
coverage. Known fatal and serious casualty severities remain counted even when
the road-user type is `99`; pedestrian absence remains nullable when casualty
type coverage is incomplete. Integer fields now reject fractional source values
instead of rounding them. The manifest exposes
`collisionsWithCompletePedestrianClassification` and uses it with vehicle
classification coverage for `involvementCoverage`. The regenerated snapshot
contains 97 fatalities, 1,396 serious casualties and 1,493 KSI casualties over
9,731 joined casualty rows; no derived severity measure is null.

The manifest's `casualtyCoverage` now describes casualty totals and severity
measures only, and is `complete` for this snapshot. Road-user type coverage is
reported separately through `collisionsWithCompletePedestrianClassification`,
`collisionsWithCompleteVehicleClassification` and `involvementCoverage`.

## Question
Which accessible, licensed source provides at least five complete published years for all four councils, how are fields normalized, and which casualty measures can be supported honestly? Inspect Swift Assist and prefer direct DfT STATS19. Resolve exact temporal coverage and record source evidence.
