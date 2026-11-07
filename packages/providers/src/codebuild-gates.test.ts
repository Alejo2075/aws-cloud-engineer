import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeBuildGateRunner, zipDirectory } from './codebuild-gates.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function project() {
  const dir = await mkdtemp(join(tmpdir(), 'ce-cb-'));
  dirs.push(dir);
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'node_modules/x'), { recursive: true });
  await writeFile(join(dir, 'src/a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'package.json'), '{}');
  await writeFile(join(dir, 'node_modules/x/i.js'), 'skip me');
  return dir;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Input = Record<string, any>;
interface Cmd {
  constructor: { name: string };
  input: Input;
}
interface Sent {
  name: string;
  input: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
function fakes(opts: { statuses: string[]; objects?: Record<string, string> }) {
  const s3Calls: Sent[] = [];
  const cbCalls: Sent[] = [];
  const statuses = [...opts.statuses];
  const objects = opts.objects ?? {};
  const s3 = {
    send: async (c: Cmd) => {
      s3Calls.push({ name: c.constructor.name, input: c.input });
      if (c.constructor.name === 'ListObjectsV2Command') {
        return {
          Contents: Object.entries(objects)
            .filter(([k]) => k.startsWith(c.input.Prefix))
            .map(([Key, v]) => ({ Key, Size: v.length })),
        };
      }
      if (c.constructor.name === 'GetObjectCommand') {
        const text = objects[c.input.Key as string]!;
        return { Body: { transformToByteArray: async () => new TextEncoder().encode(text) } };
      }
      return {};
    },
  };
  const codebuild = {
    send: async (c: Cmd) => {
      cbCalls.push({ name: c.constructor.name, input: c.input });
      if (c.constructor.name === 'StartBuildCommand') return { build: { id: 'proj:1' } };
      if (c.constructor.name === 'BatchGetBuildsCommand') {
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
        return {
          builds: [
            {
              id: 'proj:1',
              buildStatus: status,
              phases: [
                {
                  phaseType: 'BUILD',
                  phaseStatus: 'FAILED',
                  contexts: [{ message: 'npm test failed' }],
                },
              ],
            },
          ],
        };
      }
      return {};
    },
  };
  return { s3, codebuild, s3Calls, cbCalls };
}
const runner = (f: ReturnType<typeof fakes>, over = {}) =>
  new CodeBuildGateRunner({
    s3: f.s3,
    codebuild: f.codebuild,
    bucket: 'bkt',
    projectName: 'GateRunner',
    pollMs: 1,
    sleep: async () => {},
    ...over,
  });

describe('zipDirectory', () => {
  it('produces a valid, deterministic zip without dependencies or build output', async () => {
    const dir = await project();
    const a = await zipDirectory(dir);
    expect(a.equals(await zipDirectory(dir))).toBe(true);
    const file = join(dir, '..', `${dirs.length}-t.zip`);
    await writeFile(file, a);
    dirs.push(file);
    await run('unzip', ['-tq', file]);
    const listing = (await run('unzip', ['-Z1', file])).stdout.trim().split('\n');
    expect(listing).toEqual(['package.json', 'src/a.ts']);
  });
});

describe('CodeBuildGateRunner', () => {
  it('uploads the source, builds, and downloads cdk.out on success', async () => {
    const dir = await project();
    const f = fakes({
      statuses: ['IN_PROGRESS', 'SUCCEEDED'],
      objects: { 'build-output/run-1/cdk.out/a.template.json': '{"Resources":{}}' },
    });
    const report = await runner(f).run(dir, 'run-1');
    expect(report.passed).toBe(true);
    expect(f.s3Calls[0]!.input).toMatchObject({
      Key: 'build-input/run-1/source.zip',
      ServerSideEncryption: 'aws:kms',
    });
    expect(f.cbCalls[0]!.input).toMatchObject({
      sourceLocationOverride: 'bkt/build-input/run-1/source.zip',
      artifactsOverride: { path: 'build-output/run-1' },
    });
    expect(await readFile(join(dir, 'cdk.out/a.template.json'), 'utf8')).toBe('{"Resources":{}}');
  });

  it('reports a failed build with its phase evidence and downloads nothing', async () => {
    const dir = await project();
    const f = fakes({ statuses: ['FAILED'] });
    const report = await runner(f).run(dir, 'run-1');
    expect(report.passed).toBe(false);
    expect(report.failed?.logTail).toContain('npm test failed');
    expect(f.s3Calls.map((c) => c.name)).toEqual(['PutObjectCommand']);
  });

  it('stops a build that exceeds the time budget', async () => {
    const dir = await project();
    const f = fakes({ statuses: ['IN_PROGRESS'] });
    const report = await runner(f, { timeoutMs: -1 }).run(dir, 'run-1');
    expect(report.passed).toBe(false);
    expect(report.failed?.timedOut).toBe(true);
    expect(f.cbCalls.map((c) => c.name)).toContain('StopBuildCommand');
  });

  it('refuses output keys that escape cdk.out, missing output, and bad run ids', async () => {
    const dir = await project();
    const evil = fakes({
      statuses: ['SUCCEEDED'],
      objects: { 'build-output/run-1/cdk.out/../../x': 'x' },
    });
    await expect(runner(evil).run(dir, 'run-1')).rejects.toThrow(/escapes/);
    const empty = fakes({ statuses: ['SUCCEEDED'] });
    await expect(runner(empty).run(dir, 'run-1')).rejects.toThrow(/no cdk.out/);
    await expect(runner(empty).run(dir, '../x')).rejects.toThrow(/Invalid run id/);
  });
});
