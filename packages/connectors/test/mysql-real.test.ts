import { randomUUID } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';
import { MysqlConnector } from '../src/mysql-connector';
import type { ConnectorContext } from '../src/contract';

const mysqlUrl = process.env.IDCP_TEST_MYSQL_URL;
const mysqlDescribe = mysqlUrl || process.env.IDCP_TEST_MYSQL_DISPOSABLE ? describe : describe.skip;

// Dedicated disposable CI service only. This test creates and drops two schemas.
mysqlDescribe('MySQL destination integration', () => {
  it('uses the configured schema consistently and rolls back InnoDB writes on failure', async () => {
    if (!mysqlUrl || process.env.IDCP_TEST_MYSQL_DISPOSABLE !== '1') {
      throw new Error(
        'This destructive test requires an explicitly confirmed disposable MySQL server.',
      );
    }
    const suffix = randomUUID().replace(/-/g, '').slice(0, 16);
    const defaultSchema = `idcp_def_${suffix}`;
    const targetSchema = `idcp_dest_${suffix}`;
    let admin: Connection | undefined;
    const created: string[] = [];
    try {
      admin = await createConnection(mysqlUrl!);
      for (const schema of [defaultSchema, targetSchema]) {
        await admin.query(`CREATE DATABASE \`${schema}\``);
        created.push(schema);
      }
      await admin.query(
        `CREATE TABLE \`${defaultSchema}\`.invoices (id INT PRIMARY KEY, default_only VARCHAR(20)) ENGINE=InnoDB`,
      );
      await admin.query(
        `CREATE TABLE \`${targetSchema}\`.invoices (id INT PRIMARY KEY, name VARCHAR(20) UNIQUE, target_only VARCHAR(20)) ENGINE=InnoDB`,
      );
      await admin.query(
        `INSERT INTO \`${defaultSchema}\`.invoices (id, default_only) VALUES (?, ?)`,
        [1, 'default'],
      );
      await admin.query(
        `INSERT INTO \`${targetSchema}\`.invoices (id, name, target_only) VALUES (?, ?, ?)`,
        [2, 'existing', 'target'],
      );
      const url = new URL(mysqlUrl!);
      url.pathname = `/${defaultSchema}`;
      const config = {
        connectionString: url.toString(),
        table: 'invoices',
        database: targetSchema,
      };
      const connector = new MysqlConnector();
      const context: ConnectorContext = {
        organisationId: 'synthetic',
        logger: {
          info: () => undefined,
          warn: () => undefined,
          debug: () => undefined,
          error: () => undefined,
        },
      };
      const schema = await connector.describeSchema(config, context);
      expect(schema.fields.map((field) => field.key)).toEqual(['id', 'name', 'target_only']);
      expect(await connector.read({ where: { id: 2 } }, config, context)).toEqual([
        { values: { id: 2, name: 'existing', target_only: 'target' } },
      ]);
      await expect(
        connector.create(
          [{ values: { id: 3, name: 'new' } }, { values: { id: 2, name: 'dup' } }],
          config,
          context,
        ),
      ).rejects.toThrow();
      const [afterFailure] = await admin.query(
        `SELECT id, name FROM \`${targetSchema}\`.invoices ORDER BY id`,
      );
      expect(afterFailure).toEqual([{ id: 2, name: 'existing' }]);
      await expect(
        connector.create(
          [{ values: { id: 3, name: 'three' } }, { values: { id: 4, name: 'four' } }],
          config,
          context,
        ),
      ).resolves.toMatchObject({ created: 2 });
      await expect(
        connector.update(
          [{ values: { id: 3, name: 'changed' } }, { values: { id: 4, name: 'existing' } }],
          ['id'],
          config,
          context,
        ),
      ).rejects.toThrow();
      const [afterUpdate] = await admin.query(
        `SELECT id, name FROM \`${targetSchema}\`.invoices ORDER BY id`,
      );
      expect(afterUpdate).toEqual([
        { id: 2, name: 'existing' },
        { id: 3, name: 'three' },
        { id: 4, name: 'four' },
      ]);
      await expect(
        connector.update([{ values: { id: 3, name: 'changed' } }], ['id'], config, context),
      ).resolves.toMatchObject({ updated: 1 });
      const [committed] = await admin.query(
        `SELECT name FROM \`${targetSchema}\`.invoices WHERE id = 3`,
      );
      expect(committed).toEqual([{ name: 'changed' }]);
      const defaultConfig = { connectionString: url.toString(), table: 'invoices' };
      const defaultDescription = await connector.describeSchema(defaultConfig, context);
      expect(defaultDescription.fields.map((field) => field.key)).toEqual(['id', 'default_only']);
      const [defaultRows] = await admin.query(
        `SELECT id, default_only FROM \`${defaultSchema}\`.invoices`,
      );
      expect(defaultRows).toEqual([{ id: 1, default_only: 'default' }]);
      expect(
        await connector.read(
          { where: { id: 1 } },
          { connectionString: url.toString(), table: 'invoices' },
          context,
        ),
      ).toEqual([{ values: { id: 1, default_only: 'default' } }]);
    } finally {
      if (admin) {
        try {
          for (const schema of created.reverse())
            await admin.query(`DROP DATABASE IF EXISTS \`${schema}\``);
        } finally {
          await admin.end();
        }
      }
    }
  }, 30_000);
});
