import { z } from 'zod';
import { CloudEngineerError, type ErrorCode } from '@cloud-engineer/shared';
import { planHashOf, renderPlan } from '@cloud-engineer/deployment';
import { initRun, loadPlan, pendingQuestions, type PipelineDeps } from './pipeline.js';
import { submitAnswers, submitApproval, type TaskCallbacks, type TokenStore } from './worker.js';

/** Starts (idempotently, keyed by run id) and stops the durable execution of a run. */
export interface WorkflowStarter {
  start(runId: string): Promise<void>;
  stop(runId: string, cause: string): Promise<void>;
}

export interface ApiDeps {
  pipeline: PipelineDeps;
  tokens: TokenStore;
  callbacks: TaskCallbacks;
  workflow: WorkflowStarter;
}

/** The subset of an API Gateway HTTP API (payload v2) event this API reads. */
export interface ApiEvent {
  rawPath: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    http: { method: string };
    authorizer?: { iam?: { userArn?: string } };
  };
}
export interface ApiResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const MAX_BODY_BYTES = 256 * 1024;
const ID = /^[A-Za-z0-9-]{1,64}$/;

const CreateBody = z.strictObject({
  prompt: z.string().min(1).max(20_000),
  region: z.string().min(1).max(32).default('us-east-1'),
  environment: z.string().min(1).max(32).default('staging'),
  accountId: z.string().regex(/^\d{12}$/),
  blueprint: z.unknown().optional(),
});
const ApproveBody = z.strictObject({
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  environment: z.string().min(1).max(32),
  approved: z.boolean().default(true),
});
const RespondBody = z.strictObject({ answers: z.array(z.string().max(1000)).min(1).max(3) });

const STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  APPROVAL_MISMATCH: 409,
  INVALID_TRANSITION: 409,
  CONFLICT: 409,
  BLOCKED: 422,
};

const reply = (statusCode: number, payload: unknown): ApiResult => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

function parseBody<T>(event: ApiEvent, schema: z.ZodType<T>): T {
  const raw = event.body ?? '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    throw new CloudEngineerError('VALIDATION_FAILED', 'Body too large');
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CloudEngineerError('VALIDATION_FAILED', 'Body is not valid JSON');
  }
  const res = schema.safeParse(json);
  if (!res.success) {
    throw new CloudEngineerError(
      'VALIDATION_FAILED',
      res.error.issues.map((i) => i.message).join('; '),
    );
  }
  return res.data;
}

/**
 * Control-plane HTTP API (IAM-authenticated; the caller's ARN is recorded as the actor). Approvals
 * are bound to the plan hash and environment and are verified again by the worker before deploying.
 */
export function createApi(a: ApiDeps) {
  const d = a.pipeline;
  return async (event: ApiEvent): Promise<ApiResult> => {
    const actor = event.requestContext.authorizer?.iam?.userArn;
    if (!actor) return reply(401, { message: 'unauthenticated' });
    const method = event.requestContext.http.method;
    const [root, id, action, ...rest] = event.rawPath.split('/').filter(Boolean);
    try {
      if (root !== 'runs' || rest.length > 0 || (id !== undefined && !ID.test(id))) {
        return reply(404, { message: 'not found' });
      }
      if (id === undefined && method === 'POST') {
        const body = parseBody(event, CreateBody);
        const run = await initRun(d, {
          prompt: body.prompt,
          region: body.region,
          environment: body.environment,
          accountId: body.accountId,
          blueprint: body.blueprint,
        });
        await a.workflow.start(run.runId);
        return reply(202, { runId: run.runId, status: run.status, stage: run.stage });
      }
      if (id === undefined && method === 'GET') {
        const runs = await d.engine.listRuns();
        return reply(200, {
          runs: runs.map((r) => ({ runId: r.runId, stage: r.stage, status: r.status })),
        });
      }
      if (id !== undefined && action === undefined && method === 'GET') {
        const run = await d.engine.getRun(id);
        const planRef = run.artifacts.findLast((x) => x.kind === 'plan');
        const detail: Record<string, unknown> = {
          runId: run.runId,
          stage: run.stage,
          status: run.status,
          environment: run.targetEnvironment,
          artifacts: run.artifacts.map((x) => x.kind),
        };
        if (run.status === 'NEEDS_INPUT') detail.questions = await pendingQuestions(d, id);
        if (planRef && run.stage === 'AWAITING_APPROVAL') {
          const { plan, hash } = await loadPlan(d, id);
          detail.plan = {
            hash,
            summary: renderPlan(plan, hash),
            verified: planHashOf(plan) === hash,
          };
        }
        return reply(200, detail);
      }
      if (id !== undefined && method === 'POST' && action === 'approve') {
        const body = parseBody(event, ApproveBody);
        await submitApproval(a, a.callbacks, id, { ...body, actor });
        return reply(202, { runId: id, approved: body.approved });
      }
      if (id !== undefined && method === 'POST' && action === 'respond') {
        const body = parseBody(event, RespondBody);
        await submitAnswers(a, a.callbacks, id, body.answers, actor);
        return reply(202, { runId: id });
      }
      if (id !== undefined && method === 'POST' && action === 'cancel') {
        const run = await d.engine.cancel(id, actor);
        if (run.status === 'CANCELLED') await a.workflow.stop(id, `cancelled by ${actor}`);
        return reply(200, { runId: id, status: run.status });
      }
      return reply(405, { message: 'method not allowed' });
    } catch (err) {
      if (err instanceof CloudEngineerError) {
        return reply(STATUS[err.code] ?? 500, { code: err.code, message: err.message });
      }
      console.error(JSON.stringify({ level: 'error', message: 'unhandled', error: String(err) }));
      return reply(500, { message: 'internal error' });
    }
  };
}
