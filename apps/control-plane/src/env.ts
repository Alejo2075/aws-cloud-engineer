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
  createCodeBuildDeployer,
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
  deploy?: { project: string; roleName: string; allowedAccounts: string[]; externalId?: string };
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
    ...(process.env.DEPLOY_PROJECT
      ? {
          deploy: {
            project: process.env.DEPLOY_PROJECT,
            roleName: need('DEPLOY_ROLE_NAME'),
            allowedAccounts: need('DEPLOY_ALLOWED_ACCOUNTS').split(','),
            ...(process.env.DEPLOY_EXTERNAL_ID
              ? { externalId: process.env.DEPLOY_EXTERNAL_ID }
              : {}),
          },
        }
      : {}),
    ...(process.env.EVENT_BUS_NAME ? { eventBusName: process.env.EVENT_BUS_NAME } : {}),
  };
}

/** Used unless the stack was synthesized with deploy target accounts (see docs/security-model.md). */
const noDeployer: DeployDeps = {
  callerAccount: async () => {
    throw new CloudEngineerError(
      'BLOCKED',
      'Deployment is disabled: synthesize the control plane with -c deployAccounts=<account ids> to enable the CodeBuild deployer',
    );
  },
  exec: async () => {
    throw new CloudEngineerError('BLOCKED', 'Deployment is disabled in this control plane');
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
    deployDeps: env.deploy
      ? createCodeBuildDeployer(env.region, env.bucket, env.deploy)
      : noDeployer,
  };
  const tokens: TokenStore = new DynamoTokenStore(doc, env.table);
  const workspace = new S3WorkspaceStore(new S3Client({ region: env.region }), env.bucket);
  return { pipeline, tokens, workspace };
}
