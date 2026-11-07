import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { DeployDeps } from '@cloud-engineer/deployment';
import type { PipelineDeps, TokenStore } from '@cloud-engineer/pipeline';
import {
  BedrockProvider,
  DynamoRunStore,
  DynamoTokenStore,
  S3WorkspaceStore,
  createCodeBuildGateRunner,
  createEventPublisher,
  createS3ArtifactStore,
} from '@cloud-engineer/providers';
import { WorkflowEngine } from '@cloud-engineer/workflow';
import { basename, dirname } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';

export interface ControlPlaneEnv {
  region: string;
  table: string;
  bucket: string;
  buildProject: string;
  modelId: string;
  stateMachineArn?: string;
  eventBusName?: string;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new CloudEngineerError('VALIDATION_FAILED', `${name} is not set`);
  return v;
}

export function readEnv(): ControlPlaneEnv {
  return {
    region: need('AWS_REGION'),
    table: need('TABLE_NAME'),
    bucket: need('BUCKET_NAME'),
    buildProject: need('BUILD_PROJECT'),
    modelId: need('MODEL_ID'),
    ...(process.env.STATE_MACHINE_ARN ? { stateMachineArn: process.env.STATE_MACHINE_ARN } : {}),
    ...(process.env.EVENT_BUS_NAME ? { eventBusName: process.env.EVENT_BUS_NAME } : {}),
  };
}

/** Deployment from the control plane is deliberately not available yet (see docs/security-model.md). */
const noDeployer: DeployDeps = {
  callerAccount: async () => {
    throw new CloudEngineerError(
      'BLOCKED',
      'Deploying from the control plane is not implemented: it needs a CodeBuild deployer that assumes a scoped role in the target account',
    );
  },
  exec: async () => {
    throw new CloudEngineerError('BLOCKED', 'Deploying from the control plane is not implemented');
  },
};

export function buildDeps(env: ControlPlaneEnv) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }));
  const gates = createCodeBuildGateRunner({
    region: env.region,
    bucket: env.bucket,
    projectName: env.buildProject,
  });
  const pipeline: PipelineDeps = {
    engine: new WorkflowEngine(
      new DynamoRunStore(doc, env.table),
      undefined,
      env.eventBusName ? createEventPublisher(env.region, env.eventBusName) : undefined,
    ),
    root: '/tmp/cloud-engineer',
    provider: new BedrockProvider({ modelId: env.modelId, region: env.region }),
    artifacts: createS3ArtifactStore({ region: env.region, bucket: env.bucket }),
    // The pipeline passes <root>/runs/<runId>/project.
    gates: (dir) => gates.run(dir, basename(dirname(dir))),
    deployDeps: noDeployer,
  };
  const tokens: TokenStore = new DynamoTokenStore(doc, env.table);
  const workspace = new S3WorkspaceStore(new S3Client({ region: env.region }), env.bucket);
  return { pipeline, tokens, workspace };
}
