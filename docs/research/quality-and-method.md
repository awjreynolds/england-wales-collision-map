# Data quality and concentration method

This note resolves the quality/method question for the West of England Road
Collision Observatory. It records what the primary sources say, how the
application should communicate it, and the boundary service used for the four
authority outline.

## Avon and Somerset recording caveat

The Department for Transport's known-data-issues page has a specific 2022
section for Avon and Somerset Police. It says that the force changed collision
recording systems during 2022, and that formatting and export issues exposed
missing key data. Those problems affected local processing and validation and
delayed supply to the Department, so some data could be missing or incomplete
when published.

The DfT's 2023 annual report separately warns that unexpected data-collection
issues for Avon and Somerset mean the reliability and accuracy of recorded
collisions in the region cannot be guaranteed: some collisions may have been
misrecorded or not recorded at all. The report says to use caution for
geographical breakdowns by force and local authority.

The application therefore marks 2022 and 2023 as a caution window. This is a
transparent presentation rule combining the 2022 issue notice and the warning
in the 2023 annual report; it does not claim that the sources identify one
precise start/end date for every affected record. The shared warning must say
that the records may be incomplete or misrecorded, that no correction or
imputation has been applied, and that affected counts should not be used for
trend inference or forecasting. The warning is about reporting completeness;
it is not evidence of a change in underlying road safety.

The relevant source links are:

- [DfT, Road casualty statistics: known data issues](https://www.gov.uk/government/publications/reported-road-casualty-statistics-background-quality-report/road-casualty-statistics-known-data-issues)
- [DfT, Reported road casualties Great Britain, annual report: 2023](https://www.gov.uk/government/statistics/reported-road-casualties-great-britain-annual-report-2023/reported-road-casualties-great-britain-annual-report-2023)
- [DfT, Road safety statistics guidance](https://www.gov.uk/guidance/road-accident-and-safety-statistics-guidance)

The DfT guidance and annual report also make the coverage limitation clear:
STATS19 is based on collisions reported to the police and does not represent
all collisions or casualties. Non-fatal casualties are known to be
under-reported. The observatory should therefore describe its records as
reported personal-injury collisions, retain unknown values, and avoid implying
that an empty location had no collisions.

## Recommended concentration rule

The map's screen-space display clustering and its persistent-location analysis
are different operations. Display clusters may change with zoom; the analysis
must be stable for the same filtered records regardless of map viewport.

Use a deterministic anchored grouping method with these defaults:

| Parameter | Default | Meaning |
| --- | ---: | --- |
| Radius | 100 metres | Haversine distance from the group's anchor collision |
| Minimum collisions | 3 | Minimum records assigned to an anchor |
| Minimum distinct years | 2 | Minimum non-null calendar years represented |

For the active filtered records:

1. Sort by the stable collision identifier.
2. Take the first unassigned record as the anchor.
3. Assign that anchor and every other unassigned record whose haversine
   distance from the anchor is at most the configured radius.
4. Repeat from the next unassigned record until all records are assigned.
5. Keep a group only when it has at least three records and at least two
   distinct known calendar years.

Use the anchor coordinate as the group's representative location. A group is
therefore bounded by a clear, repeatable relationship to its anchor. It must
not be described as a set in which every pair of points is within 100 metres:
that would be false for points on opposite sides of an anchor. The anchored
rule also avoids the misleading chain interpretation in which A is near B and
B is near C, so all three are silently presented as one 100 metre location.

Calculate distances with the haversine formula on longitude/latitude. Do not
use an uncorrected Web Mercator or fixed degree grid as a metre calculation.
Only known years contribute to the year threshold. A one-year selection can
legitimately produce no persistent locations.

Every ranking and label should use “collision concentration” or “persistent
collision location”. It must state that the result is a frequency grouping,
not exposure-adjusted risk, a causal finding, or an official site assessment.
Fatal and serious collision counts remain collision counts. “KSI” is reserved
for killed or seriously injured people counted from casualty records.

## Official authority boundaries

The boundary source is the [ONS Local Authority Districts (December 2024)
Boundaries UK BGC dataset](https://www.data.gov.uk/dataset/af158609-c1ec-40a6-a8ee-0b0feb698463/local-authority-districts-december-2024-boundaries-uk-bgc).
ONS describes BGC as generalised to 20 metres and clipped to the coastline.
The dataset is published by the Office for National Statistics and contains
Ordnance Survey and ONS intellectual-property material.

The reproducible feature query used by the boundary ingestion script is:

```text
https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_December_2024_Boundaries_UK_BGC/FeatureServer/0/query?where=LAD24CD%20in%20(%27E06000022%27,%27E06000023%27,%27E06000024%27,%27E06000025%27)&outFields=LAD24CD%2CLAD24NM&returnGeometry=true&outSR=4326&f=geojson
```

The selected codes are:

| Code | Authority |
| --- | --- |
| `E06000022` | Bath and North East Somerset |
| `E06000023` | Bristol, City of |
| `E06000024` | North Somerset |
| `E06000025` | South Gloucestershire |

The `LAD24CD` and `LAD24NM` fields are shown in the dataset's official CSV
preview. The query requests WGS84 (`EPSG:4326`) so the resulting GeoJSON can
be rendered directly by MapLibre. It returns exactly these four features; it
does not use a combined-authority polygon or an invented regional outline.

The ONS portal also exposes the [official GeoJSON export](https://open-geography-portalx-ons.hub.arcgis.com/api/download/v1/items/6a05f93297cf4a438d08e972099f54b9/geojson?layers=0)
and [FeatureServer resource](https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Local_Authority_Districts_December_2024_Boundaries_UK_BGC/FeatureServer).
The direct export is the full UK dataset; the script uses the FeatureServer
query to select and reproject only the four study-area authorities.

ONS supplies digital boundaries under the Open Government Licence. Retain the
following attribution with the boundary asset and product UI:

> Source: Office for National Statistics licensed under the Open Government
> Licence v.3.0. Contains OS data © Crown copyright and database right 2024.

See [ONS digital boundaries](https://www.ons.gov.uk/methodology/geography/geographicalproducts/digitalboundaries)
for the boundary product types, licence and attribution guidance.

