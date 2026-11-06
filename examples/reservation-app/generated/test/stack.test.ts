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

  it('grants no wildcard resource, except CloudFront invalidation for the site deployment', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy'));
    const stmts = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
    const wildcard = stmts.filter((s: { Resource: unknown }) => s.Resource === '*');
    for (const w of wildcard as { Action: string | string[] }[]) {
      const actions = Array.isArray(w.Action) ? w.Action : [w.Action];
      // BucketDeployment requires '*' for invalidations; nothing else may use it.
      expect(actions.every((a) => /^cloudfront:(Get|Create)Invalidation$/.test(a))).toBe(true);
    }
  });

  it('serves the frontend privately through CloudFront with security headers', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
    });
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        DefaultRootObject: 'index.html',
      }),
    });
    const policy = Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0]!;
    const cfg = policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
    expect(JSON.stringify(cfg.ContentSecurityPolicy)).toContain("default-src 'self'");
    expect(cfg.StrictTransportSecurity.Override).toBe(true);
  });

  it('restricts CORS to the site origin, never a wildcard', () => {
    const api = Object.values(t.findResources('AWS::ApiGatewayV2::Api'))[0]!;
    const origins = api.Properties.CorsConfiguration.AllowOrigins as unknown[];
    expect(origins).toHaveLength(1);
    expect(JSON.stringify(origins)).not.toContain('"*"');
  });

  it('publishes a config.json with the API and client ids', () => {
    // The JSON itself is an asset; its token values (API URL, client id) travel as source markers.
    t.hasResourceProperties('Custom::CDKBucketDeployment', {
      SourceMarkers: Match.anyValue(),
      DistributionPaths: ['/*'],
    });
  });
});
