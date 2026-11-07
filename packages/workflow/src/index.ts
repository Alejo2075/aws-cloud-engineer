import { createHash, randomUUID } from 'node:crypto';
import { CloudEngineerError } from '@cloud-engineer/shared';
import {
  RUN_STAGES,
  type ArtifactRef,
  type Approval,
  type AuditEvent,
  type Run,
  type RunStage,
} from '@cloud-engineer/contracts';

/** Persistence port. Implementations: in-memory/file (local), DynamoDB (cloud). */
export interface RunStore {
  get(runId: string): Promise<Run | undefined>;
  list(): Promise<Run[]>;
  /** Compare-and-set on `updatedAt` so concurrent transitions cannot both win. */
  put(run: Run, expectedUpdatedAt?: string): Promise<void>;
  appendEvent(event: AuditEvent): Promise<void>;
  events(runId: string): Promise<AuditEvent[]>;
}

const next = new Map<RunStage, RunStage>(
  RUN_STAGES.slice(0, -1).map((s, i) => [s, RUN_STAGES[i + 1] as RunStage]),
);

/** Legal non-linear moves: the bounded repair loop and revising the plan. */
const extra: Record<string, RunStage[]> = {
  TEST: ['GENERATE'],
  BUILD: ['GENERATE'],
  AWAITING_APPROVAL: ['PLAN'],
};

export function canTransition(from: RunStage, to: RunStage): boolean {
  return next.get(from) === to || (extra[from]?.includes(to) ?? false);
}

export function planHash(plan: string): string {
  return createHash('sha256').update(plan).digest('hex');
}

export class InMemoryRunStore implements RunStore {
  private runs = new Map<string, Run>();
  private log = new Map<string, AuditEvent[]>();

  async get(runId: string) {
    return this.runs.get(runId);
  }
  async list() {
    return [...this.runs.values()];
  }
  async put(run: Run, expectedUpdatedAt?: string) {
    const current = this.runs.get(run.runId);
    if (expectedUpdatedAt !== undefined && current?.updatedAt !== expectedUpdatedAt) {
      throw new CloudEngineerError('CONFLICT', `Run ${run.runId} was modified concurrently`);
    }
    this.runs.set(run.runId, run);
  }
  async appendEvent(event: AuditEvent) {
    this.log.set(event.runId, [...(this.log.get(event.runId) ?? []), event]);
  }
  async events(runId: string) {
    return this.log.get(runId) ?? [];
  }
}

export interface CreateRunInput {
  prompt: string;
  region: string;
  targetEnvironment?: string;
  tenantId?: string;
  projectId?: string;
}

