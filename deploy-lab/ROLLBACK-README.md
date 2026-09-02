# Rollback scripts for relay migrations

One script per migration this fork has deployed past upstream's own tooling. They exist
because `sqlx` refuses to start a binary against a database holding a migration the binary
does not embed (`MigrateError::VersionMissing`), and `/opt/buzz-relay/.env` sets
`BUZZ_AUTO_MIGRATE=true`. So rolling the image back without rolling the schema back leaves
the relay dead, not restored. Each script drops what its migration created, restores what it
replaced, and deletes its own `_sqlx_migrations` row. That last line is the one that matters:
without it the marker still blocks the boot.

Apply in REVERSE order, each under `psql -v ON_ERROR_STOP=1`, then set `BUZZ_IMAGE` back and
`compose up`.

| range | deployed | notes |
|---|---|---|
| 0029-0031 | Lab boards | fork's own; rehearsed in `deploy-lab/rollback-0029/0030.sql` |
| 0032-0034 | community deletion + workflow error codes | image `8ad61db90`, 19/ago/2026 |
| 0035-0045 | upstream levy (relay operators, NIP-FI, push kinds, roster fence, FTS, heartbeat) | image `c7ddb1ae3`, 02/set/2026 |

## Rehearse before trusting one

Counts are not proof: an index the rollback drops by accident does not move any `count(*)`.
The proof is a schema diff. Restore a fresh production dump into a throwaway Postgres on an
isolated network, apply the migrations with the new image, apply the rollbacks in reverse,
then compare `pg_dump --schema-only` against a clean restore of the same dump. It must be
identical apart from the two `\restrict`/`\unrestrict` nonce lines, which `pg_dump`
regenerates on every run. Finish by starting the OLD image against the rolled-back database
and watching for `TCP listening` rather than `VersionMissing`.

That diff is what caught `rollback-0044` on its first run: it peels the `CASE` wrapper off
`events.search_tsv` by regex, and the first draft required the parentheses that Postgres
normalises away, with a lazy match that stopped at the first `END` of a nested `CASE`. It
failed closed, which is the right way to fail, but in an incident it would have been
unavailable exactly when needed.
