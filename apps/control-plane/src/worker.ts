import { createWorker, type WorkerEvent } from '@cloud-engineer/pipeline';
import { buildDeps, readEnv } from './env.js';

let worker: ReturnType<typeof createWorker> | undefined;

/** Step Functions task handler; implements the contract of infra/src/workflow.ts. */
export const handler = async (event: WorkerEvent): Promise<Record<string, unknown>> => {
  worker ??= createWorker(buildDeps(readEnv()));
  return worker(event);
};