export class WorkflowEngine {
  constructor(
    private readonly store: RunStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createRun(input: CreateRunInput, actor = 'local'): Promise<Run> {
    if (!input.prompt.trim()) throw new CloudEngineerError('VALIDATION_FAILED', 'Prompt is empty');
    const at = this.now().toISOString();
    const runId = randomUUID();
    const run: Run = {
      runId,
      tenantId: input.tenantId ?? 'local',
      projectId: input.projectId ?? runId,
      correlationId: randomUUID(),
      blueprintVersion: 0,
      targetEnvironment: input.targetEnvironment ?? 'staging',
      region: input.region,
      prompt: input.prompt,
      stage: 'CREATED',
      status: 'ACTIVE',
      artifacts: [],
      approvals: [],
      createdAt: at,
      updatedAt: at,
    };
    await this.store.put(run);
    await this.audit(run, 'RunCreated', actor);
    return run;
  }

  listRuns(): Promise<Run[]> {
    return this.store.list();
  }

  listEvents(runId: string): Promise<AuditEvent[]> {
    return this.store.events(runId);
  }

  async getRun(runId: string): Promise<Run> {
    const run = await this.store.get(runId);
    if (!run) throw new CloudEngineerError('NOT_FOUND', `Run ${runId} not found`);
    return run;
  }

  /** Moves a run to `to`. Deployment is reachable only through `approve`. */
  async transition(runId: string, to: RunStage, actor = 'local'): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== 'ACTIVE') {
      throw new CloudEngineerError('INVALID_TRANSITION', `Run is ${run.status}, not ACTIVE`);
    }
    if (!canTransition(run.stage, to)) {
      throw new CloudEngineerError('INVALID_TRANSITION', `Cannot move ${run.stage} -> ${to}`);
    }
    if (to === 'DEPLOY') {
      throw new CloudEngineerError('INVALID_TRANSITION', 'DEPLOY requires an approval');
    }
    const updated: Run = {
      ...run,
      stage: to,
      status: to === 'SUCCEEDED' ? 'SUCCEEDED' : 'ACTIVE',
      updatedAt: this.now().toISOString(),
    };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'StageChanged', actor, { from: run.stage, to });
    return updated;
  }

  /** Records approval bound to an exact plan hash and environment, then enters DEPLOY. */
  async approve(
    runId: string,
    input: { planHash: string; targetEnvironment: string },
    actor: string,
  ): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== 'ACTIVE' || run.stage !== 'AWAITING_APPROVAL') {
      throw new CloudEngineerError('INVALID_TRANSITION', 'Run is not awaiting approval');
    }
    const plan = run.artifacts.findLast((a) => a.kind === 'plan');
    if (!plan || plan.sha256 !== input.planHash) {
      throw new CloudEngineerError(
        'APPROVAL_MISMATCH',
        'Plan hash does not match the current plan',
      );
    }
    if (input.targetEnvironment !== run.targetEnvironment) {
      throw new CloudEngineerError('APPROVAL_MISMATCH', 'Environment does not match the run');
    }
    const at = this.now().toISOString();
    const approval: Approval = {
      runId,
      stage: 'deployment',
      planHash: input.planHash,
      targetEnvironment: input.targetEnvironment,
      actor,
      approvedAt: at,
    };
    const updated: Run = {
      ...run,
      stage: 'DEPLOY',
      approvals: [...run.approvals, approval],
      updatedAt: at,
    };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'DeploymentApproved', actor, { planHash: input.planHash });
    return updated;
  }

  /** Appends an artifact reference; replays of the same (kind, sha256) are ignored. */
  async attachArtifact(runId: string, ref: ArtifactRef, actor = 'local'): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.artifacts.some((a) => a.kind === ref.kind && a.sha256 === ref.sha256)) return run;
    const updated: Run = {
      ...run,
      artifacts: [...run.artifacts, ref],
      updatedAt: this.now().toISOString(),
    };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'ArtifactAttached', actor, { kind: ref.kind, sha256: ref.sha256 });
    return updated;
  }

  /** Marks the run FAILED (stage preserved for diagnosis). Terminal runs are left alone. */
  async fail(runId: string, reason: string, actor = 'local'): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== 'ACTIVE') return run;
    const updated: Run = { ...run, status: 'FAILED', updatedAt: this.now().toISOString() };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'RunFailed', actor, {
      stage: run.stage,
      reason: reason.slice(0, 500),
    });
    return updated;
  }

  /**
   * FAILED -> ACTIVE at the same stage so the failed stage can be retried. Refused once a deployment
   * was approved (DEPLOY and later), because replaying a deployment could double-create resources.
   */
  async resume(runId: string, actor = 'local'): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== 'FAILED') {
      throw new CloudEngineerError('INVALID_TRANSITION', `Run is ${run.status}, not FAILED`);
    }
    if (['DEPLOY', 'VERIFY', 'HANDOFF', 'SUCCEEDED'].includes(run.stage)) {
      throw new CloudEngineerError(
        'INVALID_TRANSITION',
        `Cannot resume after approval (failed at ${run.stage}); deployments are not replayed`,
      );
    }
    const updated: Run = { ...run, status: 'ACTIVE', updatedAt: this.now().toISOString() };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'RunResumed', actor, { stage: run.stage });
    return updated;
  }

  /** ACTIVE -> NEEDS_INPUT: the run waits for a human decision; the stage is preserved. */
  async requestInput(runId: string, questions: string[], actor = 'local'): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== 'ACTIVE') {
      throw new CloudEngineerError('INVALID_TRANSITION', `Run is ${run.status}, not ACTIVE`);
    }
    const updated: Run = { ...run, status: 'NEEDS_INPUT', updatedAt: this.now().toISOString() };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'InputRequested', actor, { stage: run.stage, questions });
    return updated;
  }

  /** NEEDS_INPUT -> ACTIVE once the decision has been recorded by the caller. */
  async provideInput(runId: string, actor = 'local'): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== 'NEEDS_INPUT') {
      throw new CloudEngineerError('INVALID_TRANSITION', `Run is ${run.status}, not NEEDS_INPUT`);
    }
    const updated: Run = { ...run, status: 'ACTIVE', updatedAt: this.now().toISOString() };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'InputProvided', actor, { stage: run.stage });
    return updated;
  }

  async cancel(runId: string, actor = 'local'): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== 'ACTIVE' && run.status !== 'NEEDS_INPUT') return run;
    const updated: Run = { ...run, status: 'CANCELLED', updatedAt: this.now().toISOString() };
    await this.store.put(updated, run.updatedAt);
    await this.audit(updated, 'RunCancelled', actor);
    return updated;
  }

  private audit(run: Run, type: string, actor: string, detail?: Record<string, unknown>) {
    return this.store.appendEvent({
      runId: run.runId,
      type,
      at: this.now().toISOString(),
      actor,
      ...(detail ? { detail } : {}),
    });
  }
}
export * from './file-store.js';
