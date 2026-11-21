import { createConnection } from 'mysql2/promise';
import { MysqlConnector } from '../src/mysql-connector';
import type { ConnectorContext } from '../src/contract';

jest.mock('mysql2/promise', () => ({ createConnection: jest.fn() }));
const context: ConnectorContext = {
  organisationId: 'org',
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
};
const base = { connectionString: 'mysql://user:secret@host.example/default_db', table: 'invoices' };

function fixture() {
  const query = jest.fn().mockResolvedValue([[], []]);
  const end = jest.fn().mockResolvedValue(undefined);
  jest.mocked(createConnection).mockResolvedValue({ query, end } as never);
  return { query, end };
}
beforeEach(() => jest.clearAllMocks());

it('uses the explicitly configured database for schema discovery, writes, updates and reads', async () => {
  const f = fixture();
  const connector = new MysqlConnector();
  const config = { ...base, database: 'actual_db' };
  f.query.mockResolvedValueOnce([[{ COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO' }], []]);
  expect(await connector.describeSchema(config, context)).toMatchObject({
    fields: [{ key: 'id', type: 'number', required: true }],
  });
  expect(f.query.mock.calls[0]![1]).toEqual(['invoices', 'actual_db']);
  expect(createConnection).toHaveBeenCalledWith({ uri: base.connectionString });
  f.query.mockClear();
  await connector.create([{ values: { id: 3, name: 'invoice' } }], config, context);
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    'START TRANSACTION',
    'INSERT INTO `actual_db`.`invoices` (`id`, `name`)\n             VALUES (?, ?)',
    'COMMIT',
  ]);
  expect(f.query.mock.calls[1]![1]).toEqual([3, 'invoice']);
  f.query.mockClear();
  f.query.mockResolvedValueOnce([[], []]).mockResolvedValueOnce([{ affectedRows: 1 }, []]);
  await expect(
    connector.update([{ values: { id: 3, name: 'updated' } }], ['id'], config, context),
  ).resolves.toMatchObject({ updated: 1 });
  expect(f.query.mock.calls[1]![0]).toContain('UPDATE `actual_db`.`invoices`');
  expect(f.query.mock.calls[1]![1]).toEqual(['updated', 3]);
  f.query.mockClear();
  f.query.mockResolvedValueOnce([[{ id: 3, name: 'updated' }], []]);
  await expect(connector.read({ where: { id: 3 }, limit: 10 }, config, context)).resolves.toEqual([
    { values: { id: 3, name: 'updated' } },
  ]);
  expect(f.query.mock.calls[0]![0]).toBe(
    'SELECT * FROM `actual_db`.`invoices` WHERE `id` = ? LIMIT ?',
  );
  expect(f.query.mock.calls[0]![1]).toEqual([3, 10]);
  expect(f.end).toHaveBeenCalledTimes(4);
});

it('uses the connection default database consistently when no database override is given', async () => {
  const f = fixture();
  const connector = new MysqlConnector();
  await connector.describeSchema(base, context);
  expect(f.query.mock.calls[0]![0]).toContain('table_schema = DATABASE()');
  expect(f.query.mock.calls[0]![1]).toEqual(['invoices']);
  f.query.mockClear();
  await connector.create([{ values: { id: 1 } }], base, context);
  expect(f.query.mock.calls[1]![0]).toContain('INSERT INTO `invoices`');
  f.query.mockClear();
  await connector.update([{ values: { id: 1, name: 'ok' } }], ['id'], base, context);
  expect(f.query.mock.calls[1]![0]).toContain('UPDATE `invoices`');
  f.query.mockClear();
  await connector.read({ limit: 1 }, base, context);
  expect(f.query.mock.calls[0]![0]).toBe('SELECT * FROM `invoices` LIMIT ?');
});

it('rolls back on the same connection after a failed write and closes it', async () => {
  const f = fixture();
  f.query
    .mockResolvedValueOnce([[], []])
    .mockResolvedValueOnce([[], []])
    .mockRejectedValueOnce(new Error('synthetic failure'));
  await expect(
    new MysqlConnector().create(
      [{ values: { id: 1 } }, { values: { id: 2 } }],
      { ...base, database: 'actual_db' },
      context,
    ),
  ).rejects.toThrow('synthetic failure');
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    'START TRANSACTION',
    'INSERT INTO `actual_db`.`invoices` (`id`)\n             VALUES (?)',
    'INSERT INTO `actual_db`.`invoices` (`id`)\n             VALUES (?)',
    'ROLLBACK',
  ]);
  expect(f.end).toHaveBeenCalledTimes(1);
});

it('rolls back a failed multi-record update and closes the connection', async () => {
  const f = fixture();
  f.query
    .mockResolvedValueOnce([[], []])
    .mockResolvedValueOnce([{ affectedRows: 1 }, []])
    .mockRejectedValueOnce(new Error('synthetic update failure'));
  await expect(
    new MysqlConnector().update(
      [{ values: { id: 1, name: 'first' } }, { values: { id: 2, name: 'second' } }],
      ['id'],
      { ...base, database: 'actual_db' },
      context,
    ),
  ).rejects.toThrow('synthetic update failure');
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    'START TRANSACTION',
    'UPDATE `actual_db`.`invoices` SET `name` = ?\n              WHERE `id` = ?',
    'UPDATE `actual_db`.`invoices` SET `name` = ?\n              WHERE `id` = ?',
    'ROLLBACK',
  ]);
  expect(f.end).toHaveBeenCalledTimes(1);
});

it('rejects invalid database identifiers before connecting', async () => {
  fixture();
  await expect(
    new MysqlConnector().read({}, { ...base, database: 'other;DROP' }, context),
  ).rejects.toThrow('simple identifier');
  expect(createConnection).not.toHaveBeenCalled();
});
