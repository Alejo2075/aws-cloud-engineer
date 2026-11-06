import { z } from 'zod';

export const RUN_STAGES = [
  'CREATED',
  'INTAKE',
  'REQUIREMENTS',
  'DESIGN',
  'PLAN',
  'GENERATE',
  'BUILD',
  'TEST',
  'SECURITY_REVIEW',
  'DEPLOYMENT_REVIEW',
  'AWAITING_APPROVAL',
  'DEPLOY',
  'VERIFY',
  'HANDOFF',
  'SUCCEEDED',
] as const;
export type RunStage = (typeof RUN_STAGES)[number];

export const RUN_STATUSES = [
  'ACTIVE',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'NEEDS_INPUT',
  'BLOCKED',
  'ROLLBACK_REQUIRED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ArtifactRefSchema = z.object({
  kind: z.enum([
    'prompt',
    'requirements',
    'blueprint',
    'source',
    'log',
    'test-report',
    'plan',
    'manifest',
  ]),
  uri: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const ApprovalSchema = z.object({
  runId: z.string().min(1),
  stage: z.literal('deployment'),
  /** Binds the approval to one immutable plan and environment. */
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  targetEnvironment: z.string().min(1),
  actor: z.string().min(1),
  approvedAt: z.iso.datetime(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const RunSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  projectId: z.string().min(1),
  correlationId: z.string().min(1),
  blueprintVersion: z.number().int().nonnegative(),
  targetEnvironment: z.string().min(1),
  region: z.string().min(1),
  prompt: z.string().min(1),
  stage: z.enum(RUN_STAGES),
  status: z.enum(RUN_STATUSES),
  artifacts: z.array(ArtifactRefSchema),
  approvals: z.array(ApprovalSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Run = z.infer<typeof RunSchema>;

export const AuditEventSchema = z.object({
  runId: z.string().min(1),
  type: z.string().min(1),
  at: z.iso.datetime(),
  actor: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const ApplicationBlueprintSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  kind: z.literal('ApplicationBlueprint'),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, 'kebab-case project name'),
  requirements: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(['functional', 'nonfunctional', 'integration', 'assumption']),
      text: z.string().min(1),
    }),
  ),
  entities: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Z][A-Za-z0-9]{0,40}$/, 'PascalCase identifier'),
        fields: z
          .array(
            z.object({
              name: z.string().regex(/^[a-z][A-Za-z0-9]{0,40}$/, 'camelCase identifier'),
              type: z.enum(['string', 'number', 'boolean']),
              required: z.boolean().default(true),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  components: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(['frontend', 'api', 'database', 'auth', 'storage', 'events']),
      awsService: z.string().min(1),
      justification: z.string().min(1),
    }),
  ),
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      satisfies: z.array(z.string()).min(1),
      acceptance: z.array(z.string()).min(1),
    }),
  ),
  risks: z.array(z.string()),
});
export type ApplicationBlueprint = z.infer<typeof ApplicationBlueprintSchema>;

export const CloudSystemManifestSchema = z.object({
  schemaVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  kind: z.literal('CloudSystemManifest'),
  system: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  source: z.object({ repositoryUrl: z.string().optional(), revision: z.string().optional() }),
  environments: z.array(
    z.object({
      name: z.string().min(1),
      provider: z.literal('aws'),
      accountId: z.string().regex(/^\d{12}$/),
      region: z.string().min(1),
      stacks: z.array(z.string()),
      resources: z.array(z.object({ logicalId: z.string(), type: z.string() })),
    }),
  ),
  deployment: z.object({
    iac: z.literal('aws-cdk'),
    artifactRef: z.string().optional(),
    verifiedAt: z.iso.datetime().optional(),
  }),
});
export type CloudSystemManifest = z.infer<typeof CloudSystemManifestSchema>;
