import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise the installed Metro asset pipeline, including its path-based file loading.
const nodeRequire = createRequire(__filename);
const metroAssets = nodeRequire('metro/private/Assets') as {
  getAssetData: (
    path: string,
    localPath: string,
    plugins: string[],
    platform: string,
    publicPath: string,
  ) => Promise<{ width: number; height: number; scales: number[]; files: string[]; type: string }>;
  getAsset: (
    path: string,
    root: string,
    watchFolders: string[],
    platform: string,
    extensions: string[],
  ) => Promise<Buffer>;
};

it('reads image dimensions and resolves scaled image assets with Metro', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'idcp-metro-'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  try {
    await writeFile(join(dir, 'icon.png'), png);
    await writeFile(join(dir, 'icon@2x.png'), png);
    const asset = await metroAssets.getAssetData(
      join(dir, 'icon.png'),
      'icon.png',
      [],
      'ios',
      '/assets',
    );
    expect(asset).toMatchObject({ width: 1, height: 1, scales: [1, 2], type: 'png' });
    expect(asset.files).toHaveLength(2);
    expect(await metroAssets.getAsset('icon@2x.png', dir, [], 'ios', ['png'])).toEqual(png);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
