# National D1 import

`npm run build:sql` reads the canonical artifacts under
`data/national/2021-2025/` and writes ignored SQL chunks to
`data/national/2021-2025/service-import/`. The generated manifest contains the
dataset version, row counts, file order and byte sizes.

The import is intentionally a fresh-database operation. Run the generated
files against a new, versioned D1 database, apply the Worker migrations first,
then run each SQL file in the listed order. `00-preflight.sql` inserts a guard
only when all data tables are empty; a second import aborts on the NOT NULL
constraint. There is no reset or delete step, so an active database is never
cleared in place.

Before changing the Worker binding, query the new database for the manifest
dataset version and the collision, detail lookup, detail chunk and school
counts. Load-test the exact summary, whole-extent view, a bounded viewport,
one collision detail and the analysis limit response. Switch the binding to
the validated database in `wrangler.jsonc`, deploy, and retain the old
database for rollback. A later refresh repeats the same isolated database and
binding-switch sequence.

The `/schools` route applies the selected country to both bounded layers and
name searches. School records do not contain a source authority code, so
collision authority filters do not partition school results; use the map box
and country scope when browsing schools alongside an authority selection.
