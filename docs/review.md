# Independent code review

Reviewer: **gpt-6-astra**, reasoning effort **low**, matching the requested Astra Light review preference. Implementation and review fixes were performed by **gpt-5.6-luna**, reasoning effort **max**. No Sol reviewer was used.

The reviewer received line-numbered source snapshots and the clarified specification. This was a source review; it did not itself execute tests. Automated checks and browser acceptance are recorded separately in [verification](verification.md).

Review areas:

- Boundary ingestion: strict lookup types and distinct retrieval/generation timestamps.
- STATS19 adapter: source-code missingness, casualty severity unknowns, unique child identities, duplicate collision detection, field-specific numeric sentinels, and paired road class/number selection.
- Browser normalization: authoritative nullable fields, incomplete linked evidence, exact road-user categories and nullable KSI derivation.
- Analysis: conservative candidate searches for the haversine radius, deterministic group membership, and explicit involvement/summary coverage.
- Map lifecycle: stable regional extent, explicit-only reset behavior, and concentration focus independent of filter updates.

Each actionable finding was assigned back to its owning Luna worker. The final acceptance record identifies the checks used to verify the corrected implementation. Review does not establish that every possible defect has been excluded.
