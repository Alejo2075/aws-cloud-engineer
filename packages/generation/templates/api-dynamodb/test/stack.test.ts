import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { AppStack } from '../lib/stack.js';

const synth = (stage: string) =>
  Template.fromStack(
    new AppStack(new cdk.App(), 'test', { stage, code: lambda.Code.fromInline('exports.handler=1') }),
  );

describe('AppStack', () => {
  const t = synth('staging');

  it('creates an encrypted, point-in-time-recoverable on-demand table', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: Match.objectLike({ SSEEnabled: true }),
    });
  });

  it('protects every route with the JWT authorizer', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(r.Properties.AuthorizationType).toBe('JWT');
  });

  it('retains data in production and tags resources', () => {
    synth('production').hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
    expect(JSON.stringify(t.toJSON())).toContain('cloud-engineer');
  });

  it('grants no wildcard resource', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy'));
    const stmts = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    expect(stmts.filter((s: { Resource: unknown }) => s.Resource === '*')).toEqual([]);
  });

  it('is API only: no website, CDN or public bucket, and no CORS', () => {
    t.resourceCountIs('AWS::CloudFront::Distribution', 0);
    t.resourceCountIs('AWS::S3::Bucket', 0);
    const api = Object.values(t.findResources('AWS::ApiGatewayV2::Api'))[0]!;
    expect(api.Properties.CorsConfiguration).toBeUndefined();
  });
});
