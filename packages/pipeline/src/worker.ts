import { CloudEngineerError } from '@cloud-engineer/shared';
import {
  approveAndDeploy,
  pendingQuestions,
  projectDir,
  recordAnswers,
  resumeRun,
  loadPlan,
  type PipelineDeps,
} from './pipeline.js';

export type WaitKind = 'input' | 'approval';

/** Where Step Functions task tokens are parked until a human responds. Tokens are bearer secrets. */
export interface TokenStore {
  save(runId: string, kind: WaitKind, token: string): Promise<void>;
  /** Returns and removes the token, so a decision can be delivered at most once. */
  take(runId: string, kind: WaitKind): Promise<string | undefined>;
}

/** Completes a waiting task (SendTaskSuccess). */
export interface TaskCallbacks {
  success(token: string, output: Record<string, unknown>): Promise<void>;
}

/**
 * Lambda invocations do not share a disk, so the generated project and cdk.out must travel between
 * them. Implementations persist `dir` after a stage and restore it before the next one.
 * No production implementation exists yet (see backlog).
 */
export interface WorkspaceStore {
  restore(runId: string, dir: string): Promise<void>;
  persist(runId: string, dir: string): Promise<void>;
}

export type WorkerStatus = 'AWAITING_APPROVAL' | 'NEEDS_INPUT' | 'SUCCEEDED' | 'FAILED';

export type WorkerEvent =
  | { action: 'advance'; runId: string }
  | { action: 'registerInputWait' | 'registerApprovalWait'; runId: string; taskToken: string }
  | {
      action: 'deploy';
      runId: string;
      decision: { approved: true; planHash: string; environment: string; actor: string };
    }
  | { action: 'verify'; runId: string }
  | { action: 'markFailed'; runId: string; error?: unknown };

export interface WorkerDeps {
  pipeline: PipelineDeps;
  tokens: TokenStore;
  workspace?: WorkspaceStore;
}

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Implements the contract of infra/src/workflow.ts. Every action is safe to repeat: `advance` only
 * continues what is persisted, a wait registration overwrites its token, and `deploy` is refused by
 * the engine once an approval exists, so a redelivered event cannot deploy twice.
 */
export function createWorker(w: WorkerDeps) {
  const d = w.pipeline;
  return async (event: WorkerEvent): Promise<Record<string, unknown>> => {
    if (!RUN_ID.test(event.runId)) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid run id');
    }
    const { runId } = event;
    const dir = projectDir(d.root, runId);
    switch (event.action) {
      case 'advance': {
        await w.workspace?.restore(runId, dir);
        let run = await d.engine.getRun(runId);
        if (run.status === 'ACTIVE' && run.stage !== 'AWAITING_APPROVAL') {
          run = await resumeRun(d, runId);
          await w.workspace?.persist(runId, dir);
        }
        if (run.status === 'NEEDS_INPUT') {
          return { status: 'NEEDS_INPUT', questions: await pendingQuestions(d, runId) };
        }
        if (run.status === 'SUCCEEDED') return { status: 'SUCCEEDED' };
        if (run.status === 'ACTIVE' && run.stage === 'AWAITING_APPROVAL') {
          const { hash } = await loadPlan(d, runId);
          return {
            status: 'AWAITING_APPROVAL',
            planHash: hash,
            environment: run.targetEnvironment,
          };
        }
        return { status: 'FAILED' };
      }
      case 'registerInputWait':
      case 'registerApprovalWait': {
        if (!event.taskToken)
          throw new CloudEngineerError('VALIDATION_FAILED', 'Missing task token');
        await w.tokens.save(
          runId,
          event.action === 'registerInputWait' ? 'input' : 'approval',
          event.taskToken,
        );
        return {};
      }
      case 'deploy': {
        const { planHash, environment, actor } = event.decision;
        await w.workspace?.restore(runId, dir);
        const res = await approveAndDeploy(d, runId, { planHash, environment, actor });
        if (!res.deployed) throw new CloudEngineerError('CONFLICT', 'Deployment failed');
        return { deployed: true, verified: res.verified };
      }
      case 'verify': {
        const run = await d.engine.getRun(runId);
        if (run.status !== 'SUCCEEDED') {
          throw new CloudEngineerError(
            'CONFLICT',
            `Run is ${run.status} at ${run.stage}: not verified`,
          );
        }
        return { verified: true };
      }
      case 'markFailed': {
        const reason =
          event.error && typeof event.error === 'object' && 'Cause' in event.error
            ? String((event.error as { Cause: unknown }).Cause)
            : 'workflow error';
        await d.engine.fail(runId, reason);
        return {};
      }
    }
  };
}

/** API side: delivers an approval (or rejection) bound to an exact plan hash and environment. */
export async function submitApproval(
  w: Pick<WorkerDeps, 'pipeline' | 'tokens'>,
  callbacks: TaskCallbacks,
  runId: string,
  decision: { approved: boolean; planHash: string; environment: string; actor: string },
): Promise<void> {
  const run = await w.pipeline.engine.getRun(runId);
  if (run.status !== 'ACTIVE' || run.stage !== 'AWAITING_APPROVAL') {
    throw new CloudEngineerError('INVALID_TRANSITION', `Run is ${run.status} at ${run.stage}`);
  }
  if (decision.approved) {
    // Fail before consuming the token: a wrong hash must leave the run waiting.
    const { hash } = await loadPlan(w.pipeline, runId);
    if (hash !== decision.planHash || run.targetEnvironment !== decision.environment) {
      throw new CloudEngineerError('APPROVAL_MISMATCH', 'Approval does not match the current plan');
    }
  }
  const token = await w.tokens.take(runId, 'approval');
  if (!token) throw new CloudEngineerError('NOT_FOUND', 'The run is not waiting for approval');
  try {
    await callbacks.success(token, { ...decision });
  } catch (err) {
    await w.tokens.save(runId, 'approval', token); // a failed delivery must not strand the run
    throw err;
  }
}

/** API side: records answers to a NEEDS_INPUT run and releases its waiting task. */
export async function submitAnswers(
  w: Pick<WorkerDeps, 'pipeline' | 'tokens'>,
  callbacks: TaskCallbacks,
  runId: string,
  answers: string[],
  actor: string,
): Promise<void> {
  const token = await w.tokens.take(runId, 'input');
  if (!token) throw new CloudEngineerError('NOT_FOUND', 'The run is not waiting for input');
  try {
    await recordAnswers(w.pipeline, runId, answers, actor);
  } catch (err) {
    await w.tokens.save(runId, 'input', token); // invalid answers must not strand the run
    throw err;
  }
  try {
    await callbacks.success(token, { actor });
  } catch (err) {
    await w.tokens.save(runId, 'input', token);
    throw err;
  }
}
