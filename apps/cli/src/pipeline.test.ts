import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureProvider } from '@cloud-engineer/planning';
import { S3ArtifactStore } from '@cloud-engineer/providers';
import { FileRunStore, WorkflowEngine } from '@cloud-engineer/workflow';
import type { DeployDeps } from '@cloud-engineer/deployment';
import {
  approveAndDeploy,
  createRun,
  exportRun,
  loadPlan,
  pendingQuestions,
  projectDir,
  respondToInput,
  resumeRun,
  type PipelineDeps,
} from './pipeline.js';

const blueprint = {
  schemaVersion: '1.0.0',
  kind: 'ApplicationBlueprint',
  name: 'booking-app',
  requirements: [{ id: 'R1', type: 'functional', text: 'Create bookings' }],
  entities: [{ name: 'Booking', fields: [{ name: 'guestName', type: 'string', required: true }] }],
  components: [{ id: 'C1', type: 'api', awsService: 'API Gateway', justification: 'HTTP API' }],
  tasks: [{ id: 'T1', title: 'API', satisfies: ['R1'], acceptance: ['works'] }],
  risks: [],
};
const template = {
  Resources: {
    Table: {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    },
    Api: { Type: 'AWS::ApiGatewayV2::Api' },
  },
};
const ACCOUNT = '123456789012';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function setup(
  over: Partial<PipelineDeps> & { gateFails?: boolean; status?: number; execCode?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'ce-e2e-'));
  roots.push(root);
  const execCalls: string[][] = [];
  const deployDeps: DeployDeps = {
    callerAccount: async () => ACCOUNT,
    exec: async (args) => {
      execCalls.push(args);
      return {
        exitCode: over.execCode ?? 0,
        log: 'cdk log',
        outputs: { 'booking-app-staging': { ApiUrl: 'https://api.example.com' } },
      };
    },
  };
  const d: PipelineDeps = {
    engine: new WorkflowEngine(new FileRunStore(root)),
    root,
    provider: new FixtureProvider([JSON.stringify(blueprint)]),
    gates: async (dir) => {
      if (over.gateFails) {
        return {
          passed: false,
          steps: [],
          failed: {
            id: 'test',
            argv: ['npm', 'test'],
            exitCode: 1,
            timedOut: false,
            durationMs: 1,
            logSha256: 'a'.repeat(64),
            logTail: 'boom',
          },
        };
      }
      await mkdir(join(dir, 'cdk.out'), { recursive: true });
      await writeFile(
        join(dir, 'cdk.out', 'booking-app-staging.template.json'),
        JSON.stringify(template),
      );
      return { passed: true, steps: [] };
    },
    deployDeps,
    fetchImpl: (async () => new Response(null, { status: over.status ?? 401 })) as typeof fetch,
    ...over,
  };
  return { d, execCalls, root };
}
const opts = {
  prompt: 'booking app',
  region: 'us-east-1',
  environment: 'staging',
  accountId: ACCOUNT,
};

