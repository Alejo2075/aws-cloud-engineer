import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ControlPlaneApiStack } from './api-stack.js';
import { ControlPlaneStack } from './stack.js';

const MODEL_ARN = 'arn:aws:bedrock:us-east-1::foundation-model/example.model-v1:0';

function buildWithDeployer() {
  const app = new cdk.App();
  const data = new ControlPlaneStack(app, 'Data');
  const api = new ControlPlaneApiStack(app, 'Api', {
    data,
    modelId: 'example.model-v1:0',
    bedrockModelArns: [MODEL_ARN],
    deployTargetAccountIds: ['123456789012'],
    deployExternalId: 'ext-1',
  });
  return Template.fromStack(api);
}

function build() {
  const app = new cdk.App();
  const data = new ControlPlaneStack(app, 'Data');
  const api = new ControlPlaneApiStack(app, 'Api', {
    data,
    modelId: 'example.model-v1:0',
    bedrockModelArns: [MODEL_ARN],
  });
  return { app, data, api };
}

type Stmt = { Action: string | string[]; Resource: unknown; Effect: string };
const statements = (t: Template): Stmt[] =>
  Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
    (p) => p.Properties.PolicyDocument.Statement as Stmt[],
  );
const actionsOf = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);

describe('ControlPlaneApiStack', () => {
  const { api } = build();
  const t = Template.fromStack(api);

  it('creates the worker, the API function and a Standard workflow', () => {
    t.resourceCountIs('AWS::Lambda::Function', 2);
    t.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Timeout: 900,
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('authenticates every route with IAM and throttles the stage', () => {
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes.length).toBe(4);
    for (const r of routes) expect(r.Properties.AuthorizationType).toBe('AWS_IAM');
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 },
    });
  });

  it('scopes Bedrock to the listed models and allows no wildcard except SendTaskSuccess', () => {
    const bedrock = statements(t).filter((s) => actionsOf(s).some((a) => a.startsWith('bedrock:')));
    expect(bedrock).toHaveLength(1);
    expect([bedrock[0]!.Resource].flat()).toEqual([MODEL_ARN]);

    const star = statements(t).filter((s) => JSON.stringify(s.Resource) === '"*"');
    for (const s of star) {
      const actions = actionsOf(s);
      // These actions do not support resource-level permissions: X-Ray tracing, Step Functions
      // log delivery, and SendTaskSuccess.
      expect(
        actions.every((a) =>
          /^(states:SendTaskSuccess|xray:(Put(Trace|Telemetry)\w+|GetSampling(Rules|Targets))|logs:(\w*LogDelivery|ListLogDeliveries|PutResourcePolicy|DescribeResourcePolicies|DescribeLogGroups))$/.test(
            a,
          ),
        ),
        actions.join(),
      ).toBe(true);
    }
    expect(
      statements(t).some((s) => actionsOf(s).some((a) => /^(iam|sts|cloudformation):/.test(a))),
    ).toBe(false);
  });

  it('limits object access to runs/, build-input/ and build-output/', () => {
    const s3 = statements(t).filter((s) =>
      actionsOf(s).some((a) => a.startsWith('s3:') && !/^s3:(List|GetBucket)/.test(a)),
    );
    expect(s3.length).toBeGreaterThan(0);
    for (const s of s3) {
      const text = JSON.stringify(s.Resource);
      expect(/\/(runs|build-input|build-output)\//.test(text), text).toBe(true);
    }
  });

  it('lets the worker drive only the gate project and the API stop only this workflow', () => {
    const cb = statements(t).filter((s) => actionsOf(s).some((a) => a.startsWith('codebuild:')));
    expect(cb).toHaveLength(1);
    expect(JSON.stringify(cb[0]!.Resource)).not.toBe('"*"');
    const stop = statements(t).filter((s) => actionsOf(s).includes('states:StopExecution'));
    expect(stop).toHaveLength(1);
    expect(JSON.stringify(stop[0]!.Resource)).toContain(':execution:');
  });

  it('wires the table, bucket, project, model and workflow into the functions by name only', () => {
    // Both functions need the shared variables; only the API function needs the workflow ARN.
    const vars = Object.values(t.findResources('AWS::Lambda::Function')).map(
      (f) => Object.keys(f.Properties.Environment.Variables) as string[],
    );
    expect(vars).toHaveLength(2);
    for (const v of vars) {
      expect(v).toEqual(
        expect.arrayContaining(['TABLE_NAME', 'BUCKET_NAME', 'BUILD_PROJECT', 'MODEL_ID']),
      );
    }
    expect(vars.filter((v) => v.includes('STATE_MACHINE_ARN'))).toHaveLength(1);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ MODEL_ID: 'example.model-v1:0' }) },
    });
    const env = JSON.stringify(
      Object.values(t.findResources('AWS::Lambda::Function')).map((f) => f.Properties.Environment),
    );
    expect(env).not.toMatch(/AKIA|SECRET|PASSWORD|TOKEN/i);
  });

  it('lets both functions publish only to the Cloud Engineer bus', () => {
    const puts = statements(t).filter((s) => actionsOf(s).includes('events:PutEvents'));
    expect(puts).toHaveLength(2);
    for (const s of puts) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
  });

  it('refuses to be built without an explicit model allow-list', () => {
    const app = new cdk.App();
    const data = new ControlPlaneStack(app, 'Data');
    expect(
      () => new ControlPlaneApiStack(app, 'Api', { data, modelId: 'm', bedrockModelArns: [] }),
    ).toThrow(/bedrockModelArns/);
  });

  it('has no deployer unless target accounts are given', () => {
    t.resourceCountIs('AWS::CodeBuild::Project', 0);
    const vars = JSON.stringify(
      Object.values(t.findResources('AWS::Lambda::Function')).map((f) => f.Properties.Environment),
    );
    expect(vars).not.toContain('DEPLOY_PROJECT');
  });
});

