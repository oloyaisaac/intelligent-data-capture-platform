# MySQL destination connector: database selection

The optional connector `database` setting selects the database for schema discovery **and** for
create, update and read operations. When absent, all four operations use the connection's default
database. Database, table and column names are restricted to simple identifiers and quoted; record
values remain parameters. The connection user must have the appropriate permissions on the chosen
database. Schema inspection and later operations use separate connections and can race configuration
or schema changes.

Older versions used `database` for schema discovery but used the connection's default database for
data operations. Deploying the fix can therefore redirect future operations to a different table
than older versions used. An authorized owner should compare configuration and connection defaults,
review mappings, permissions, logs and potentially affected destination data on both databases, and
plan any repair before rollout. Do not blindly replay writes or delete data. No production destination
has been inspected or repaired here. Mixed-version workers can still write to the old location.

MySQL create and update use one connection and transaction, but rollback depends on transactional
storage engines and destination behavior: nontransactional tables or external trigger effects may
survive a failure. Lost acknowledgements, failures after commit and retries remain ambiguous; a
failure does not establish that nothing was written. Inspect the destination before retrying. This
change does not enforce network egress controls or isolate connector processes. See
`connector-network-security.md` and `connector-process.md`.

The mocked regression tests run with the regular connector suite. A separate real-driver test creates
and drops two randomly named databases and exercises InnoDB transactions; it is configured against a
**disposable** MySQL 8 CI service. To run locally, supply `IDCP_TEST_MYSQL_URL` with a privileged
connection URL to a dedicated throwaway server and explicitly set `IDCP_TEST_MYSQL_DISPOSABLE=1`,
then run `npm test -- --runInBand --selectProjects connectors --runTestsByPath packages/connectors/test/mysql-real.test.ts`.
Never point this test at production or any server containing valuable data. The confirmation is an
operator assertion, not an enforced server-identity or production safety check. Interrupted tests
may leave randomly named databases behind. CI coverage does not establish MariaDB, non-InnoDB,
real network-failure or production compatibility.
