import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureProvider } from '@cloud-engineer/planning';
import { createRun } from './pipeline.js';
import { blueprint, opts, roots, setup } from './pipeline.fixtures.js';
import {
  createWorker,
  submitAnswers,
  submitApproval,
  type TaskCallbacks,
  type TokenStore,
  type WaitKind,
  type WorkspaceStore,
} from './worker.js';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

class MemoryTokens implements TokenStore {
  readonly map = new Map<string, string>();
  async save(runId: string, kind: WaitKind, token: string) {
    this.map.set(`${runId}|${kind}`, token);
  }
  async take(runId: string, kind: WaitKind) {
    const key = `${runId}|${kind}`;
    const token = this.map.get(key);
    this.map.delete(key);
    return token;
  }
}
const callbacks = (fail = false) => {
  const sent: { token: string; output: Record<string, unknown> }[] = [];
  const cb: TaskCallbacks = {
    success: async (token, output) => {
      if (fail) throw new Error('SendTaskSuccess failed');
      sent.push({ token, output });
    },
  };
  return { cb, sent };
};

async function seed(d: Parameters<typeof createRun>[0]) {
  return d.engine.createRun({
    prompt: opts.prompt,
    region: opts.region,
    targetEnvironment: 'staging',
  });
}

describe('worker', () => {
  it('drives a run to the approval gate and reports the exact plan to approve', async () => {
    const ctx = await setup();
    const tokens = new MemoryTokens();
    const worker = createWorker({ pipeline: ctx.d, tokens });
    const run = await createRun(ctx.d, opts);
    const res = await worker({ action: 'advance', runId: run.runId });
    expect(res).toMatchObject({ status: 'AWAITING_APPROVAL', environment: 'staging' });
    expect(res.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await worker({ action: 'advance', runId: run.runId })).toEqual(res); // repeatable
    expect(ctx.execCalls).toHaveLength(0);
  });

  it('deploys with an approved decision, verifies, and refuses a replay', async () => {
    const ctx = await setup();
    const worker = createWorker({ pipeline: ctx.d, tokens: new MemoryTokens() });
    const run = await createRun(ctx.d, opts);
    const { planHash } = await worker({ action: 'advance', runId: run.runId });
    const decision = {
      approved: true as const,
      planHash: planHash as string,
      environment: 'staging',
      actor: 'me',
    };
    expect(await worker({ action: 'deploy', runId: run.runId, decision })).toEqual({
      deployed: true,
      verified: true,
    });
    expect(await worker({ action: 'verify', runId: run.runId })).toEqual({ verified: true });
    expect(await worker({ action: 'advance', runId: run.runId })).toEqual({ status: 'SUCCEEDED' });
    await expect(worker({ action: 'deploy', runId: run.runId, decision })).rejects.toThrow();
    expect(ctx.execCalls).toHaveLength(1);
  });

  it('fails deploy and verify honestly when the deployment does not succeed', async () => {
    const ctx = await setup({ execCode: 1 });
    const worker = createWorker({ pipeline: ctx.d, tokens: new MemoryTokens() });
    const run = await createRun(ctx.d, opts);
    const { planHash } = await worker({ action: 'advance', runId: run.runId });
    await expect(
      worker({
        action: 'deploy',
        runId: run.runId,
        decision: {
          approved: true,
          planHash: planHash as string,
          environment: 'staging',
          actor: 'me',
        },
      }),
    ).rejects.toThrow(/Deployment failed/);
    await expect(worker({ action: 'verify', runId: run.runId })).rejects.toThrow(/not verified/);
  });

  it('markFailed records the failure once and leaves finished runs alone', async () => {
    const ctx = await setup();
    const worker = createWorker({ pipeline: ctx.d, tokens: new MemoryTokens() });
    const run = await seed(ctx.d);
    await worker({ action: 'markFailed', runId: run.runId, error: { Cause: 'boom' } });
    expect((await ctx.d.engine.getRun(run.runId)).status).toBe('FAILED');
    await worker({ action: 'markFailed', runId: run.runId });
    const events = await ctx.d.engine.listEvents(run.runId);
    expect(events.filter((e) => e.type === 'RunFailed')).toHaveLength(1);
  });

  it('rejects malformed run ids and restores/persists the workspace around work', async () => {
    const ctx = await setup();
    const calls: string[] = [];
    const workspace: WorkspaceStore = {
      restore: async (id) => void calls.push(`restore:${id}`),
      persist: async (id) => void calls.push(`persist:${id}`),
    };
    const worker = createWorker({ pipeline: ctx.d, tokens: new MemoryTokens(), workspace });
    await expect(worker({ action: 'advance', runId: '../x' })).rejects.toThrow(/Invalid run id/);
    const run = await createRun(ctx.d, opts);
    calls.length = 0;
    await worker({ action: 'advance', runId: run.runId });
    expect(calls).toEqual([`restore:${run.runId}`]); // already at the gate: nothing new to persist
  });
});

