import { FilesystemStorage, StorageKeyExistsError } from '../../src/storage';
const [root, key, value] = process.argv.slice(2);
if (!root || !key || !value || !process.send) throw new Error('Missing test inputs');
const storage = new FilesystemStorage(root);
process.send({ type: 'ready' });
process.on('message', (message) => {
  if (message !== 'write') return;
  void storage.put(key, Buffer.from(value)).then(
    () => process.send?.({ type: 'written' }),
    (error: unknown) =>
      process.send?.({ type: error instanceof StorageKeyExistsError ? 'collision' : 'error' }),
  );
});