describe('pipeline', () => {
  it('runs prompt -> approval gate without deploying anything', async () => {
    const { d, execCalls } = await setup();
    const run = await createRun(d, opts);
    expect(run.stage).toBe('AWAITING_APPROVAL');
    expect(run.status).toBe('ACTIVE');
    expect(run.artifacts.map((a) => a.kind)).toEqual(
      expect.arrayContaining([
        'prompt',
        'requirements',
        'blueprint',
        'source',
        'test-report',
        'plan',
      ]),
    );
    expect(execCalls).toHaveLength(0);
    const { hash } = await loadPlan(d, run.runId);
    expect(run.artifacts.findLast((a) => a.kind === 'plan')?.sha256).toBe(hash);
  });

  it('deploys only after approval, verifies, hands off and exports', async () => {
    const { d, execCalls, root } = await setup();
    const run = await createRun(d, opts);
    const { hash } = await loadPlan(d, run.runId);
    const res = await approveAndDeploy(d, run.runId, {
      planHash: hash,
      environment: 'staging',
      actor: 'me',
    });
    expect(res).toMatchObject({ deployed: true, verified: true });
    expect(res.run.status).toBe('SUCCEEDED');
    expect(execCalls).toHaveLength(1);
    const manifestRef = res.run.artifacts.findLast((a) => a.kind === 'manifest');
    expect(manifestRef).toBeDefined();

    const out = join(root, 'export');
    await exportRun(d, run.runId, out);
    const manifest = JSON.parse(await readFile(join(out, 'cloud-system-manifest.json'), 'utf8'));
    expect(manifest.environments[0]).toMatchObject({ accountId: ACCOUNT, region: 'us-east-1' });
    expect(manifest.deployment.verifiedAt).toBeDefined();
    expect(await readdir(out)).toEqual(
      expect.arrayContaining(['src', 'lib', 'cloud-system-manifest.json']),
    );
    expect(JSON.stringify(manifest)).not.toMatch(/AKIA|secret/i);

    const gitOut = join(root, 'export-git');
    const written = await exportRun(d, run.runId, gitOut, { git: true });
    expect(written.at(-1)).toMatch(/^git:[0-9a-f]{40}$/);
    expect(await readdir(gitOut)).toContain('.git');
  });

  it('refuses a wrong plan hash and never calls the deployer', async () => {
    const { d, execCalls } = await setup();
    const run = await createRun(d, opts);
    await expect(
      approveAndDeploy(d, run.runId, {
        planHash: '0'.repeat(64),
        environment: 'staging',
        actor: 'me',
      }),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    expect(execCalls).toHaveLength(0);
    expect((await d.engine.getRun(run.runId)).stage).toBe('AWAITING_APPROVAL');
  });

  it('marks the run FAILED, with no plan, when a quality gate fails', async () => {
    const { d } = await setup({ gateFails: true });
    await expect(createRun(d, opts)).rejects.toThrow(/Quality gate failed: test/);
    const [run] = await d.engine
      .getRun((await new FileRunStore(d.root).list())[0]!.runId)
      .then((r) => [r]);
    expect(run?.status).toBe('FAILED');
    expect(run?.artifacts.some((a) => a.kind === 'plan')).toBe(false);
  });

  it('reports deployed-but-not-verified when the API is publicly readable', async () => {
    const { d } = await setup({ status: 200 });
    const run = await createRun(d, opts);
    const { hash } = await loadPlan(d, run.runId);
    const res = await approveAndDeploy(d, run.runId, {
      planHash: hash,
      environment: 'staging',
      actor: 'me',
    });
    expect(res).toMatchObject({ deployed: true, verified: false });
    expect(res.run.status).toBe('FAILED');
    expect(res.run.artifacts.some((a) => a.kind === 'manifest')).toBe(false);
  });

  it('reports a failed deployment honestly', async () => {
    const { d } = await setup({ execCode: 1 });
    const run = await createRun(d, opts);
    const { hash } = await loadPlan(d, run.runId);
    const res = await approveAndDeploy(d, run.runId, {
      planHash: hash,
      environment: 'staging',
      actor: 'me',
    });
    expect(res).toMatchObject({ deployed: false, verified: false });
    expect(res.run.status).toBe('FAILED');
  });

  it('requires an explicit 12-digit account', async () => {
    const { d } = await setup();
    await expect(createRun(d, { ...opts, accountId: 'x' })).rejects.toThrow(/12-digit/);
  });

  it('keeps generated source inside the run directory', async () => {
    const { d, root } = await setup();
    const run = await createRun(d, opts);
    expect(projectDir(root, run.runId).startsWith(root)).toBe(true);
  });
});

describe('supplied blueprint', () => {
  it('skips the model but applies the same validation', async () => {
    const { d } = await setup({ provider: new FixtureProvider([]) });
    const run = await createRun(d, { ...opts, blueprint });
    expect(run.stage).toBe('AWAITING_APPROVAL');
    const bad = { ...blueprint, tasks: [] };
    await expect(createRun(d, { ...opts, blueprint: bad })).rejects.toThrow(/no task/);
  });
});

describe('resume', () => {
  it('retries a failed quality gate from BUILD without redoing earlier stages', async () => {
    const ctx = await setup({ gateFails: true });
    await expect(createRun(ctx.d, opts)).rejects.toThrow(/Quality gate failed/);
    const failed = (await ctx.d.engine.listRuns())[0]!;
    expect(failed).toMatchObject({ status: 'FAILED', stage: 'BUILD' });
    const sourceHashes = failed.artifacts.filter((a) => a.kind === 'source').length;

    // "fix" the problem: gates now pass
    const fixed = await setup();
    const run = await resumeRun({ ...ctx.d, gates: fixed.d.gates }, failed.runId, 'me');
    expect(run).toMatchObject({ status: 'ACTIVE', stage: 'AWAITING_APPROVAL' });
    expect(run.artifacts.filter((a) => a.kind === 'source')).toHaveLength(sourceHashes);
    expect((await ctx.d.engine.listEvents(failed.runId)).map((e) => e.type)).toContain(
      'RunResumed',
    );
  });

  it('re-plans with the model when planning failed', async () => {
    const ctx = await setup({
      provider: new FixtureProvider(['{"bad":true}', '{"bad":true}', '{"bad":true}']),
    });
    await expect(createRun(ctx.d, opts)).rejects.toThrow(/Blueprint invalid/);
    const failed = (await ctx.d.engine.listRuns())[0]!;
    expect(failed.stage).toBe('REQUIREMENTS');
    const run = await resumeRun(
      { ...ctx.d, provider: new FixtureProvider([JSON.stringify(blueprint)]) },
      failed.runId,
    );
    expect(run.stage).toBe('AWAITING_APPROVAL');
  });

  it('refuses to resume a run that failed after approval, and never redeploys', async () => {
    const ctx = await setup({ execCode: 1 });
    const run = await createRun(ctx.d, opts);
    const { hash } = await loadPlan(ctx.d, run.runId);
    await approveAndDeploy(ctx.d, run.runId, {
      planHash: hash,
      environment: 'staging',
      actor: 'me',
    });
    await expect(resumeRun(ctx.d, run.runId)).rejects.toThrow(/deployments are not replayed/);
    expect(ctx.execCalls).toHaveLength(1);
  });

  it('refuses to resume cancelled or succeeded runs', async () => {
    const ctx = await setup();
    const run = await createRun(ctx.d, opts);
    await ctx.d.engine.cancel(run.runId);
    await expect(resumeRun(ctx.d, run.runId)).rejects.toThrow(/cannot be resumed/);
  });
});

describe('site verification', () => {
  it('requires the frontend to pass its own checks when SiteUrl is an output', async () => {
    const ctx = await setup({
      deployDeps: {
        callerAccount: async () => ACCOUNT,
        exec: async () => ({
          exitCode: 0,
          log: '',
          outputs: {
            'booking-app-staging': {
              ApiUrl: 'https://api.example.com',
              SiteUrl: 'https://d1.cloudfront.net',
            },
          },
        }),
      },
      // API says 401 (good) but the site has no security headers and no config
      fetchImpl: (async (url: string) =>
        String(url).includes('cloudfront')
          ? new Response('x', { status: 200 })
          : new Response(null, { status: 401 })) as unknown as typeof fetch,
    });
    const run = await createRun(ctx.d, opts);
    const { hash } = await loadPlan(ctx.d, run.runId);
    const res = await approveAndDeploy(ctx.d, run.runId, {
      planHash: hash,
      environment: 'staging',
      actor: 'me',
    });
    expect(res).toMatchObject({ deployed: true, verified: false });
    expect(res.run.status).toBe('FAILED');
  });
});

describe('needs input', () => {
  const ask = JSON.stringify({ needsInput: { questions: ['Which payment provider?'] } });

  it('stops at NEEDS_INPUT, then continues with the recorded answer', async () => {
    const provider = new FixtureProvider([ask, JSON.stringify(blueprint)]);
    const ctx = await setup({ provider });
    const waiting = await createRun(ctx.d, opts);
    expect(waiting).toMatchObject({ status: 'NEEDS_INPUT', stage: 'REQUIREMENTS' });
    expect(await pendingQuestions(ctx.d, waiting.runId)).toEqual(['Which payment provider?']);
    await expect(resumeRun(ctx.d, waiting.runId)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(respondToInput(ctx.d, waiting.runId, [])).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    const run = await respondToInput(ctx.d, waiting.runId, ['Stripe']);
    expect(run.stage).toBe('AWAITING_APPROVAL');
    expect(provider.calls[1]!.user).toContain('A: Stripe');
    await expect(respondToInput(ctx.d, waiting.runId, ['again'])).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('forbids further questions once the budget is spent and then fails instead of looping', async () => {
    const three = JSON.stringify({ needsInput: { questions: ['a', 'b', 'c'] } });
    const provider = new FixtureProvider([three, ask, ask, ask]);
    const ctx = await setup({ provider });
    const waiting = await createRun(ctx.d, opts);
    await expect(respondToInput(ctx.d, waiting.runId, ['1', '2', '3'])).rejects.toThrow(
      /questions are not allowed/,
    );
    expect(provider.calls[1]!.user).toContain('Do not ask questions');
    expect((await ctx.d.engine.getRun(waiting.runId)).status).toBe('FAILED');
  });
});

describe('S3 artifact store', () => {
  /** In-memory stand-in for S3 keyed by object key. */
  function fakeS3() {
    const objects = new Map<string, string>();
    const client = {
      send: async (c: { constructor: { name: string }; input: { Key: string; Body?: string } }) => {
        if (c.constructor.name === 'PutObjectCommand') {
          objects.set(c.input.Key, String(c.input.Body));
          return {};
        }
        const text = objects.get(c.input.Key);
        return text === undefined ? {} : { Body: { transformToString: async () => text } };
      },
    };
    return { objects, store: new S3ArtifactStore(client, 'bkt') };
  }

  it('keeps run artifacts in the store, deploys, and exports without a local artifacts dir', async () => {
    const { objects, store } = fakeS3();
    const { d, root } = await setup({ artifacts: store });
    const run = await createRun(d, opts);
    expect(run.artifacts.every((a) => a.uri.startsWith('s3://bkt/runs/'))).toBe(true);
    expect([...objects.keys()]).toEqual(
      expect.arrayContaining([
        `runs/${run.runId}/artifacts/blueprint.json`,
        `runs/${run.runId}/artifacts/plan.json`,
      ]),
    );
    await expect(readdir(join(root, 'runs', run.runId, 'artifacts'))).rejects.toThrow();

    const { hash } = await loadPlan(d, run.runId);
    const res = await approveAndDeploy(d, run.runId, {
      planHash: hash,
      environment: 'staging',
      actor: 'me',
    });
    expect(res).toMatchObject({ deployed: true, verified: true });
    const out = join(root, 'export');
    await exportRun(d, run.runId, out);
    expect(await readdir(out)).toContain('cloud-system-manifest.json');
  });

  it('detects a tampered plan or blueprint in the store and never deploys', async () => {
    const { objects, store } = fakeS3();
    const { d, execCalls } = await setup({ artifacts: store });
    const run = await createRun(d, opts);
    const planKey = `runs/${run.runId}/artifacts/plan.json`;
    const plan = JSON.parse(objects.get(planKey)!);
    objects.set(planKey, JSON.stringify({ ...plan, region: 'eu-west-1' }));
    await expect(loadPlan(d, run.runId)).rejects.toThrow(/does not match its recorded hash/);
    await expect(
      approveAndDeploy(d, run.runId, {
        planHash: run.artifacts.findLast((a) => a.kind === 'plan')!.sha256,
        environment: 'staging',
        actor: 'me',
      }),
    ).rejects.toThrow();
    expect(execCalls).toHaveLength(0);
  });
});