describe('ControlPlaneApiStack deployer', () => {
  const t = buildWithDeployer();

  it('runs the pinned CDK CLI after assuming the role and checking the account', () => {
    const project = Object.values(t.findResources('AWS::CodeBuild::Project'))[0]!;
    const spec = String(project.Properties.Source.BuildSpec);
    expect(spec).toMatch(/aws-cdk@\d+\.\d+\.\d+ deploy/);
    expect(spec.indexOf('sts assume-role')).toBeLessThan(spec.indexOf('get-caller-identity'));
    expect(spec.indexOf('get-caller-identity')).toBeLessThan(spec.indexOf('aws-cdk@'));
    expect(spec).toContain('EXPECTED_ACCOUNT');
    expect(spec).not.toMatch(/AKIA/);
  });

  it('can assume only the named role in the listed accounts', () => {
    const assume = statements(t).filter((s) => actionsOf(s).includes('sts:AssumeRole'));
    expect(assume).toHaveLength(1);
    expect([assume[0]!.Resource].flat()).toEqual([
      'arn:aws:iam::123456789012:role/CloudEngineerDeploy',
    ]);
    // No CloudFormation/IAM permissions of its own: everything runs through the assumed role.
    expect(
      statements(t).some((s) => actionsOf(s).some((a) => /^(cloudformation|iam):/.test(a))),
    ).toBe(false);
  });

  it('tells the worker how to reach the deployer and lets it start only the two projects', () => {
    const vars = Object.values(t.findResources('AWS::Lambda::Function')).flatMap((f) =>
      Object.keys(f.Properties.Environment.Variables),
    );
    expect(vars).toEqual(
      expect.arrayContaining(['DEPLOY_PROJECT', 'DEPLOY_ROLE_NAME', 'DEPLOY_ALLOWED_ACCOUNTS']),
    );
    const starts = statements(t).filter((s) => actionsOf(s).includes('codebuild:StartBuild'));
    expect(starts).toHaveLength(2);
    for (const s of starts) expect(JSON.stringify(s.Resource)).not.toBe('"*"');
  });
});
