import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CsvFileConnector } from '../src/csv-connector';
import type { ConnectorContext } from '../src/contract';

const context: ConnectorContext = {
  organisationId: 'synthetic',
  logger: {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  },
};

(process.platform === 'win32' ? it.skip : it)(
  'does not mistake non-file destinations or symlinks for an empty CSV',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-safety-'));
    try {
      const connector = new CsvFileConnector();
      const directoryConfig = { directory, filename: 'folder.csv' };
      await mkdir(join(directory, 'folder.csv'));
      await expect(connector.read({}, directoryConfig, context)).rejects.toThrow('regular file');
      await expect(
        connector.create([{ values: { id: '1' } }], directoryConfig, context),
      ).rejects.toThrow('regular file');
      const target = join(directory, 'target.csv');
      await writeFile(target, 'id\r\noriginal\r\n');
      await symlink(target, join(directory, 'link.csv'));
      const linkConfig = { directory, filename: 'link.csv' };
      await expect(connector.read({}, linkConfig, context)).rejects.toThrow('regular file');
      await expect(
        connector.create([{ values: { id: '2' } }], linkConfig, context),
      ).rejects.toThrow('regular file');
      expect(await readFile(target, 'utf8')).toBe('id\r\noriginal\r\n');
      await symlink(join(directory, 'missing.csv'), join(directory, 'dangling.csv'));
      await expect(
        connector.create(
          [{ values: { id: '2' } }],
          { directory, filename: 'dangling.csv' },
          context,
        ),
      ).rejects.toThrow('regular file');
      await expect(readFile(join(directory, 'missing.csv'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('checks every record for unknown columns before modifying the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-safety-'));
  try {
    const connector = new CsvFileConnector();
    const config = { directory, filename: 'rows.csv' };
    await connector.create([{ values: { id: 'original' } }], config, context);
    const before = await readFile(join(directory, 'rows.csv'), 'utf8');
    await expect(
      connector.create(
        [{ values: { id: '1' } }, { values: { id: '2', extra: 'must not be dropped' } }],
        config,
        context,
      ),
    ).rejects.toThrow('different columns');
    expect(await readFile(join(directory, 'rows.csv'), 'utf8')).toBe(before);
    await expect(connector.create([{ values: {} }], config, context)).rejects.toThrow(
      'at least one field',
    );
    expect(await readFile(join(directory, 'rows.csv'), 'utf8')).toBe(before);
    await expect(connector.create([], config, context)).resolves.toMatchObject({ created: 0 });
    expect(await readFile(join(directory, 'rows.csv'), 'utf8')).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('validates read config and still treats an absent destination as empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-safety-'));
  try {
    const connector = new CsvFileConnector();
    await expect(connector.read({}, { directory, filename: '../other' }, context)).rejects.toThrow(
      'plain file name',
    );
    await expect(
      connector.read({}, { directory, filename: 'absent.csv' }, context),
    ).resolves.toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
