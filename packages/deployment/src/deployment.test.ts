import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Approval } from '@cloud-engineer/contracts';
import {
  buildDeployArgs,
  deployEnv,
  canonicalJson,
  createDeploymentPlan,
  deploy,
  hashAssembly,
  planHashOf,
  renderPlan,
  verifyApi,
  verifySite,
  type DeployDeps,
} from './index.js';

const template = JSON.stringify({
  Resources: {
    Table: {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    },
    Api: { Type: 'AWS::ApiGatewayV2::Api' },
    Role: { Type: 'AWS::IAM::Role', Properties: {} },
  },
});
const base = {
  runId: 'run-1',
  stackName: 'app-staging',
  accountId: '123456789012',
  region: 'us-east-1',
  environment: 'staging',
  templateText: template,
  assemblySha256: 'a'.repeat(64),
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function project(text = template) {
  const dir = await mkdtemp(join(tmpdir(), 'ce-deploy-'));
  dirs.push(dir);
  await mkdir(join(dir, 'cdk.out'));
  await writeFile(join(dir, 'cdk.out', 'app-staging.template.json'), text);
  return dir;
}
const planned = async (dir: string) =>
  createDeploymentPlan({ ...base, assemblySha256: await hashAssembly(join(dir, 'cdk.out')) });
const approvalFor = (hash: string, over: Partial<Approval> = {}): Approval => ({
  runId: 'run-1',
  stage: 'deployment',
  planHash: hash,
  targetEnvironment: 'staging',
  actor: 'me',
  approvedAt: new Date().toISOString(),
  ...over,
});
const deps = (account = '123456789012', exitCode: number | null = 0) => {
  const calls: string[][] = [];
  const d: DeployDeps = {
    callerAccount: async () => account,
    exec: async (args) => {
      calls.push(args);
      return {
        exitCode,
        log: 'log',
        outputs: { 'app-staging': { ApiUrl: 'https://x.example' } },
      };
    },
  };
  return { d, calls };
};

describe('plan', () => {
  it('is stable regardless of key order and lists resources, risks and approval gates', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
    const a = createDeploymentPlan(base);
    expect(createDeploymentPlan(base).hash).toBe(a.hash);
    expect(a.plan.resources.map((r) => r.logicalId)).toEqual(['Api', 'Role', 'Table']);
    expect(a.plan.requiresApprovalFor).toEqual(
      expect.arrayContaining(['first-deployment', 'iam-creation', 'public-endpoint']),
    );
    expect(renderPlan(a.plan, a.hash)).toContain('Estimate');
  });

  it('changes the hash when the environment changes and adds the production gate', () => {
    const prod = createDeploymentPlan({ ...base, environment: 'production' });
    expect(prod.hash).not.toBe(createDeploymentPlan(base).hash);
    expect(prod.plan.requiresApprovalFor).toContain('production');
  });

  it('refuses to plan a template with a public route', () => {
    const bad = JSON.stringify({
      Resources: {
        R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { AuthorizationType: 'NONE' } },
      },
    });
    expect(() => createDeploymentPlan({ ...base, templateText: bad })).toThrow(/high-severity/);
  });

  it('rejects a malformed account id', () => {
    expect(() => createDeploymentPlan({ ...base, accountId: 'abc' })).toThrow(/12 digits/);
  });
});

