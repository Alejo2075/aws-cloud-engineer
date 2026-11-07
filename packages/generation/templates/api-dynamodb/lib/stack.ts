import * as cdk from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import { ENTITIES, routeFor } from '../src/lambda/entities.js';

export interface AppStackProps extends cdk.StackProps {
  stage: string;
  /** Defaults to the esbuild output in dist/lambda. */
  code?: lambda.Code;
}

export class AppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const isStaging = props.stage !== 'production';

    const table = new dynamodb.Table(this, 'Table', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: isStaging ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: { minLength: 12, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: isStaging ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });
    const client = userPool.addClient('Client', {
      authFlows: { userPassword: true, userSrp: true },
      generateSecret: false,
    });

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: isStaging ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
    });
    const fn = new lambda.Function(this, 'Api', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: props.code ?? lambda.Code.fromAsset('dist/lambda'),
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName },
      logGroup,
    });
    table.grantReadWriteData(fn);

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      defaultAuthorizer: new HttpJwtAuthorizer('Jwt', userPool.userPoolProviderUrl, {
        jwtAudience: [client.userPoolClientId],
      }),
    });
    const integration = new HttpLambdaIntegration('LambdaIntegration', fn);
    for (const e of ENTITIES) {
      api.addRoutes({
        path: `/${routeFor(e)}`,
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
        integration,
      });
      api.addRoutes({
        path: `/${routeFor(e)}/{id}`,
        methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE],
        integration,
      });
    }
    // Cost and abuse guard: cap request rate on the default stage.
    (api.defaultStage?.node.defaultChild as apigwv2.CfnStage).defaultRouteSettings = {
      throttlingBurstLimit: 50,
      throttlingRateLimit: 25,
    };

    cdk.Tags.of(this).add('Project', this.stackName);
    cdk.Tags.of(this).add('Environment', props.stage);
    cdk.Tags.of(this).add('ManagedBy', 'cloud-engineer');

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
