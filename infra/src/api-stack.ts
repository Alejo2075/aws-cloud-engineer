import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { ControlPlaneStack } from './stack.js';
import { RunWorkflow } from './workflow.js';

export interface ControlPlaneApiProps extends cdk.StackProps {
  data: ControlPlaneStack;
  /** Bedrock model or inference-profile id the planner calls. */
  modelId: string;
  /** Exact ARNs the worker may invoke (foundation model and/or inference profile). */
  bedrockModelArns: string[];
  /**
   * Accounts the control plane may deploy to. Omit to leave deployment disabled (the worker's
   * deployer then refuses). Each account must contain `deployRoleName`, trusting the deployer's role.
   */
  deployTargetAccountIds?: string[];
  deployRoleName?: string;
  /** Optional external id the target role requires on AssumeRole. */
  deployExternalId?: string;
}

/** The CDK CLI the deployer build runs is the exact version the local deployer pins. */
const CDK_CLI_VERSION = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../packages/deployment/package.json', import.meta.url)),
      'utf8',
    ),
  ) as { dependencies: Record<string, string> }
).dependencies['aws-cdk']!;

const entry = (name: string) =>
  fileURLToPath(new URL(`../../apps/control-plane/src/${name}.ts`, import.meta.url));

/**
 * Workflow + worker + IAM-authenticated HTTP API on top of the data plane. The worker can plan,
 * generate and run gates in CodeBuild, but it CANNOT deploy yet: the deployer is a stub that
 * refuses (a CodeBuild deployer assuming a scoped target-account role is not built). Never deployed
 * or run against AWS; verified by synth and assertions only.
 */
export class ControlPlaneApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ControlPlaneApiProps) {
    super(scope, id, props);
    if (props.bedrockModelArns.length === 0) {
      throw new Error('bedrockModelArns must list the exact models the worker may invoke');
    }
    const { table, bucket, gateProject, bus } = props.data;

    const bundling: nodejs.BundlingOptions = {
      format: nodejs.OutputFormat.ESM,
      target: 'node22',
      mainFields: ['module', 'main'],
      // The AWS SDK v3 ships with the Node 22 runtime.
      externalModules: ['@aws-sdk/*'],
      banner:
        "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      sourceMap: true,
    };
    const fn = (name: string, entryName: string, extra: Partial<nodejs.NodejsFunctionProps>) =>
      new nodejs.NodejsFunction(this, name, {
        entry: entry(entryName),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        tracing: lambda.Tracing.ACTIVE,
        bundling,
        projectRoot: fileURLToPath(new URL('../../', import.meta.url)),
        depsLockFilePath: fileURLToPath(new URL('../../pnpm-lock.yaml', import.meta.url)),
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        ...extra,
        // Merged last so a per-function override cannot drop the shared variables.
        environment: {
          TABLE_NAME: table.tableName,
          BUCKET_NAME: bucket.bucketName,
          BUILD_PROJECT: gateProject.projectName,
          MODEL_ID: props.modelId,
          EVENT_BUS_NAME: bus.eventBusName,
          NODE_OPTIONS: '--enable-source-maps',
          ...extra.environment,
        },
      });

