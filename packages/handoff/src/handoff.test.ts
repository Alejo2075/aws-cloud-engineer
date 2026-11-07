import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertNoSecrets,
  buildManifest,
  exportProject,
  initGitRepository,
  manifestJsonSchema,
  manifestResources,
} from './index.js';

const input = {
  systemId: 'booking-app',
  name: 'Booking App',
  environment: 'staging',
  accountId: '123456789012',
  region: 'us-east-1',
  stackName: 'booking-app-staging',
  resources: [{ logicalId: 'Table', type: 'AWS::DynamoDB::Table' }],
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('manifest', () => {
  it('builds a valid manifest and omits verifiedAt until verified', () => {
    const m = buildManifest(input);
    expect(m.kind).toBe('CloudSystemManifest');
    expect(m.deployment.verifiedAt).toBeUndefined();
    expect(
      buildManifest({ ...input, verifiedAt: '2026-11-06T00:00:00.000Z' }).deployment.verifiedAt,
    ).toBeDefined();
  });

  it('rejects invalid account ids and secret-like content', () => {
    expect(() => buildManifest({ ...input, accountId: '1' })).toThrow();
    expect(() => buildManifest({ ...input, name: 'AKIAABCDEFGHIJKLMNOP' })).toThrow(/Secret-like/);
    expect(() => assertNoSecrets('-----BEGIN RSA PRIVATE KEY-----')).toThrow();
  });

  it('filters CDK noise from resources', () => {
    expect(
      manifestResources({
        Resources: {
          A: { Type: 'AWS::S3::Bucket' },
          B: { Type: 'Custom::X' },
          C: { Type: 'AWS::CDK::Metadata' },
        },
      }),
    ).toEqual([{ logicalId: 'A', type: 'AWS::S3::Bucket' }]);
  });

  it('keeps the published JSON Schema in sync with the zod contract', async () => {
    const file = fileURLToPath(
      new URL('../../../docs/integration/cloud-system-manifest.schema.json', import.meta.url),
    );
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(manifestJsonSchema());
  });
});

describe('exportProject', () => {
  it('copies source without dependencies or build output, and writes the manifest', async () => {
    const src = await mkdtemp(join(tmpdir(), 'ce-src-'));
    const out = await mkdtemp(join(tmpdir(), 'ce-out-'));
    dirs.push(src, out);
    await mkdir(join(src, 'node_modules/x'), { recursive: true });
    await mkdir(join(src, 'cdk.out'));
    await mkdir(join(src, 'src'));
    await writeFile(join(src, 'src/a.ts'), 'x');
    await writeFile(join(src, 'node_modules/x/i.js'), 'x');
    await writeFile(join(src, 'cdk.out/t.json'), '{}');
    await exportProject(src, join(out, 'app'), buildManifest(input));
    const names = await readdir(join(out, 'app'));
    expect(names.sort()).toEqual(['cloud-system-manifest.json', 'src']);
  });
});

describe('initGitRepository', () => {
  it('creates one commit with the exported files and refuses an existing repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ce-git-'));
    dirs.push(dir);
    await writeFile(join(dir, 'a.txt'), 'x');
    const rev = await initGitRepository(dir);
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
    await expect(initGitRepository(dir)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
