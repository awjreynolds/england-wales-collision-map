# GitHub Pages static release verification

Date: 8 September 2026.

The application has been migrated from the public Worker API to static GitHub Pages files and browser computation. The prior `workers.dev` endpoint and its preview URLs were disabled at the user's request; a public manifest request returned HTTP 404. The D1 database was not modified or deleted.

## Frozen source and generated release

- National generation: `england-wales-stats19-2021-2025-30467c7cbaa6-863b426e-500d9067-85be3978-0d38d72b`.
- Static generation: `static-service-england-wales-stats19-2021-2025-30467c7cbaa6-863b426e-500d9067-85be3978-0d38d72b-schools-d0afa41d78ed4aa9-provenance-e0580261d0833c28-importer-81908af534eb0365-contract-a5d39237a9f2c430-13aece491980-b53722478d16`.
- Source years: 2021, 2022, 2023, 2024 and 2025.
- Mapped collisions and linked detail entries: 493,218 each.
- School points: 25,936.
- Spatial cells: 398 at 0.25 degrees.
- Detail buckets: 256, addressed by the first byte of SHA-256 of the collision ID.
- Published files: 657, totalling 153,076,896 bytes before the application assets.
- Overview: 502,219 compressed bytes; schools: 597,946 compressed bytes.
- Largest local collision file: 1,278,213 compressed bytes; largest detail file: 573,604 compressed bytes.

The input files under `data/national/2021-2025/` resolve to the verified `863b426e` generation. Older `active.json` pointer files are not used to override those canonical inputs. The static manifest retains national, service-import and school provenance and records publisher/contract hashes.

## Independent artifact audit

A separate Node audit read every manifest-listed file, recomputed SHA-256 and byte length, and decompressed all collision and evidence files. It checked unique IDs, source years, generation identity, detail bucket placement and complete detail coverage. It independently reconstructed every facet's nullable injury metrics, collision severity counts and KSI collision count from the local records, and compared them with the overview. All checks passed.

Reconstructed totals across mapped records:

| Metric | Total |
| --- | ---: |
| Collisions | 493,218 |
| Casualties | 624,985 |
| Fatalities | 7,264 |
| Seriously injured | 119,791 |
| Slightly injured | 497,930 |
| KSI casualties | 127,055 |

Fifty-three source collisions without valid map coordinates remain outside map queries; the canonical source generation retains them. The static map release contains evidence for every mapped collision.

## Review

Astra Light reviewed the static publisher. The JSON object wrapper, replacement recovery, aggregate size guard and release-scope findings were addressed before the frozen release was generated. The independent audit above verified the resulting files rather than relying only on builder output.

The final regeneration adds SHA-256 and byte lengths for both compressed and decoded artifacts. The complete verifier passed against all 657 final files. This supports both raw gzip delivery and hosts that transparently decode HTTP gzip responses.

Astra Light also reviewed the runtime and engine; worker recovery and dense-area aggregation findings were addressed with regression tests. The follow-up Astra Light review found no material remaining failures in the supplied corrective code.

## Production browser verification

The production build was exercised in the browser at a 733-pixel viewport. National totals settled at 493,218 collisions and 624,985 casualties. The map stayed at a fixed 546.96-pixel height after loading; reserving the aggregate-note row removed the loading/resize/query feedback loop. School search for Albany returned matching English and Welsh schools. A local Cardiff view displayed 175 collision points; explicit analysis returned 23 hotspot groups. Clicking collision `2022622200223` loaded its 10 March 2022 serious-collision details and linked source evidence.

Validation passed: lint, TypeScript, 50 application/domain/runtime tests, five national publication guard tests, full static artifact verification, and the production build. Vite retains its existing large-bundle advisory.

Deployment uses the existing GitHub Pages workflow; no Cloudflare service is required by the application.
