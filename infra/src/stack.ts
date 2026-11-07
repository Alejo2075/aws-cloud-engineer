import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * Data plane and build isolation for Cloud Engineer itself. Matches the layout expected by
 * DynamoRunStore (pk/sk + GSI `byCreatedAt`) and S3ArtifactStore (runs/<id>/artifacts/*).
 * The Step Functions workflow and Lambda workers are not part of this stack yet.
 */
export class ControlPlaneStack extends cdk.Stack {
  readonly key: kms.Key;
  readonly table: dynamodb.Table;
  readonly bucket: s3.Bucket;
  readonly gateProject: codebuild.Project;
  readonly bus: events.EventBus;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const key = new kms.Key(this, 'ArtifactKey', { enableKeyRotation: true });

    const table = new dynamodb.Table(this, 'Runs', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: key,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'byCreatedAt',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const bucket = new s3.Bucket(this, 'Artifacts', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ noncurrentVersionExpiration: cdk.Duration.days(90) }],
    });

    const bus = new events.EventBus(this, 'Events', {
      description: 'Cloud Engineer domain events',
    });

    // Build executor: its own role, no AWS permissions beyond logs and its artifact prefix.
    const buildRole = new iam.Role(this, 'BuildExecutorRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    const project = new codebuild.Project(this, 'GateRunner', {
      role: buildRole,
      timeout: cdk.Duration.minutes(30),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2023_5,
        computeType: codebuild.ComputeType.SMALL,
      },
      source: codebuild.Source.s3({ bucket, path: 'build-input/' }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: ['npm install', 'npm run typecheck', 'npm run test', 'npm run synth'],
          },
        },
        // The per-run artifact location is supplied by CodeBuildGateRunner when it starts a build.
        artifacts: { files: ['cdk.out/**/*'] },
      }),
      encryptionKey: key,
    });
    // Least privilege: the build role reads only build-input/* and writes only build-output/*,
    // never runs/* (other runs' artifacts). CodeBuildGateRunner puts one run's source in build-input/.
    bucket.grantRead(project, 'build-input/*');
    bucket.grantWrite(project, 'build-output/*');

    this.key = key;
    this.table = table;
    this.bucket = bucket;
    this.gateProject = project;
    this.bus = bus;

    cdk.Tags.of(this).add('ManagedBy', 'cloud-engineer');
    new cdk.CfnOutput(this, 'RunsTableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'ArtifactBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'EventBusName', { value: bus.eventBusName });
    new cdk.CfnOutput(this, 'GateProjectName', { value: project.projectName });
  }
}