describe('deploy', () => {
  it('deploys the pre-synthesized assembly with the approved plan', async () => {
    const dir = await project();
    const { plan, hash } = await planned(dir);
    const { d, calls } = deps();
    const res = await deploy(dir, plan, approvalFor(hash), d);
    expect(res).toEqual({ status: 'deployed', outputs: { ApiUrl: 'https://x.example' } });
    expect(calls[0]).toEqual(buildDeployArgs(plan, 'cdk-outputs.json'));
    expect(calls[0]).toContain('cdk.out');
  });

  it.each([
    ['wrong plan hash', () => approvalFor('0'.repeat(64)), undefined],
    [
      'wrong environment',
      (h: string) => approvalFor(h, { targetEnvironment: 'production' }),
      undefined,
    ],
    ['wrong run', (h: string) => approvalFor(h, { runId: 'other' }), undefined],
  ])('refuses %s without executing anything', async (_n, mk) => {
    const dir = await project();
    const { plan, hash } = await planned(dir);
    const { d, calls } = deps();
    await expect(deploy(dir, plan, mk(hash), d)).rejects.toMatchObject({
      code: 'APPROVAL_MISMATCH',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses when the cloud assembly changed after planning', async () => {
    const dir = await project();
    const { plan, hash } = await planned(dir);
    await writeFile(join(dir, 'cdk.out', 'app-staging.template.json'), template + ' ');
    const { d, calls } = deps();
    await expect(deploy(dir, plan, approvalFor(hash), d)).rejects.toThrow(/changed since the plan/);
    expect(calls).toHaveLength(0);
  });

  it('refuses when only an asset file changed (not the template)', async () => {
    const dir = await project();
    await mkdir(join(dir, 'cdk.out', 'asset.1'));
    await writeFile(join(dir, 'cdk.out', 'asset.1', 'index.mjs'), 'good');
    const { plan, hash } = await planned(dir);
    await writeFile(join(dir, 'cdk.out', 'asset.1', 'index.mjs'), 'evil');
    const { d, calls } = deps();
    await expect(deploy(dir, plan, approvalFor(hash), d)).rejects.toThrow(/changed since the plan/);
    expect(calls).toHaveLength(0);
  });

  it('refuses when credentials belong to a different account', async () => {
    const dir = await project();
    const { plan, hash } = await planned(dir);
    const { d, calls } = deps('999999999999');
    await expect(deploy(dir, plan, approvalFor(hash), d)).rejects.toThrow(/999999999999/);
    expect(calls).toHaveLength(0);
  });

  it('reports a failed deployment instead of success', async () => {
    const dir = await project();
    const { plan, hash } = await planned(dir);
    const res = await deploy(dir, plan, approvalFor(hash), deps('123456789012', 1).d);
    expect(res.status).toBe('failed');
  });

  it('planHashOf matches the hash returned at planning time', () => {
    const { plan, hash } = createDeploymentPlan(base);
    expect(planHashOf(plan)).toBe(hash);
  });
});

describe('deployEnv', () => {
  it('passes only AWS settings and PATH, with an isolated HOME', () => {
    const env = deployEnv('/work', {
      PATH: '/bin',
      HOME: '/Users/me',
      AWS_PROFILE: 'p',
      AWS_REGION: 'us-east-1',
      GITHUB_TOKEN: 'x',
      NODE_OPTIONS: '--require /evil.js',
      NPM_CONFIG_REGISTRY: 'https://evil.example',
    });
    expect(env.HOME).toBe('/work');
    expect(env.AWS_PROFILE).toBe('p');
    expect(Object.keys(env)).not.toEqual(expect.arrayContaining(['GITHUB_TOKEN']));
    for (const k of ['GITHUB_TOKEN', 'NODE_OPTIONS', 'NPM_CONFIG_REGISTRY']) {
      expect(k in env).toBe(false);
    }
  });
});

describe('verifyApi', () => {
  const res = (status: number) => async () => new Response(null, { status });
  it('verifies when HTTPS and unauthenticated calls are rejected', async () => {
    const r = await verifyApi('https://x.example', ['bookings'], res(401) as typeof fetch);
    expect(r.verified).toBe(true);
  });
  it('fails when a route is publicly readable', async () => {
    const r = await verifyApi('https://x.example', ['bookings'], res(200) as typeof fetch);
    expect(r.verified).toBe(false);
  });
  it('fails on network errors and non-HTTPS URLs', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const r = await verifyApi('http://x.example', ['bookings'], boom);
    expect(r.verified).toBe(false);
    expect(r.checks.map((c) => c.detail)).toContain('ECONNREFUSED');
  });
});

describe('verifySite', () => {
  const site = (over: { status?: number; headers?: Record<string, string>; cfg?: unknown } = {}) =>
    (async (url: string) => {
      if (String(url).endsWith('/config.json')) {
        return new Response(JSON.stringify(over.cfg ?? { apiUrl: 'https://api.example.com' }), {
          status: 200,
        });
      }
      return new Response('<html>', {
        status: over.status ?? 200,
        headers: over.headers ?? {
          'content-security-policy': "default-src 'self'",
          'strict-transport-security': 'max-age=1',
        },
      });
    }) as unknown as typeof fetch;

  it('verifies a healthy site with security headers and a config', async () => {
    expect((await verifySite('https://d1.cloudfront.net', site())).verified).toBe(true);
  });
  it('fails without CSP/HSTS headers', async () => {
    const r = await verifySite('https://d1.cloudfront.net', site({ headers: {} }));
    expect(r.verified).toBe(false);
    expect(r.checks.filter((c) => !c.passed).map((c) => c.detail)).toEqual([
      'content-security-policy',
      'strict-transport-security',
    ]);
  });
  it('fails when config.json does not point at an https API', async () => {
    const r = await verifySite('https://d1.cloudfront.net', site({ cfg: { apiUrl: 'http://x' } }));
    expect(r.verified).toBe(false);
  });
  it('fails on http URLs and network errors', async () => {
    const boom = (async () => {
      throw new Error('ENOTFOUND');
    }) as typeof fetch;
    const r = await verifySite('http://x', boom);
    expect(r.verified).toBe(false);
  });
});
