import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { S3WorkspaceStore, unzipTo } from './workspace-store.js';
import { zipDirectory } from './codebuild-gates.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'ce-ws-'));
  dirs.push(d);
  return d;
};

function fakeS3() {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    client: {
      send: async (c: { constructor: { name: string }; input: { Key: string; Body?: Buffer } }) => {
        if (c.constructor.name === 'PutObjectCommand') {
          objects.set(c.input.Key, c.input.Body!);
          return {};
        }
        const o = objects.get(c.input.Key);
        if (!o) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new Uint8Array(o) } };
      },
    },
  };
}

describe('S3WorkspaceStore', () => {
  it('round-trips source and cdk.out but never node_modules or .git, replacing stale files', async () => {
    const src = await tmp();
    await mkdir(join(src, 'src'));
    await mkdir(join(src, 'cdk.out'));
    await mkdir(join(src, 'node_modules/x'), { recursive: true });
    await writeFile(join(src, 'src/a.ts'), 'a');
    await writeFile(join(src, 'cdk.out/t.template.json'), '{"Resources":{}}');
    await writeFile(join(src, 'node_modules/x/i.js'), 'dep');
    const { client, objects } = fakeS3();
    const store = new S3WorkspaceStore(client, 'bkt');
    await store.persist('run-1', src);
    expect([...objects.keys()]).toEqual(['runs/run-1/workspace/workspace.zip']);

    const dest = await tmp();
    await writeFile(join(dest, 'stale.txt'), 'old');
    await store.restore('run-1', dest);
    expect((await readdir(dest)).sort()).toEqual(['cdk.out', 'src']);
    expect(await readFile(join(dest, 'cdk.out/t.template.json'), 'utf8')).toBe('{"Resources":{}}');
  });

  it('treats a missing workspace as nothing to restore and rejects bad run ids', async () => {
    const { client } = fakeS3();
    const store = new S3WorkspaceStore(client, 'bkt');
    const dest = await tmp();
    await writeFile(join(dest, 'keep.txt'), 'x');
    await store.restore('run-9', dest);
    expect(await readdir(dest)).toEqual(['keep.txt']);
    await expect(store.persist('../x', dest)).rejects.toThrow(/Invalid run id/);
  });
});

describe('unzipTo', () => {
  async function zipOf(files: Record<string, string>) {
    const src = await tmp();
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(src, name, '..'), { recursive: true });
      await writeFile(join(src, name), content);
    }
    return zipDirectory(src);
  }

  it('rejects traversal entries, corrupt data and non-zip input', async () => {
    const zip = await zipOf({ 'a.txt': 'hello' });
    const evil = Buffer.from(zip);
    // Rewrite the entry name "a.txt" (same length) to "../xx" in both headers.
    for (let i = evil.indexOf('a.txt'); i >= 0; i = evil.indexOf('a.txt', i + 1)) {
      evil.write('../xx', i);
    }
    await expect(unzipTo(evil, await tmp())).rejects.toThrow(/Unsafe archive entry/);

    const corrupt = Buffer.from(zip);
    corrupt.write('J', corrupt.indexOf('hello')); // flips file data, CRC no longer matches
    await expect(unzipTo(corrupt, await tmp())).rejects.toThrow(/Corrupt entry/);

    await expect(unzipTo(Buffer.from('nope'), await tmp())).rejects.toThrow(/Not a zip/);
  });
});
