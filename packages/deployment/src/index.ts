import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { Approval } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';
import { hasBlockers, reviewTemplate, type Finding } from '@cloud-engineer/validation';

// ---------------------------------------------------------------- plan

export interface PlannedResource {
  logicalId: string;
  type: string;
  action: 'create';
}

export interface DeploymentPlan {
  schemaVersion: '1.0.0';
  runId: string;
  stackName: string;
  accountId: string;
  region: string;
  environment: string;
  /** SHA-256 of the exact synthesized template that would be deployed. */
  templateSha256: string;
  /** SHA-256 over every file of the cloud assembly (template, asset manifests, asset bundles). */
  assemblySha256: string;
  resources: PlannedResource[];
  findings: Finding[];
  risks: string[];
  /** Qualitative only: no figures are invented. */
  costNotes: string[];
  requiresApprovalFor: string[];
}

type Template = { Resources?: Record<string, { Type: string }> };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Stable JSON: object keys sorted recursively so equal plans hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic hash of a whole cloud assembly directory (relative paths + bytes, sorted). */
export async function hashAssembly(dir: string): Promise<string> {
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(dir);
  const h = createHash('sha256');
  for (const f of files.sort())
    h.update(relative(dir, f))
      .update('\0')
      .update(await readFile(f))
      .update('\0');
  return h.digest('hex');
}

export const planHashOf = (plan: DeploymentPlan) => sha256(canonicalJson(plan));

export function createDeploymentPlan(input: {
  runId: string;
  stackName: string;
  accountId: string;
  region: string;
  environment: string;
  templateText: string;
  assemblySha256: string;
}): { plan: DeploymentPlan; hash: string } {
  if (!/^\d{12}$/.test(input.accountId)) {
    throw new CloudEngineerError('VALIDATION_FAILED', 'accountId must be 12 digits');
  }
  const template = JSON.parse(input.templateText) as Template;
  const resources = Object.entries(template.Resources ?? {})
    .map(([logicalId, r]) => ({ logicalId, type: r.Type, action: 'create' as const }))
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  const findings = reviewTemplate(template);
  const types = new Set(resources.map((r) => r.type));

  const risks = ['First deployment into this account/region creates all listed resources.'];
  const requiresApprovalFor = ['first-deployment'];
  if (types.has('AWS::IAM::Role')) {
    risks.push('Creates IAM roles (least-privilege review recorded in findings).');
    requiresApprovalFor.push('iam-creation');
  }
  if (types.has('AWS::ApiGatewayV2::Api')) {
    risks.push('Exposes a public HTTPS endpoint; routes require a Cognito JWT.');
    requiresApprovalFor.push('public-endpoint');
  }
  if (input.environment === 'production') requiresApprovalFor.push('production');
  for (const f of findings) if (f.severity !== 'low') risks.push(`${f.severity}: ${f.message}`);

  const plan: DeploymentPlan = {
    schemaVersion: '1.0.0',
    runId: input.runId,
    stackName: input.stackName,
    accountId: input.accountId,
    region: input.region,
    environment: input.environment,
    templateSha256: sha256(input.templateText),
    assemblySha256: input.assemblySha256,
    resources,
    findings,
    risks,
    costNotes: [
      'Estimate, not a quote: DynamoDB on-demand, Lambda and API Gateway HTTP API bill per request.',
      'No fixed hourly resources (NAT gateways, databases, search domains) in this plan.',
      ...(findings.some((f) => f.rule === 'high-cost-resource')
        ? ['WARNING: fixed-cost resources are present; review before approving.']
        : []),
    ],
    requiresApprovalFor,
  };
  if (hasBlockers(findings)) {
    throw new CloudEngineerError('BLOCKED', 'Plan has high-severity findings', findings);
  }
  return { plan, hash: planHashOf(plan) };
}

export function renderPlan(plan: DeploymentPlan, hash: string): string {
  return [
    `Deployment plan ${hash}`,
    `  stack:       ${plan.stackName}`,
    `  account:     ${plan.accountId}   region: ${plan.region}   environment: ${plan.environment}`,
    `  resources:   ${plan.resources.length} to create`,
    ...plan.resources.map((r) => `    + ${r.type}  ${r.logicalId}`),
    `  risks:`,
    ...plan.risks.map((r) => `    - ${r}`),
    `  cost:`,
    ...plan.costNotes.map((c) => `    - ${c}`),
    `  approval required for: ${plan.requiresApprovalFor.join(', ')}`,
  ].join('\n');
}

// ---------------------------------------------------------------- deploy

export function buildDeployArgs(plan: DeploymentPlan, outputsFile: string): string[] {
  return [
    'deploy',
    plan.stackName,
    '--app',
    'cdk.out',
    '--require-approval',
    'never',
    '--outputs-file',
    outputsFile,
  ];
}

/** What an out-of-process deployer needs to know about the approved plan. */
export interface DeployContext {
  runId: string;
  stackName: string;
  accountId: string;
  region: string;
}

export interface DeployDeps {
  /**
   * The account the credentials used for the deployment belong to. `expectedAccountId` is the plan's
   * account, for deployers that obtain credentials per target (they must still verify it).
   */
  callerAccount(region: string, expectedAccountId?: string): Promise<string>;
  /** Runs the deploy for the assembly in `assemblyDir` (a directory named cdk.out's parent contents). */
  exec(
    args: string[],
    assemblyDir: string,
    ctx?: DeployContext,
  ): Promise<{
    exitCode: number | null;
    log: string;
    outputs?: Record<string, Record<string, string>>;
  }>;
}

