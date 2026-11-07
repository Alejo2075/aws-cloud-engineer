import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
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
}

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
