import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeployDeps } from '@cloud-engineer/deployment';
import { FixtureProvider } from '@cloud-engineer/planning';
import { FileRunStore, WorkflowEngine } from '@cloud-engineer/workflow';
import type { PipelineDeps } from './pipeline.js';

export const blueprint = {
  schemaVersion: '1.0.0',
  kind: 'ApplicationBlueprint',
  name: 'booking-app',
  requirements: [{ id: 'R1', type: 'functional', text: 'Create bookings' }],
  entities: [{ name: 'Booking', fields: [{ name: 'guestName', type: 'string', required: true }] }],
  components: [{ id: 'C1', type: 'api', awsService: 'API Gateway', justification: 'HTTP API' }],
  tasks: [{ id: 'T1', title: 'API', satisfies: ['R1'], acceptance: ['works'] }],
  risks: [],
};
export const template = {
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
export const ACCOUNT = '123456789012';

export const roots: string[] = [];

export async function setup(
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
export const opts = {
  prompt: 'booking app',
  region: 'us-east-1',
  environment: 'staging',
  accountId: ACCOUNT,
};
