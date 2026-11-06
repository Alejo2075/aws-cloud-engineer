import { describe, expect, it } from 'vitest';
import { CloudEngineerError } from '@cloud-engineer/shared';
import { InMemoryRunStore, WorkflowEngine, canTransition, planHash } from './index.js';

const engine = () => new WorkflowEngine(new InMemoryRunStore());

describe('transitions', () => {
  it('allows the linear path and the repair loop only', () => {
    expect(canTransition('BUILD', 'TEST')).toBe(true);
    expect(canTransition('TEST', 'GENERATE')).toBe(true);
    expect(canTransition('GENERATE', 'DEPLOY')).toBe(false);
    expect(canTransition('SUCCEEDED', 'CREATED')).toBe(false);
  });

  it('rejects skipping stages and persists nothing', async () => {
    const e = engine();
    const run = await e.createRun({ prompt: 'x', region: 'us-east-1' });
    await expect(e.transition(run.runId, 'BUILD')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect((await e.getRun(run.runId)).stage).toBe('CREATED');
  });

  it('rejects an empty prompt', async () => {
    await expect(engine().createRun({ prompt: ' ', region: 'us-east-1' })).rejects.toBeInstanceOf(
      CloudEngineerError,
    );
  });
});

describe('approval', () => {
  async function awaiting() {
    const store = new InMemoryRunStore();
    const e = new WorkflowEngine(store);
    const run = await e.createRun({ prompt: 'x', region: 'us-east-1' });
    for (const s of [
      'INTAKE',
      'REQUIREMENTS',
      'DESIGN',
      'PLAN',
      'GENERATE',
      'BUILD',
      'TEST',
      'SECURITY_REVIEW',
      'DEPLOYMENT_REVIEW',
      'AWAITING_APPROVAL',
    ] as const) {
      await e.transition(run.runId, s);
    }
    const hash = planHash('plan-v1');
    const cur = await store.get(run.runId);
    await store.put({
      ...cur!,
      artifacts: [
        {
          kind: 'plan',
          uri: 'file://plan.json',
          sha256: hash,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    return { e, runId: run.runId, hash };
  }

  it('deploys only with the exact plan hash and environment', async () => {
    const { e, runId, hash } = await awaiting();
    await expect(
      e.approve(runId, { planHash: planHash('other'), targetEnvironment: 'staging' }, 'me'),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    await expect(
      e.approve(runId, { planHash: hash, targetEnvironment: 'production' }, 'me'),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });
    const run = await e.approve(runId, { planHash: hash, targetEnvironment: 'staging' }, 'me');
    expect(run.stage).toBe('DEPLOY');
    expect(run.approvals).toHaveLength(1);
  });

  it('cannot reach DEPLOY via transition()', async () => {
    const { e, runId } = await awaiting();
    await expect(e.transition(runId, 'DEPLOY')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('does not approve twice (replay-safe)', async () => {
    const { e, runId, hash } = await awaiting();
    await e.approve(runId, { planHash: hash, targetEnvironment: 'staging' }, 'me');
    await expect(
      e.approve(runId, { planHash: hash, targetEnvironment: 'staging' }, 'me'),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});
