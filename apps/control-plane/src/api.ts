import { createApi, type ApiEvent } from '@cloud-engineer/pipeline';
import { createSfnTaskCallbacks, createSfnWorkflowStarter } from '@cloud-engineer/providers';
import { CloudEngineerError } from '@cloud-engineer/shared';
import { buildDeps, readEnv } from './env.js';

let api: ReturnType<typeof createApi> | undefined;

/** HTTP API (payload v2, IAM-authenticated) handler. */
export const handler = async (event: ApiEvent) => {
  if (!api) {
    const env = readEnv();
    if (!env.stateMachineArn) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'STATE_MACHINE_ARN is not set');
    }
    const { pipeline, tokens } = buildDeps(env);
    api = createApi({
      pipeline,
      tokens,
      callbacks: createSfnTaskCallbacks(env.region),
      workflow: createSfnWorkflowStarter(env.region, env.stateMachineArn),
    });
  }
  return api(event);
};
