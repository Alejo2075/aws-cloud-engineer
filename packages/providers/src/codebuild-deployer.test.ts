import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeBuildDeployer } from './codebuild-deployer.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function assembly() {
  const dir = await mkdtemp(join(tmpdir(), 'ce-asm-'));
  dirs.push(dir);
  await mkdir(join(dir, 'asset.1/node_modules/x'), { recursive: true });
  await writeFile(join(dir, 'app.template.json'), '{"Resources":{}}');
  await writeFile(join(dir, 'asset.1/node_modules/x/i.js'), 'bundled dependency');
  return dir;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Input = Record<string, any>;
interface Cmd {
  constructor: { name: string };
  input: Input;
}
function fakes(status: string, outputs?: string) {
  const s3Calls: { name: string; input: Input }[] = [];
  const cbCalls: { name: string; input: Input }[] = [];
  return {
    s3Calls,
    cbCalls,
    s3: {
      send: async (c: Cmd) => {
        s3Calls.push({ name: c.constructor.name, input: c.input });
        if (c.constructor.name === 'GetObjectCommand') {
          return outputs === undefined ? {} : { Body: { transformToString: async () => outputs } };
        }
        return {};
      },
    },
    codebuild: {
      send: async (c: Cmd) => {
        cbCalls.push({ name: c.constructor.name, input: c.input });
        if (c.constructor.name === 'StartBuildCommand') return { build: { id: 'dep:1' } };
        if (c.constructor.name === 'BatchGetBuildsCommand') {
          return {
            builds: [
              {
                id: 'dep:1',
                buildStatus: status,
                phases: [
                  {
                    phaseType: 'BUILD',
                    phaseStatus: 'FAILED',
                    contexts: [{ message: 'cdk failed' }],
                  },
                ],
              },
            ],
          };
        }
        return {};
      },
    },
  };
}
const ctx = {
  runId: 'run-1',
  stackName: 'app-staging',
  accountId: '123456789012',
  region: 'us-east-1',
};
const args = ['deploy', 'app-staging', '--app', 'cdk.out', '--require-approval', 'never'];
const make = (f: ReturnType<typeof fakes>, over = {}) =>
  new CodeBuildDeployer({
    s3: f.s3,
    codebuild: f.codebuild,
    bucket: 'bkt',
    projects: { '123456789012': 'Deployer-123456789012' },
    roleName: 'CloudEngineerDeploy',
    externalId: 'ext-1',
    pollMs: 1,
    sleep: async () => {},
    ...over,
  });

describe('CodeBuildDeployer', () => {
  it('uploads the whole assembly, starts a build for the role in the target account and returns outputs', async () => {
    const f = fakes('SUCCEEDED', '{"app-staging":{"ApiUrl":"https://api.example.com"}}');
    const res = await make(f).exec(args, await assembly(), ctx);
    expect(res).toMatchObject({
      exitCode: 0,
      outputs: { 'app-staging': { ApiUrl: 'https://api.example.com' } },
    });
    expect(f.s3Calls[0]!.input).toMatchObject({
      Key: 'build-input/run-1/assembly.zip',
      ServerSideEncryption: 'aws:kms',
    });
    // Bundled dependencies inside assets must travel with the approved assembly.
    expect((f.s3Calls[0]!.input.Body as Buffer).includes('bundled dependency')).toBe(true);
    const start = f.cbCalls[0]!.input;
    expect(start.projectName).toBe('Deployer-123456789012');
    expect(start.sourceLocationOverride).toBe('bkt/build-input/run-1/assembly.zip');
    expect(start.environmentVariablesOverride).toEqual(
      expect.arrayContaining([
        {
          name: 'TARGET_ROLE_ARN',
          value: 'arn:aws:iam::123456789012:role/CloudEngineerDeploy',
          type: 'PLAINTEXT',
        },
        { name: 'EXPECTED_ACCOUNT', value: '123456789012', type: 'PLAINTEXT' },
        { name: 'STACK_NAME', value: 'app-staging', type: 'PLAINTEXT' },
      ]),
    );
  });

  it('refuses accounts outside the allow-list without uploading or starting anything', async () => {
    const f = fakes('SUCCEEDED', '{}');
    const d = make(f);
    await expect(
      d.exec(args, await assembly(), { ...ctx, accountId: '999999999999' }),
    ).rejects.toMatchObject({
      code: 'BLOCKED',
    });
    await expect(d.callerAccount('us-east-1', '999999999999')).rejects.toMatchObject({
      code: 'BLOCKED',
    });
    await expect(d.callerAccount('us-east-1')).rejects.toThrow(/target account/);
    expect(f.s3Calls).toHaveLength(0);
    expect(f.cbCalls).toHaveLength(0);
  });

  it('rejects unexpected arguments and unsafe context values', async () => {
    const f = fakes('SUCCEEDED', '{}');
    const d = make(f);
    const dir = await assembly();
    await expect(d.exec(['destroy', 'app-staging'], dir, ctx)).rejects.toThrow(
      /Unexpected deploy arguments/,
    );
    await expect(d.exec(args, dir, { ...ctx, stackName: 'x; rm -rf /' })).rejects.toThrow(
      /Invalid deploy context/,
    );
    await expect(d.exec(args, dir)).rejects.toThrow(/Missing deploy context/);
    expect(f.cbCalls).toHaveLength(0);
  });

  it('reports a failed build, a missing output and a timeout without claiming success', async () => {
    const dir = await assembly();
    const failed = await make(fakes('FAILED')).exec(args, dir, ctx);
    expect(failed.exitCode).toBe(1);
    expect(failed.log).toContain('cdk failed');
    const noOut = await make(fakes('SUCCEEDED')).exec(args, dir, ctx);
    expect(noOut).toMatchObject({ exitCode: 1 });
    expect(noOut.log).toContain('no cdk-outputs.json');
    const f = fakes('IN_PROGRESS');
    const timedOut = await make(f, { timeoutMs: -1 }).exec(args, dir, ctx);
    expect(timedOut.exitCode).toBe(1);
    expect(timedOut.log).toContain('CloudFormation stack state');
    expect(f.cbCalls.map((c) => c.name)).toContain('StopBuildCommand');
  });

  it('validates its configuration', () => {
    const f = fakes('SUCCEEDED');
    expect(() => make(f, { projects: {} })).toThrow(/projects/);
    expect(() => make(f, { projects: { nope: 'p' } })).toThrow(/projects/);
    expect(() => make(f, { roleName: 'bad/role' })).toThrow(/role name/);
  });
});
