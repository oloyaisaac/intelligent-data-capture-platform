import { Pool } from 'pg';
import { PostgresConnector } from '../src/postgres-connector';
import type { ConnectorContext } from '../src/contract';

jest.mock('pg', () => ({ Pool: jest.fn() }));

const config = { connectionString: 'postgres://user:password@host.example/db', table: 'invoices' };
const context: ConnectorContext = {
  organisationId: 'test-org',
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
};

function fixture() {
  const clientQuery = jest.fn().mockResolvedValue({ rows: [] });
  const release = jest.fn();
  const connect = jest.fn().mockResolvedValue({ query: clientQuery, release });
  const poolQuery = jest.fn().mockRejectedValue(new Error('unowned pool query'));
  const end = jest.fn().mockResolvedValue(undefined);
  jest
    .mocked(Pool)
    .mockImplementation(() => ({ connect, query: poolQuery, end }) as unknown as Pool);
  return { clientQuery, release, connect, poolQuery, end };
}

beforeEach(() => jest.clearAllMocks());

it('holds one checked-out PostgreSQL connection for a multi-record create transaction', async () => {
  const f = fixture();
  const result = await new PostgresConnector().create(
    [{ values: { id: 1, name: 'one' } }, { values: { id: 2, name: 'two' } }],
    config,
    context,
  );
  expect(result.created).toBe(2);
  expect(f.connect).toHaveBeenCalledTimes(1);
  expect(f.poolQuery).not.toHaveBeenCalled();
  expect(f.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN',
    'INSERT INTO invoices (id, name) VALUES ($1, $2)',
    'INSERT INTO invoices (id, name) VALUES ($1, $2)',
    'COMMIT',
  ]);
  expect(f.clientQuery.mock.calls[1]![1]).toEqual([1, 'one']);
  expect(f.clientQuery.mock.calls[2]![1]).toEqual([2, 'two']);
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.end).toHaveBeenCalledTimes(1);
  expect(f.release.mock.invocationCallOrder[0]).toBeLessThan(f.end.mock.invocationCallOrder[0]!);
});

it('rolls back on the same client if a later insert fails', async () => {
  const f = fixture();
  f.clientQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockRejectedValueOnce(new Error('synthetic insert failure'));
  await expect(
    new PostgresConnector().create([{ values: { id: 1 } }, { values: { id: 2 } }], config, context),
  ).rejects.toThrow('synthetic insert failure');
  expect(f.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN',
    'INSERT INTO invoices (id) VALUES ($1)',
    'INSERT INTO invoices (id) VALUES ($1)',
    'ROLLBACK',
  ]);
  expect(f.poolQuery).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.end).toHaveBeenCalledTimes(1);
});

it('uses the checked-out connection for update and rolls back after a later failure', async () => {
  const f = fixture();
  f.clientQuery
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ result: 1 }] })
    .mockRejectedValueOnce(new Error('synthetic update failure'));
  await expect(
    new PostgresConnector().update(
      [{ values: { id: 1, name: 'one' } }, { values: { id: 2, name: 'two' } }],
      ['id'],
      config,
      context,
    ),
  ).rejects.toThrow('synthetic update failure');
  expect(f.clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
    'BEGIN',
    'UPDATE invoices SET name = $1 WHERE id = $2 RETURNING 1',
    'UPDATE invoices SET name = $1 WHERE id = $2 RETURNING 1',
    'ROLLBACK',
  ]);
  expect(f.poolQuery).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
  expect(f.end).toHaveBeenCalledTimes(1);
});

it('closes the pool if obtaining a client fails', async () => {
  const f = fixture();
  f.connect.mockRejectedValue(new Error('synthetic connection failure'));
  await expect(
    new PostgresConnector().create([{ values: { id: 1 } }], config, context),
  ).rejects.toThrow('synthetic connection failure');
  expect(f.clientQuery).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  expect(f.end).toHaveBeenCalledTimes(1);
});