/** Only these variables reach the CDK CLI: AWS credential/config settings and PATH. */
export function deployEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    AWS_CONFIG_FILE: base.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'),
    AWS_SHARED_CREDENTIALS_FILE:
      base.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'),
    NPM_CONFIG_USERCONFIG: '/dev/null',
  };
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && (k === 'PATH' || /^AWS_/.test(k)) && !(k in env)) env[k] = v;
  }
  return env;
}

export const awsDeployDeps: DeployDeps = {
  async callerAccount(region) {
    const id = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
    return id.Account ?? '';
  },
  /**
   * Uses the CDK CLI pinned in this package (never the generated project's node_modules or
   * `npx`), from a temp directory holding only a copy of the verified cloud assembly.
   */
  async exec(args, assemblyDir) {
    const cdkBin = createRequire(import.meta.url).resolve('aws-cdk/bin/cdk');
    const work = await mkdtemp(join(tmpdir(), 'ce-deploy-'));
    try {
      await cp(assemblyDir, join(work, 'cdk.out'), { recursive: true });
      const outputsFile = join(work, 'outputs.json');
      const finalArgs = args.map((a) => (a === 'cdk-outputs.json' ? outputsFile : a));
      const res = await new Promise<{ exitCode: number | null; log: string }>((resolve) => {
        const child = spawn(process.execPath, [cdkBin, ...finalArgs], {
          cwd: work,
          shell: false,
          env: deployEnv(work),
        });
        const out: Buffer[] = [];
        child.stdout.on('data', (d: Buffer) => out.push(d));
        child.stderr.on('data', (d: Buffer) => out.push(d));
        child.on('error', (e) => resolve({ exitCode: null, log: e.message }));
        child.on('close', (code) =>
          resolve({ exitCode: code, log: Buffer.concat(out).toString('utf8') }),
        );
      });
      if (res.exitCode !== 0) return res;
      const outputs = JSON.parse(await readFile(outputsFile, 'utf8')) as Record<
        string,
        Record<string, string>
      >;
      return { ...res, outputs };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
};

export type DeployResult =
  { status: 'deployed'; outputs: Record<string, string> } | { status: 'failed'; log: string };

/**
 * Deploys the already-synthesized, already-reviewed cloud assembly (`--app cdk.out`), so no
 * generated code runs with deployment credentials. Refuses unless the approval matches the
 * exact plan hash, environment and the account the credentials actually belong to.
 */
export async function deploy(
  projectDir: string,
  plan: DeploymentPlan,
  approval: Approval,
  deps: DeployDeps = awsDeployDeps,
): Promise<DeployResult> {
  if (approval.planHash !== planHashOf(plan)) {
    throw new CloudEngineerError('APPROVAL_MISMATCH', 'Approval does not match this plan');
  }
  if (approval.targetEnvironment !== plan.environment || approval.runId !== plan.runId) {
    throw new CloudEngineerError('APPROVAL_MISMATCH', 'Approval environment or run mismatch');
  }
  const assemblyDir = join(projectDir, 'cdk.out');
  const templateText = await readFile(join(assemblyDir, `${plan.stackName}.template.json`), 'utf8');
  if (
    sha256(templateText) !== plan.templateSha256 ||
    (await hashAssembly(assemblyDir)) !== plan.assemblySha256
  ) {
    throw new CloudEngineerError('APPROVAL_MISMATCH', 'Cloud assembly changed since the plan');
  }
  const account = await deps.callerAccount(plan.region, plan.accountId);
  if (account !== plan.accountId) {
    throw new CloudEngineerError(
      'APPROVAL_MISMATCH',
      `Credentials belong to ${account}, plan targets ${plan.accountId}`,
    );
  }
  const res = await deps.exec(buildDeployArgs(plan, 'cdk-outputs.json'), assemblyDir, {
    runId: plan.runId,
    stackName: plan.stackName,
    accountId: plan.accountId,
    region: plan.region,
  });
  if (res.exitCode !== 0) return { status: 'failed', log: res.log.slice(-4000) };
  return { status: 'deployed', outputs: res.outputs?.[plan.stackName] ?? {} };
}

/** Reports the real CloudFormation state, including rollback states. */
export async function stackState(stackName: string, region: string): Promise<string> {
  const res = await new CloudFormationClient({ region }).send(
    new DescribeStacksCommand({ StackName: stackName }),
  );
  return res.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
}

// ---------------------------------------------------------------- verify

export interface VerificationCheck {
  name: string;
  passed: boolean;
  detail: string;
}
export interface VerificationReport {
  verified: boolean;
  checkedAt: string;
  checks: VerificationCheck[];
}

/**
 * Black-box smoke test of a deployed API: it must be reachable over HTTPS and must reject
 * unauthenticated requests. "Deployed" is not "verified" until these pass.
 */
export async function verifyApi(
  apiUrl: string,
  routes: string[],
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = [];
  checks.push({ name: 'https', passed: apiUrl.startsWith('https://'), detail: apiUrl });
  for (const route of routes) {
    try {
      const res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/${route}`, {
        signal: AbortSignal.timeout(15_000),
      });
      checks.push({
        name: `unauthenticated GET /${route} is rejected`,
        passed: res.status === 401,
        detail: `status ${res.status}`,
      });
    } catch (err) {
      checks.push({
        name: `GET /${route} reachable`,
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { verified: checks.every((c) => c.passed), checkedAt: now().toISOString(), checks };
}
