import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureProvider } from '@cloud-engineer/planning';
import { createApi, type ApiEvent, type WorkflowStarter } from './api.js';
import { blueprint, ACCOUNT, roots, setup } from './pipeline.fixtures.js';
import { createWorker, type TaskCallbacks, type TokenStore, type WaitKind } from './worker.js';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

class Tokens implements TokenStore {
  readonly map = new Map<string, string>();
  async save(runId: string, kind: WaitKind, token: string) {
    this.map.set(`${runId}|${kind}`, token);
  }
  async take(runId: string, kind: WaitKind) {
    const k = `${runId}|${kind}`;
    const t = this.map.get(k);
    this.map.delete(k);
    return t;
  }
}

const ev = (
  method: string,
  path: string,
  body?: unknown,
  user: string | null = 'arn:aws:iam::1:user/me',
): ApiEvent => ({
  rawPath: path,
  body: body === undefined ? null : JSON.stringify(body),
  requestContext: { http: { method }, ...(user ? { authorizer: { iam: { userArn: user } } } : {}) },
});

async function api(over = {}) {
  const ctx = await setup(over);
  const tokens = new Tokens();
  const started: string[] = [];
  const stopped: string[] = [];
  const sent: { token: string; output: Record<string, unknown> }[] = [];
  const workflow: WorkflowStarter = {
    start: async (id) => void started.push(id),
    stop: async (id) => void stopped.push(id),
  };
  const callbacks: TaskCallbacks = {
    success: async (token, output) => void sent.push({ token, output }),
  };
  const deps = { pipeline: ctx.d, tokens, callbacks, workflow };
  return {
    ...ctx,
    tokens,
    started,
    stopped,
    sent,
    handle: createApi(deps),
    worker: createWorker({ pipeline: ctx.d, tokens }),
  };
}
const create = { prompt: 'booking app', accountId: ACCOUNT };
const json = (r: { body: string }) => JSON.parse(r.body);

describe('control-plane API', () => {
  it('requires an authenticated caller', async () => {
    const a = await api();
    expect((await a.handle(ev('GET', '/runs', undefined, null))).statusCode).toBe(401);
  });

  it('creates a run, starts its execution, and does no work inline', async () => {
    const a = await api();
    const res = await a.handle(ev('POST', '/runs', create));
    expect(res.statusCode).toBe(202);
    expect(a.started).toEqual([json(res).runId]);
    expect(json(res)).toMatchObject({ stage: 'CREATED', status: 'ACTIVE' });
    expect(a.execCalls).toHaveLength(0);
    expect(json(await a.handle(ev('GET', '/runs'))).runs).toHaveLength(1);
  });

  it('validates input strictly', async () => {
    const a = await api();
    for (const bad of [
      {},
      { ...create, accountId: 'abc' },
      { ...create, extra: 1 },
      { prompt: '' },
    ]) {
      expect((await a.handle(ev('POST', '/runs', bad))).statusCode).toBe(400);
    }
    expect((await a.handle({ ...ev('POST', '/runs'), body: '{nope' })).statusCode).toBe(400);
    expect((await a.handle(ev('GET', '/runs/../x'))).statusCode).toBe(404);
    expect((await a.handle(ev('GET', '/other'))).statusCode).toBe(404);
    expect((await a.handle(ev('GET', '/runs/nope'))).statusCode).toBe(404);
  });

  it('shows the plan at the gate and delivers an approval bound to it', async () => {
    const a = await api();
    const runId = json(await a.handle(ev('POST', '/runs', create))).runId;
    await a.worker({ action: 'advance', runId });
    await a.worker({ action: 'registerApprovalWait', runId, taskToken: 'tok' });
    const detail = json(await a.handle(ev('GET', `/runs/${runId}`)));
    expect(detail.plan.verified).toBe(true);

    const wrong = await a.handle(
      ev('POST', `/runs/${runId}/approve`, { planHash: '0'.repeat(64), environment: 'staging' }),
    );
    expect(wrong.statusCode).toBe(409);
    expect(a.sent).toHaveLength(0);

    const ok = await a.handle(
      ev('POST', `/runs/${runId}/approve`, { planHash: detail.plan.hash, environment: 'staging' }),
    );
    expect(ok.statusCode).toBe(202);
    expect(a.sent[0]).toEqual({
      token: 'tok',
      output: {
        approved: true,
        planHash: detail.plan.hash,
        environment: 'staging',
        actor: 'arn:aws:iam::1:user/me',
      },
    });
    expect(a.execCalls).toHaveLength(0); // the API never deploys; the workflow does
  });

  it('exposes questions and accepts answers', async () => {
    const ask = JSON.stringify({ needsInput: { questions: ['Which payment provider?'] } });
    const a = await api({ provider: new FixtureProvider([ask, JSON.stringify(blueprint)]) });
    const runId = json(await a.handle(ev('POST', '/runs', create))).runId;
    await a.worker({ action: 'advance', runId });
    await a.worker({ action: 'registerInputWait', runId, taskToken: 'tok2' });
    expect(json(await a.handle(ev('GET', `/runs/${runId}`))).questions).toEqual([
      'Which payment provider?',
    ]);
    expect((await a.handle(ev('POST', `/runs/${runId}/respond`, { answers: [] }))).statusCode).toBe(
      400,
    );
    expect(
      (await a.handle(ev('POST', `/runs/${runId}/respond`, { answers: ['Stripe'] }))).statusCode,
    ).toBe(202);
    expect(a.sent[0]!.token).toBe('tok2');
  });

  it('cancels a run and stops its execution', async () => {
    const a = await api();
    const runId = json(await a.handle(ev('POST', '/runs', create))).runId;
    const res = await a.handle(ev('POST', `/runs/${runId}/cancel`));
    expect(json(res).status).toBe('CANCELLED');
    expect(a.stopped).toEqual([runId]);
    expect((await a.handle(ev('DELETE', `/runs/${runId}`))).statusCode).toBe(405);
  });
});
