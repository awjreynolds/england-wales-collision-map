# Deliver a credible West of England Road Collision Observatory
Label: wayfinder:map

## Destination
A working, verified local static web application using real regional collision data, reproducible ingestion, precise terminology and extension seams for corridor and scheme evidence.

## Notes
User explicitly authorizes execution in this map and autonomous resolution of implementation choices, overriding planning-only and single-session stop rules. Use local Markdown tracker. Implementation: gpt-5.6-luna, max; review: gpt-6-astra, low. Consult wayfinder and domain-modeling. Research uses the research skill. Existing prompt supplies product decisions; do not fabricate human interviews. Do not change shared checkout branches during parallel work; research assets remain linked in this repository.

## Decisions so far

- [Select reproducible collision and casualty data for all four authorities](issues/01-data-source.md): DfT 2021–2025 final records from direct DfT URLs and explicit child-evidence validation.

- [Establish the data-quality caveat and concentration interpretation](issues/02-quality-and-method.md): primary DfT warnings support a 2022–23 caution window; use bounded ground-distance grouping and four official ONS council polygons.

## Not yet specified
None. Source coverage, missingness, quality caveat, method and stack choice are specified; validation and remaining limitations are recorded in the verification report and README.

## Out of scope
Public deployment, exposure-adjusted risk, forecasts, causal before/after estimates and actual KRN/SATN ingestion. Provide documented extension seams only. West of England means the four requested councils, including North Somerset; it is not a claim about combined-authority membership.
