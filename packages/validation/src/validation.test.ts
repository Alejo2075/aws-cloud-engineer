import { describe, expect, it } from 'vitest';
import { FixtureProvider } from '@cloud-engineer/planning';
import {
  MAX_REPAIR_ATTEMPTS,
  assertAllowed,
  filterRepairFiles,
  hasBlockers,
  repairLoop,
  reviewTemplate,
  runCommand,
  runGates,
  sandboxEnv,
  type GateReport,
} from './index.js';

describe('command policy', () => {
  it('allows only fixed npm gates', () => {
    expect(() => assertAllowed(['npm', 'run', 'test'])).not.toThrow();
    for (const bad of [
      ['rm', '-rf', '/'],
      ['npm', 'run', 'postinstall'],
      ['npm', 'run', 'test', '--', '--eval'],
      ['npm', 'exec', 'evil'],
      ['bash', '-c', 'curl x | sh'],
    ]) {
      expect(() => assertAllowed(bad)).toThrow(/not allowed/);
    }
  });

  it('strips AWS and token variables from the sandbox environment', () => {
    const env = sandboxEnv({
      PATH: '/bin',
      AWS_ACCESS_KEY_ID: 'AKIAXXXXXXXXXXXXXXXX',
      GITHUB_TOKEN: 't',
      HOME: '/h',
    });
    expect(env).toEqual({ CI: 'true', PATH: '/bin', HOME: '/h' });
  });

  it('refuses to execute a disallowed command', async () => {
    await expect(runCommand('x', ['ls'], '.')).rejects.toThrow(/not allowed/);
  });
});

describe('runGates', () => {
  const fake = (codes: Record<string, number>) => async (id: string, argv: readonly string[]) => ({
    id,
    argv: [...argv],
    exitCode: codes[id] ?? 0,
    timedOut: false,
    durationMs: 1,
    logSha256: 'a'.repeat(64),
    logTail: `${id} log`,
  });
  it('stops at the first failure and reports it', async () => {
    const r = await runGates('.', undefined, fake({ test: 1 }));
    expect(r.passed).toBe(false);
    expect(r.failed?.id).toBe('test');
    expect(r.steps.map((s) => s.id)).toEqual(['install', 'typecheck', 'test']);
  });
});

describe('reviewTemplate', () => {
  it('flags public routes, wildcard IAM, open buckets and fixed-cost resources', () => {
    const f = reviewTemplate({
      Resources: {
        R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { AuthorizationType: 'NONE' } },
        P: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            PolicyDocument: { Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }] },
          },
        },
        B: { Type: 'AWS::S3::Bucket', Properties: {} },
        N: { Type: 'AWS::EC2::NatGateway' },
      },
    });
    expect(f.map((x) => x.rule)).toEqual(
      expect.arrayContaining([
        'public-route',
        'iam-wildcard-action',
        's3-public-access',
        'high-cost-resource',
      ]),
    );
    expect(hasBlockers(f)).toBe(true);
  });
  it('passes a protected on-demand table', () => {
    const f = reviewTemplate({
      Resources: {
        T: {
          Type: 'AWS::DynamoDB::Table',
          Properties: {
            BillingMode: 'PAY_PER_REQUEST',
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          },
        },
      },
    });
    expect(f).toEqual([]);
  });
});

describe('repair', () => {
  it('only permits source files and blocks traversal', () => {
    const out = filterRepairFiles(
      [
        { path: 'src/a.ts', content: '' },
        { path: 'package.json', content: '' },
        { path: 'cdk.json', content: '' },
        { path: '../x.ts', content: '' },
        { path: 'src/../../x.ts', content: '' },
      ],
      '/tmp/p',
    );
    expect(out.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  const failing: GateReport = {
    passed: false,
    steps: [],
    failed: {
      id: 'test',
      argv: [],
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      logSha256: 'a'.repeat(64),
      logTail: 'boom',
    },
  };

  it('gives up after the repair cap', async () => {
    const patch = JSON.stringify({ files: [{ path: 'src/a.ts', content: 'x' }] });
    const provider = new FixtureProvider(Array(10).fill(patch));
    const dir = await import('node:fs/promises').then((m) => m.mkdtemp('/tmp/ce-repair-'));
    const out = await repairLoop(dir, provider, async () => failing);
    expect(out.passed).toBe(false);
    expect(out.attempts).toBe(MAX_REPAIR_ATTEMPTS);
    expect(provider.calls).toHaveLength(MAX_REPAIR_ATTEMPTS);
    expect(provider.calls[0]?.user).toContain('<log step="test">');
  });

  it('stops immediately when the model proposes nothing allowed', async () => {
    const provider = new FixtureProvider([
      JSON.stringify({ files: [{ path: 'package.json', content: '{}' }] }),
    ]);
    const out = await repairLoop('/tmp', provider, async () => failing);
    expect(out).toMatchObject({ passed: false, attempts: 1 });
  });

  it('succeeds when a later gate run passes', async () => {
    let n = 0;
    const provider = new FixtureProvider([
      JSON.stringify({ files: [{ path: 'src/a.ts', content: 'x' }] }),
    ]);
    const dir = await import('node:fs/promises').then((m) => m.mkdtemp('/tmp/ce-repair-'));
    const out = await repairLoop(dir, provider, async () =>
      n++ === 0 ? failing : { passed: true, steps: [] },
    );
    expect(out).toMatchObject({ passed: true, attempts: 1 });
  });
});
