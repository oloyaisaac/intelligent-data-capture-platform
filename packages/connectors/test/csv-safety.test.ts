import { writeFileSync } from 'node:fs';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

it.each([
  { prior: '\uFEFFid,note\r\n1,"=SUM(1,2)"\r\n', added: '2,"a,b"\r\n' },
  { prior: 'id,note\n1,"line 1\nline 2"', added: '\r\n2,"a,b"\r\n' },
  { prior: 'id,note\r1,"old ""quoted"" value"\r', added: '2,"a,b"\r\n' },
])(
  'preserves the exact existing bytes while appending to a valid CSV',
  async ({ prior, added }) => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-preserve-'));
    try {
      const file = join(directory, 'rows.csv');
      await writeFile(file, prior);
      const connector = new CsvFileConnector();
      const config = { directory, filename: 'rows.csv' };
      await connector.create([{ values: { id: '2', note: 'a,b' } }], config, context);
      expect(await readFile(file, 'utf8')).toBe(prior + added);
      const records = await connector.read({}, config, context);
      expect(records).toHaveLength(2);
      expect(records[1]).toEqual({ values: { id: '2', note: 'a,b' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  '',
  '\uFEFF',
  'id,id\r\n1,2\r\n',
  'id,\r\n1,2\r\n',
  'id,note\r\n1\r\n',
  'id,note\r\n1,2,3\r\n',
  'id,note\r\n1,"unterminated',
  'id,note\r\n1,ab"cd\r\n',
  'id,note\r\n1,"closed"junk\r\n',
])('does not modify an empty, ambiguous or malformed existing file: %j', async (prior) => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-invalid-'));
  try {
    const file = join(directory, 'rows.csv');
    await writeFile(file, prior);
    const connector = new CsvFileConnector();
    await expect(
      connector.create(
        [{ values: { id: 'new', note: 'data' } }],
        { directory, filename: 'rows.csv' },
        context,
      ),
    ).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe(prior);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses invalid UTF-8 rather than interpreting a repaired header', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-invalid-encoding-'));
  try {
    const file = join(directory, 'rows.csv');
    const bytes = Buffer.from([0x69, 0x64, 0x0a, 0xff, 0x0a]);
    await writeFile(file, bytes);
    const connector = new CsvFileConnector();
    await expect(
      connector.create([{ values: { id: 'new' } }], { directory, filename: 'rows.csv' }, context),
    ).rejects.toThrow();
    await expect(
      connector.read({}, { directory, filename: 'rows.csv' }, context),
    ).rejects.toThrow();
    expect(await readFile(file)).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'does not overwrite a destination changed after its read (initially exists: %s)',
  async (exists) => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-stale-'));
    try {
      const file = join(directory, 'rows.csv');
      if (exists) await writeFile(file, 'id\nold\n');
      const replacement = 'id\nexternal-change\n';
      const values: Record<string, string> = {};
      Object.defineProperty(values, 'id', {
        enumerable: true,
        get: () => {
          writeFileSync(file, replacement);
          return 'new';
        },
      });
      await expect(
        new CsvFileConnector().create([{ values }], { directory, filename: 'rows.csv' }, context),
      ).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(replacement);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('refuses unsupported CSV format options instead of guessing', () => {
  const connector = new CsvFileConnector();
  for (const config of [
    { directory: '/tmp', filename: 'out.csv', delimiter: '::' },
    { directory: '/tmp', filename: 'out.csv', bom: 'true' },
  ])
    expect(() => connector.validateConfig(config)).toThrow();
});

(process.platform === 'win32' ? it.skip : it)(
  'does not read or append an observed hard-linked CSV destination',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-hardlink-'));
    try {
      const source = join(directory, 'original');
      const file = join(directory, 'rows.csv');
      await writeFile(source, 'id\nprivate\n');
      await link(source, file);
      const connector = new CsvFileConnector();
      const config = { directory, filename: 'rows.csv' };
      await expect(connector.read({}, config, context)).rejects.toThrow('regular file');
      await expect(connector.create([{ values: { id: 'new' } }], config, context)).rejects.toThrow(
        'regular file',
      );
      expect(await readFile(source, 'utf8')).toBe('id\nprivate\n');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([',', ';', '\t', '|'] as const)(
  'preserves bytes and reads quoted data with delimiter %j',
  async (delimiter) => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-delimiter-'));
    try {
      const file = join(directory, 'rows.csv');
      const prior = `id${delimiter}note\n1${delimiter}"embedded${delimiter}delimiter"\n`;
      await writeFile(file, prior);
      const connector = new CsvFileConnector();
      const config = { directory, filename: 'rows.csv', delimiter };
      await connector.create([{ values: { id: '2', note: 'new' } }], config, context);
      expect(await readFile(file, 'utf8')).toBe(`${prior}2${delimiter}new\r\n`);
      expect(await connector.read({}, config, context)).toEqual([
        { values: { id: '1', note: `embedded${delimiter}delimiter` } },
        { values: { id: '2', note: 'new' } },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each(['=cmd', '  +cmd', '\tname', '\nname'])(
  'refuses a formula-like destination header without creating or modifying the file: %j',
  async (header) => {
    const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-header-'));
    try {
      const file = join(directory, 'rows.csv');
      const connector = new CsvFileConnector();
      const config = { directory, filename: 'rows.csv' };
      await expect(
        connector.create([{ values: { [header]: 'data' } }], config, context),
      ).rejects.toThrow();
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
      const prior = `"${header.replace(/"/g, '""')}"\r\nold\r\n`;
      await writeFile(file, prior);
      await expect(
        connector.create([{ values: { [header]: 'new' } }], config, context),
      ).rejects.toThrow();
      await expect(connector.read({}, config, context)).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(prior);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('keeps a safely apostrophe-prefixed connector header stable across writes and reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'idcp-csv-safe-header-'));
  try {
    const connector = new CsvFileConnector();
    const config = { directory, filename: 'rows.csv' };
    await connector.create([{ values: { "'=key": 'one' } }], config, context);
    await connector.create([{ values: { "'=key": 'two' } }], config, context);
    expect(await connector.read({}, config, context)).toEqual([
      { values: { "'=key": 'one' } },
      { values: { "'=key": 'two' } },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
