# Data source decision: DfT STATS19, 2021–2025

## Resolution

Use the Department for Transport (DfT) STATS19 record-level open data as the
source of truth. The refresh script reads the collision, vehicle and casualty
CSV for each final year from 2021 through 2025, filters to the four target ONS
local-authority districts, and joins the three tables by the source collision
index within each year.

The DfT describes these files as records of personal-injury collisions on
public roads that were reported to the police and subsequently recorded using
STATS19. They are not a count of every road incident. The files are coded, so
the normalized map properties are deliberately a small stable contract while
`sourceProperties` retains source codes and join coverage facts.

## Primary-source evidence

- [DfT Road safety open data](https://www.gov.uk/government/statistical-data-sets/road-safety-open-data)
  describes the collision, vehicle and casualty record files, the annual final
  release cycle, confirms that 2025 is the latest final validated year (added
  30 July 2026), and states the coded field guide and Open Government Licence.
- [DfT STATS19 forms and guidance](https://www.gov.uk/government/publications/stats19-forms-and-guidance)
  is the first-party specification for the collision and casualty collection.
- [DfT Road Safety Open Data: 2025 data guide](https://assets.publishing.service.gov.uk/media/6a63900b2dc18ebe4c3b2bc8/dft-road-casualty-statistics-road-safety-open-dataset-data-guide-2025.xlsx)
  is the supported lookup for coded `vehicle_type` and `casualty_type` values.
- [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
  is the licence stated by the DfT dataset.
- [Swift Assist Bristol page](https://swiftassistuk.co.uk/accident-statistics/bristol/),
  [Swift Assist API documentation](https://swiftassistuk.co.uk/developers/) and
  [Swift Assist methodology](https://swiftassistuk.co.uk/methodology/) were
  inspected as requested. Swift Assist confirms that its maps are derived from
  DfT STATS19 and describes a roughly 100 m coordinate-rounding concentration
  method, but its aggregation is not used as this application's input. The
  direct DfT records keep the map independent of a third-party API and retain
  casualty and vehicle rows for later analysis.

## Exact files and coverage

The canonical files are named by DfT as follows:

```text
https://data.dft.gov.uk/road-accidents-safety-data/dft-road-casualty-statistics-{collision,vehicle,casualty}-YYYY.csv
```

The current refresh uses the direct DfT URLs for all five final annual files,
2021–2025. The DfT page identifies the 2025 collision, vehicle and casualty
files as the latest full year of final validated data and records their 30 July
2026 publication update. The current annual files use `collision_*` column
names; the adapter also accepts the older `accident_*` spellings for historical
schema compatibility. Raw files are downloaded to `data/raw/` for a refresh
and are excluded from Git.

## Normalized contract

Each generated GeoJSON feature is one reported injury collision and has:

| Field | Meaning |
| --- | --- |
| `id` | DfT collision index, unique across the included years |
| `date`, `year` | ISO date/year; the recorded `time` is retained in `sourceProperties.time` |
| `longitude`, `latitude` | DfT coordinates, with invalid/out-of-range points rejected |
| `severity` | `fatal`, `serious`, `slight` or `unknown` from the collision severity code |
| `localAuthority` | One of Bristol, Bath and North East Somerset, South Gloucestershire or North Somerset |
| `roadNumber` | First available coded road number, with M/A(M)/A/B class prefix where known |
| `speedLimit` | Recorded limit in mph, or `null` for DfT missing codes |
| `junctionDetail` | The supplied DfT junction-detail code as text; source code is also retained |
| `casualtyCount` | Collision-row casualty total, or `null` when missing |
| `fatalities`, `seriousCasualties`, `ksiCasualties` | Joined casualty-row counts; `null` when the casualty join or casualty-severity classification is incomplete |
| `pedestrianInvolved` | Nullable recorded pedestrian-casualty flag |
| `cycleInvolved`, `motorcycleInvolved` | Nullable vehicle-type flags; vehicle rows are preferred to casualty type |

The adapter preserves coded values such as `90` (other) and `99` (unknown
self-reported vehicle type) in `sourceProperties` rather than applying a
universal missing-value rule. Motorcycle classification includes the current
DfT codes `2`–`5`, `23` (electric motorcycle) and `97` (unknown cc); code `99`
keeps classification incomplete and therefore leaves the relevant flag
nullable.

The application treats these as nullable flags rather than silently turning an
unmatched table join into “no involvement”. A `false` flag means the relevant
table was complete for that collision and contained no qualifying coded row.
A `true` flag remains usable when a partial join contains a qualifying row;
absence from an incomplete table is represented as `null`.

Pedestrian involvement is necessarily based on recorded casualty rows: an
uninjured pedestrian is not represented in STATS19 casualty data. Cycle and
motorcycle involvement use vehicle rows, which preserve involved vehicles even
when a particular road user did not become a casualty. These are recorded
involvement measures, not exposure-adjusted risk measures.

## Validation and provenance

`scripts/ingest-stats19.ts` streams each CSV, filters the regional collision
rows before joining, checks the collision key, tracks unmatched casualty and
vehicle rows, and writes SHA-256, byte size, source row count and regional row
count for every input into `public/data/provenance.json`. It writes only the
normalized GeoJSON and provenance manifest to `public/data/`; raw downloads are
recreatable.

Run the refresh and validation commands from the README. The validator checks
that output IDs are unique, all points are in the Great Britain coordinate
range, all records belong to the declared years and authorities, nullable
involvement flags have valid values, and the manifest count matches the
GeoJSON.

## Caveats

The DfT warns that Avon and Somerset Police recording-system changes affected
local collision completeness around 2022–23. The warning is carried in the
manifest and displayed by the application. Counts in those years must not be
read as a perfectly comparable trend, adjusted rate, forecast or causal result.
The application's persistent locations are frequency concentrations only; an
exposure measure such as traffic, walking or cycling volume is not included.
