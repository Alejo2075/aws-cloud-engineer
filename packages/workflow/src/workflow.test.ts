import { describe, expect, it } from 'vitest';
import { CloudEngineerError } from '@cloud-engineer/shared';
import { DomainEventSchema, type DomainEvent } from '@cloud-engineer/contracts';
import {
  InMemoryRunStore,
  WorkflowEngine,
  canTransition,
  planHash,
  type EventPublisher,
} from './index.js';

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

describe('input requests', () => {
  it('pauses and resumes a run at the same stage, and can be cancelled while waiting', async () => {
    const e = engine();
    const run = await e.createRun({ prompt: 'x', region: 'us-east-1' });
    await e.transition(run.runId, 'INTAKE');
    const waiting = await e.requestInput(run.runId, ['Which region?']);
    expect(waiting).toMatchObject({ status: 'NEEDS_INPUT', stage: 'INTAKE' });
    await expect(e.transition(run.runId, 'REQUIREMENTS')).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(e.requestInput(run.runId, ['again'])).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    expect(await e.provideInput(run.runId)).toMatchObject({ status: 'ACTIVE', stage: 'INTAKE' });
    await expect(e.provideInput(run.runId)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });

    await e.requestInput(run.runId, ['q']);
    expect((await e.cancel(run.runId)).status).toBe('CANCELLED');
    const types = (await e.listEvents(run.runId)).map((ev) => ev.type);
    expect(types).toEqual(
      expect.arrayContaining(['InputRequested', 'InputProvided', 'RunCancelled']),
    );
  });
});

describe('domain events', () => {
  const sha = 'a'.repeat(64);
  const ref = (kind: 'blueprint' | 'plan' | 'manifest') => ({
    kind,
    uri: `file:///x/${kind}`,
    sha256: sha,
    createdAt: new Date().toISOString(),
  });

  function withPublisher(fail = false) {
    const events: DomainEvent[] = [];
    const publisher: EventPublisher = {
      publish: async (e) => {
        if (fail) throw new Error('bus down');
        events.push(e);
      },
    };
    return {
      events,
      engine: new WorkflowEngine(new InMemoryRunStore(), () => new Date(), publisher),
    };
  }

  it('publishes schema-valid events for the lifecycle moments consumers care about', async () => {
    const { events, engine } = withPublisher();
    const run = await engine.createRun({ prompt: 'x', region: 'us-east-1' });
    await engine.attachArtifact(run.runId, ref('blueprint'));
    for (const stage of [
      'INTAKE',
      'REQUIREMENTS',
      'DESIGN',
      'PLAN',
      'GENERATE',
      'BUILD',
      'TEST',
    ] as const) {
      await engine.transition(run.runId, stage);
    }
    await engine.attachArtifact(run.runId, ref('plan'));
    expect(events.map((e) => e.type)).toEqual([
      'RunCreated',
      'BlueprintPublished',
      'BuildCompleted',
      'DeploymentApprovalRequested',
    ]);
    for (const e of events) {
      expect(DomainEventSchema.parse(e)).toEqual(e);
      expect(e.runId).toBe(run.runId);
      expect(e.correlationId).toBe(run.correlationId);
    }
    expect(events[1]!.artifacts).toEqual([{ kind: 'blueprint', sha256: sha }]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it('reports a failed gate as TestsFailed, and ignores audit entries that are not public events', async () => {
    const { events, engine } = withPublisher();
    const run = await engine.createRun({ prompt: 'x', region: 'us-east-1' });
    for (const stage of [
      'INTAKE',
      'REQUIREMENTS',
      'DESIGN',
      'PLAN',
      'GENERATE',
      'BUILD',
    ] as const) {
      await engine.transition(run.runId, stage);
    }
    await engine.fail(run.runId, 'npm test failed');
    expect(events.map((e) => e.type)).toEqual(['RunCreated', 'TestsFailed']);
    expect(events[1]!.stage).toBe('BUILD');
  });

  it('never fails or rolls back a transition when the bus is down', async () => {
    const { engine } = withPublisher(true);
    const run = await engine.createRun({ prompt: 'x', region: 'us-east-1' });
    expect((await engine.transition(run.runId, 'INTAKE')).stage).toBe('INTAKE');
    expect((await engine.listEvents(run.runId)).map((e) => e.type)).toEqual([
      'RunCreated',
      'StageChanged',
    ]);
  });
});
