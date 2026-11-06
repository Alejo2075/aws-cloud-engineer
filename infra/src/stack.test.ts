import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ControlPlaneStack } from './stack.js';

const t = Template.fromStack(new ControlPlaneStack(new cdk.App(), 'T'));

describe('ControlPlaneStack', () => {
  it('provides the table layout DynamoRunStore expects', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'byCreatedAt' })],
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('keeps artifacts private, encrypted, versioned and TLS-only', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: Match.objectLike({
        BlockPublicAcls: true,
        RestrictPublicBuckets: true,
      }),
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
        ]),
      },
    });
  });

  it('retains data and rotates the key', () => {
    t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    t.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('gives the build executor no wildcard action and no deploy-style permissions', () => {
    const stmts = Object.values(t.findResources('AWS::IAM::Policy')).flatMap(
      (p) => p.Properties.PolicyDocument.Statement as { Action: string | string[] }[],
    );
    const actions = stmts.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions).not.toContain('*');
    expect(actions.some((a) => /^(cloudformation|iam|sts):/.test(a))).toBe(false);
  });
});