describe('approval API', () => {
  async function gate() {
    const ctx = await setup();
    const tokens = new MemoryTokens();
    const worker = createWorker({ pipeline: ctx.d, tokens });
    const run = await createRun(ctx.d, opts);
    const res = await worker({ action: 'advance', runId: run.runId });
    await worker({ action: 'registerApprovalWait', runId: run.runId, taskToken: 'tok-1' });
    return {
      ...ctx,
      tokens,
      run,
      planHash: res.planHash as string,
      w: { pipeline: ctx.d, tokens },
    };
  }

  it('delivers an approval bound to the plan, once', async () => {
    const g = await gate();
    const { cb, sent } = callbacks();
    const decision = { approved: true, planHash: g.planHash, environment: 'staging', actor: 'me' };
    await submitApproval(g.w, cb, g.run.runId, decision);
    expect(sent).toEqual([{ token: 'tok-1', output: decision }]);
    await expect(submitApproval(g.w, cb, g.run.runId, decision)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a wrong hash or environment without consuming the token', async () => {
    const g = await gate();
    const { cb, sent } = callbacks();
    for (const bad of [
      { planHash: '0'.repeat(64), environment: 'staging' },
      { planHash: g.planHash, environment: 'production' },
    ]) {
      await expect(
        submitApproval(g.w, cb, g.run.runId, { approved: true, actor: 'me', ...bad }),
      ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    }
    expect(sent).toHaveLength(0);
    expect(g.tokens.map.get(`${g.run.runId}|approval`)).toBe('tok-1');
  });

  it('keeps the token when delivery fails, and delivers a rejection without a hash check', async () => {
    const g = await gate();
    const decision = { approved: true, planHash: g.planHash, environment: 'staging', actor: 'me' };
    await expect(submitApproval(g.w, callbacks(true).cb, g.run.runId, decision)).rejects.toThrow(
      /SendTaskSuccess/,
    );
    expect(g.tokens.map.get(`${g.run.runId}|approval`)).toBe('tok-1');
    const { cb, sent } = callbacks();
    await submitApproval(g.w, cb, g.run.runId, { ...decision, approved: false, planHash: 'x' });
    expect(sent[0]!.output).toMatchObject({ approved: false });
  });
});

describe('answers API', () => {
  const ask = JSON.stringify({ needsInput: { questions: ['Which payment provider?'] } });

  it('records answers, releases the waiting task, and keeps the token on bad input', async () => {
    const ctx = await setup({ provider: new FixtureProvider([ask, JSON.stringify(blueprint)]) });
    const tokens = new MemoryTokens();
    const worker = createWorker({ pipeline: ctx.d, tokens });
    const run = await createRun(ctx.d, opts);
    const res = await worker({ action: 'advance', runId: run.runId });
    expect(res).toMatchObject({ status: 'NEEDS_INPUT', questions: ['Which payment provider?'] });
    await worker({ action: 'registerInputWait', runId: run.runId, taskToken: 'tok-2' });

    const { cb, sent } = callbacks();
    const w = { pipeline: ctx.d, tokens };
    await expect(submitAnswers(w, cb, run.runId, [], 'me')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(tokens.map.get(`${run.runId}|input`)).toBe('tok-2');

    await submitAnswers(w, cb, run.runId, ['Stripe'], 'me');
    expect(sent).toEqual([{ token: 'tok-2', output: { actor: 'me' } }]);
    // The workflow then calls advance again, which continues planning with the decision.
    expect(await worker({ action: 'advance', runId: run.runId })).toMatchObject({
      status: 'AWAITING_APPROVAL',
    });
  });
});
