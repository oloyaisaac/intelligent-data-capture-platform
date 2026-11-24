# R01 T-06 — synthetic PostgreSQL question-mark round trip

**Source baseline:** `9ec567c988888024a32d6e820b0c9f0ec262076b`. A disposable local PostgreSQL
16.16 instance was initialized with UTF-8 and served through a private Unix socket only; no TCP
listener, production connection, customer data or external provider was used. The test harness
created a temporary schema, ran the current migration set, started a local HTTP test listener,
registered a synthetic account, uploaded a synthetic document, and drained one fake-OCR worker job.
It then inserted a validated UDM containing `?` via `ExtractionsRepository.create` and read it back
through the real PostgreSQL adapter. A separate SQL query tested `?` inside an ordinary
single-quoted SQL literal alongside a bound parameter containing `?`. Both comparisons passed;
`postgres-question-mark-probe-9ec567c.txt` is the concise transcript.

This addresses the narrow T-06 data round-trip on this one PostgreSQL version and test environment.
It does **not** make the rewriter a general SQL lexer: ARC-046 separately demonstrates corruption
of question marks in synthetic dollar-quoted bodies and comments. It does not prove migration
portability across versions, production correctness, TLS/network behavior, independent R03 review
or the integrity of existing records.

## Reproduction in a disposable sandbox

Use a clean checkout with Node 22, npm and the installed dependencies (`ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm ci --no-audit --no-fund`). This instance is for synthetic data only. The probe deliberately
replaces the test database environment with the fixed socket below and creates/drops a random schema
through the test harness. `--auth=trust` is suitable only for this isolated socket directory; do not
reuse this configuration for production or untrusted local users. The `.cache` directory is ignored
and its data and binary package are not review deliverables.

```sh
mkdir -p .cache/r01-postgres/socket
chmod 700 .cache/r01-postgres/socket
npm pack @embedded-postgres/linux-x64@16.16.0-beta.19 --pack-destination .cache/r01-postgres --silent
tar -xzf .cache/r01-postgres/embedded-postgres-linux-x64-16.16.0-beta.19.tgz -C .cache/r01-postgres
node .cache/r01-postgres/package/scripts/hydrate-symlinks.js
.cache/r01-postgres/package/native/bin/initdb -D .cache/r01-postgres/data-utf8 -U postgres --auth=trust --no-instructions --no-locale --encoding=UTF8
.cache/r01-postgres/package/native/bin/pg_ctl -D .cache/r01-postgres/data-utf8 -l .cache/r01-postgres/server.log -o "-k $PWD/.cache/r01-postgres/socket -p 55439 -c listen_addresses=''" -w start
TSX_TSCONFIG_PATH=tsconfig.base.json node --import tsx docs/reviewers/evidence/R01/postgres-question-mark-probe.ts
.cache/r01-postgres/package/native/bin/pg_ctl -D .cache/r01-postgres/data-utf8 -m fast -w stop
```

The command assumes a fresh empty data directory and that port number 55439 is not used for a socket
in this private directory. In this assessment the server was started and stopped with the process
manager instead of `pg_ctl`; the database was stopped after the probe. The environment's process
log clock differs from the session date, so it is not used as a review or sign-off date.