    const worker = fn('Worker', 'worker', {
      timeout: cdk.Duration.minutes(15),
      memorySize: 2048,
      ephemeralStorageSize: cdk.Size.gibibytes(2),
    });
    table.grantReadWriteData(worker);
    bucket.grantReadWrite(worker, 'runs/*');
    bucket.grantPut(worker, 'build-input/*');
    bucket.grantRead(worker, 'build-output/*');
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild'],
        resources: [gateProject.projectArn],
      }),
    );
    worker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: props.bedrockModelArns,
      }),
    );

    bus.grantPutEventsTo(worker);

    const deployRoleName = props.deployRoleName ?? 'CloudEngineerDeploy';
    const targets = props.deployTargetAccountIds ?? [];
    // One project and one role per target account: a build can assume only its own account's role,
    // so a compromised or confused build cannot reach another listed account.
    const deployers: Record<string, codebuild.Project> = {};
    for (const account of targets) {
      const deployerRole = new iam.Role(this, `DeployerRole${account}`, {
        assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      });
      const project = new codebuild.Project(this, `Deployer${account}`, {
        role: deployerRole,
        timeout: cdk.Duration.minutes(45),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2023_5,
          computeType: codebuild.ComputeType.MEDIUM,
        },
        source: codebuild.Source.s3({ bucket, path: 'build-input/' }),
        encryptionKey: props.data.key,
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          phases: {
            install: {
              commands: [
                // The CDK CLI is installed outside the uploaded assembly, without lifecycle scripts,
                // so nothing in the assembly (.npmrc, node_modules, scripts) can influence it.
                'mkdir -p /tmp/cdk && cd /tmp/cdk && npm init -y >/dev/null',
                `cd /tmp/cdk && npm install --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org aws-cdk@${CDK_CLI_VERSION}`,
              ],
            },
            build: {
              commands: [
                // Credentials for the target account exist only inside this build, via AssumeRole.
                'read -r AK SK ST <<< "$(aws sts assume-role --role-arn "$TARGET_ROLE_ARN" --role-session-name "ce-$RUN_ID" --duration-seconds 3600 ${EXTERNAL_ID:+--external-id "$EXTERNAL_ID"} --query "Credentials.[AccessKeyId,SecretAccessKey,SessionToken]" --output text)"',
                'export AWS_ACCESS_KEY_ID="$AK" AWS_SECRET_ACCESS_KEY="$SK" AWS_SESSION_TOKEN="$ST"',
                'unset AK SK ST',
                // From here on the CLI must use only the assumed-role credentials, never the build role.
                'unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_CONTAINER_AUTHORIZATION_TOKEN',
                // Refuse to deploy unless the credentials really belong to the approved account.
                '[ "$(aws sts get-caller-identity --query Account --output text)" = "$EXPECTED_ACCOUNT" ]',
                '/tmp/cdk/node_modules/.bin/cdk deploy "$STACK_NAME" --app "$CODEBUILD_SRC_DIR" --require-approval never --outputs-file "$CODEBUILD_SRC_DIR/cdk-outputs.json"',
              ],
            },
          },
          artifacts: { files: ['cdk-outputs.json'] },
        }),
      });
      bucket.grantRead(project, 'build-input/*');
      bucket.grantWrite(project, 'build-output/*');
      deployerRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${account}:role/${deployRoleName}`],
        }),
      );
      worker.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds', 'codebuild:StopBuild'],
          resources: [project.projectArn],
        }),
      );
      deployers[account] = project;
    }
    if (targets.length > 0) {
      worker.addEnvironment(
        'DEPLOY_PROJECTS',
        cdk.Stack.of(this).toJsonString(
          Object.fromEntries(Object.entries(deployers).map(([a, p]) => [a, p.projectName])),
        ),
      );
      worker.addEnvironment('DEPLOY_ROLE_NAME', deployRoleName);
      if (props.deployExternalId)
        worker.addEnvironment('DEPLOY_EXTERNAL_ID', props.deployExternalId);
    }

    const workflow = new RunWorkflow(this, 'Workflow', { worker });

    const api = fn('Api', 'api', {
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: { STATE_MACHINE_ARN: workflow.stateMachine.stateMachineArn },
    });
    table.grantReadWriteData(api);
    bus.grantPutEventsTo(api);
    bucket.grantReadWrite(api, 'runs/*');
    workflow.stateMachine.grantStartExecution(api);
    api.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StopExecution'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'states',
            resource: 'execution',
            resourceName: `${workflow.stateMachine.stateMachineName}:*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    // SendTaskSuccess does not support resource-level permissions: '*' is the only valid resource.
    api.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['states:SendTaskSuccess'], resources: ['*'] }),
    );

    const http = new apigwv2.HttpApi(this, 'HttpApi', {
      defaultAuthorizer: new HttpIamAuthorizer(),
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', api);
    http.addRoutes({
      path: '/runs',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration,
    });
    http.addRoutes({ path: '/runs/{id}', methods: [apigwv2.HttpMethod.GET], integration });
    http.addRoutes({
      path: '/runs/{id}/{action}',
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });
    (http.defaultStage?.node.defaultChild as apigwv2.CfnStage).defaultRouteSettings = {
      throttlingBurstLimit: 20,
      throttlingRateLimit: 10,
    };

    cdk.Tags.of(this).add('ManagedBy', 'cloud-engineer');
    new cdk.CfnOutput(this, 'ApiUrl', { value: http.apiEndpoint });
    new cdk.CfnOutput(this, 'StateMachineArn', { value: workflow.stateMachine.stateMachineArn });
  }
}
