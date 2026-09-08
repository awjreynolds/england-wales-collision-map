# National release verification

Verification date: 8 September 2026. Release checks are in progress.

## Independent collision reference

An independent read of the official annual CSV files, separate from the national
builder, found 493,271 England/Wales source collisions for 2021–2025. Of these,
493,218 have valid map coordinates; 53 are excluded from mapped totals.

| Year | Mapped collisions |
| --- | ---: |
| 2021 | 97,168 |
| 2022 | 101,857 |
| 2023 | 100,014 |
| 2024 | 96,760 |
| 2025 | 97,419 |

The mapped records contain 624,985 casualties: 7,264 fatalities, 119,791 serious
injuries and 497,930 slight injuries. These are reported casualty classifications,
not severity-adjusted estimates or an official policy target assessment.

## School coordinate and status checks

The school catalogue contains 25,936 mapped establishments: 24,471 in England,
1,440 maintained schools in Wales and 25 Welsh pupil referral units.

The GIAS source contains 24,553 England school establishments with status `Open`
or `Open, but proposed to close`. The catalogue excludes 82 of those establishments
because their grid coordinates are missing. Closed and proposed establishments
are excluded. This is a current establishment snapshot, not evidence that a school
operated at the same location throughout the collision period.

Every included English point was independently compared with pyproj's
EPSG:27700 to EPSG:4326 transformation using its original GIAS grid coordinates.
Median difference was 0.846 metres, the 95th percentile was 0.900 metres and the
maximum was 0.919 metres. All included statuses were also checked against the
original source rows.

The Welsh official address list contains 80 independent schools without an
authoritative coordinate field. These are excluded from the point catalogue;
school-proximity results must disclose that coverage gap.

## Full database checks

The final combined indexed SQLite import occupies 476,610,560 bytes, including
compressed detail chunks and school records. The production request handlers were
exercised against this database through a local D1-compatible adapter. All eight
selections matched independently calculated collision and casualty-severity totals,
including unknown counts and the empty-result case.

The final code checks passed: the root suite ran 31 tests, the national guard suite
ran 5 tests, the service suite ran 23 tests, and lint, typecheck and the production
build passed. Batched SQL import validation produced 54 files totaling 395,385,275
bytes across 4,799 statements; the largest statement was 90,000 bytes. All eight
exact reference analyses also passed against the batched SQLite import.

| Selection | Collisions | Summary ms | View ms | Drawing mode | Features | Compressed map JSON |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| National | 493,218 | 10 | 1 | Aggregates | 38 | 2,071 bytes |
| Dense London | 22,496 | 64 | 66 | Aggregates | 122 | 4,666 bytes |
| Cardiff | 1,238 | 13 | 25 | Points | 1,238 | 19,774 bytes |
| Rural Wales | 53 | 2 | 2 | Points | 53 | 1,651 bytes |
| West of England authorities | 8,033 | 22 | 18 | Aggregates | 11 | 1,166 bytes |
| Empty sea area | 0 | 0 | 1 | Points | 0 | 482 bytes |
| England, 2025, fatal collisions | 1,244 | 29 | 39 | Points | 1,244 | 26,991 bytes |
| London, cycle involvement unknown | 412 | 59 | 65 | Points | 412 | 8,499 bytes |

These adapter benchmark timings are individual local measurements, not network
latency or p95 values. The national summary uses the precomputed summary path; the
other seven summaries are computed for their selected filters. Compressed sizes use
gzip on the JSON response and exclude the application bundle, manifest, school
layer and basemap.

The Cardiff analysis used 1,238 input collisions and produced 123 persistent
groups at a 100 m grouping radius. Of these, 81 were within 500 m of a listed
school (65.85%), and 121 within 1 km (98.37%). Coverage denominators stayed at 123
when the school filter changed. Group membership contained no duplicate collision
IDs. The slight-only filter returned 73 groups, all with known zero KSI casualties.
A dense London analysis request exceeding 10,000 records returned HTTP 413.
The Cardiff analysis completed in 47 ms in the same local run.

Collision `2021622100636` returned its full record with one linked casualty and
one linked vehicle through the compressed detail store; its recorded slight-casualty
count was zero.

### Deployed Worker checks

The deployed read-only Worker is available at
[weca-national-query.awjreynolds.workers.dev](https://weca-national-query.awjreynolds.workers.dev/)
with API version `5c0b8b5d-f317-41ca-b794-1be859e4d4f1`. The remote import completed
successfully with 4,799 queries in 153,404 ms. The deployed D1 database is
477,212,672 bytes and reports 493,218 collisions, 493,271 detail rows, 4,933
compressed detail chunks and 25,936 schools; its annual casualty totals and dataset
version match the validated release.

The following are single-run remote measurements, not network p95 values:

| Selection | Summary ms | View ms | Drawing mode | Features | Compressed map JSON |
| --- | ---: | ---: | --- | ---: | ---: |
| National | 302 | 168 | Aggregates | 38 | 2,107 bytes |
| Dense London | 552 | 355 | Aggregates | 122 | 4,704 bytes |
| Cardiff | 165 | 225 | Points | 1,238 | 19,819 bytes |
| Rural Wales | 130 | 175 | Points | 53 | 1,686 bytes |
| West of England authorities | 273 | 281 | Aggregates | 11 | 1,201 bytes |
| Empty sea area | 341 | 152 | Points | 0 | 519 bytes |
| England, 2025, fatal collisions | 675 | 1,002 | Points | 1,244 | 27,029 bytes |
| London, cycle involvement unknown | 1,849 | 1,295 | Points | 412 | 8,543 bytes |

All eight remote selections passed their exact reference checks. The deployed
Cardiff analysis returned 123 groups from 1,238 input collisions, with 81 groups
within 500 m (65.85%) and 121 within 1 km (98.37%); it completed in 445 ms. The
slight-only filter returned 73 groups, and a dense London analysis correctly
returned HTTP 413. Remote collision `2021622100636` returned one casualty and one
vehicle with a recorded slight-casualty count of zero.

Additional HTTP checks passed: the Wales school query returned two unique results
on each of two pages, CORS returned `*`, `/manifest` reported 493,218 mappable
collisions, an invalid bounding box returned HTTP 400 and a POST request returned
HTTP 405.

## Release status and remaining verification

Implementation uses Luna Max agents; source reviews use Astra with low reasoning
effort, corresponding to the requested Astra Light review.

Review corrections cover retained school inputs, stricter annual source and join
validation, immutable publication, query projections, empty-result semantics,
school coverage denominators, bounded geographic searches and request races.
The national source, database, code, SQL and deployed Worker checks above are
complete for the final combined version. The [national frontend](https://awjreynolds.github.io/weca-collision-map/)
was published by [GitHub Pages run 34243620756](https://github.com/awjreynolds/weca-collision-map/actions/runs/34243620756).
Its HTML, JavaScript and stylesheet returned HTTP 200, and the published bundle
contains the verified production API endpoint and project-directory navigation.
Final interactive desktop and mobile browser checks remain pending because the
Mac is locked; HTTP and automated checks do not substitute for those interactions.
