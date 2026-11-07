import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
  StopBuildCommand,
  type Build,
} from '@aws-sdk/client-codebuild';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { DeployContext, DeployDeps } from '@cloud-engineer/deployment';
import { zipDirectory } from './codebuild-gates.js';
import type { DocClient } from './dynamo-store.js';

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const STACK = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const ROLE = /^[A-Za-z0-9+=,.@_-]{1,64}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface CodeBuildDeployerOptions {
  s3: DocClient;
  codebuild: DocClient;
  bucket: string;
  /**
   * One CodeBuild project per target account (account id -> project name). Each project's role can
   * assume the deploy role of its own account only, so a build can never reach another account.
   * The keys are also the allow-list: any other account is refused before a build starts.
   */
  projects: Record<string, string>;
  /** Role the customer created in the target account (trusting the deployer project's role). */
  roleName: string;
  externalId?: string;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Deploys the approved, pre-synthesized assembly from an ephemeral CodeBuild project instead of this
 * process. The control plane never holds target-account credentials: the build assumes
 * arn:aws:iam::<account>:role/<roleName> itself, verifies the account with sts:GetCallerIdentity
 * (the build fails on a mismatch) and runs `cdk deploy` on the uploaded assembly.
 * Offline-tested with fakes only; never run against AWS.
 */
export class CodeBuildDeployer implements DeployDeps {
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: CodeBuildDeployerOptions) {
    if (!ROLE.test(o.roleName)) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid deploy role name');
    }
    const accounts = Object.keys(o.projects);
    if (accounts.length === 0 || accounts.some((a) => !/^\d{12}$/.test(a))) {
      throw new CloudEngineerError(
        'VALIDATION_FAILED',
        'projects must be keyed by 12-digit account ids',
      );
    }
    this.pollMs = o.pollMs ?? 10_000;
    this.timeoutMs = o.timeoutMs ?? 40 * 60_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private assertTarget(accountId: string): void {
    if (!Object.hasOwn(this.o.projects, accountId)) {
      throw new CloudEngineerError(
        'BLOCKED',
        `Account ${accountId} is not in the deployer's allow-list`,
      );
    }
  }

  /**
   * The assumed role lives in the plan's account by construction, and the build re-checks the
   * identity it actually received; this only enforces the allow-list before anything is started.
   */
  async callerAccount(_region: string, expectedAccountId?: string): Promise<string> {
    if (!expectedAccountId) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'The target account is required');
    }
    this.assertTarget(expectedAccountId);
    return expectedAccountId;
  }

  async exec(args: string[], assemblyDir: string, ctx?: DeployContext) {
    if (!ctx) throw new CloudEngineerError('VALIDATION_FAILED', 'Missing deploy context');
    if (!RUN_ID.test(ctx.runId) || !STACK.test(ctx.stackName) || !REGION.test(ctx.region)) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid deploy context');
    }
    this.assertTarget(ctx.accountId);
    // The build runs a fixed command line; refuse arguments it would not reproduce.
    if (args[0] !== 'deploy' || args[1] !== ctx.stackName) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Unexpected deploy arguments');
    }

    const started = Date.now();
    const sourceKey = `build-input/${ctx.runId}/assembly.zip`;
    const outputPath = `build-output/${ctx.runId}/deploy`;
    // Every file of the assembly, including bundled assets; nothing is filtered out.
    const zip = await zipDirectory(assemblyDir, { skip: new Set() });
    await this.o.s3.send(
      new PutObjectCommand({
        Bucket: this.o.bucket,
        Key: sourceKey,
        Body: zip,
        ContentType: 'application/zip',
        ServerSideEncryption: 'aws:kms',
      }),
    );
    const env = (name: string, value: string) => ({ name, value, type: 'PLAINTEXT' as const });
    const startRes = (await this.o.codebuild.send(
      new StartBuildCommand({
        projectName: this.o.projects[ctx.accountId]!,
        sourceTypeOverride: 'S3',
        sourceLocationOverride: `${this.o.bucket}/${sourceKey}`,
        artifactsOverride: {
          type: 'S3',
          location: this.o.bucket,
          path: outputPath,
          namespaceType: 'NONE',
          packaging: 'NONE',
          name: '/',
          encryptionDisabled: false,
        },
        environmentVariablesOverride: [
          env('TARGET_ROLE_ARN', `arn:aws:iam::${ctx.accountId}:role/${this.o.roleName}`),
          env('EXPECTED_ACCOUNT', ctx.accountId),
          env('AWS_DEFAULT_REGION', ctx.region),
          env('STACK_NAME', ctx.stackName),
          env('RUN_ID', ctx.runId),
          env('EXTERNAL_ID', this.o.externalId ?? ''),
        ],
      }),
    )) as { build?: Build };
    const id = startRes.build?.id;
    if (!id) throw new CloudEngineerError('CONFLICT', 'CodeBuild did not return a build id');

    for (;;) {
      const res = (await this.o.codebuild.send(new BatchGetBuildsCommand({ ids: [id] }))) as {
        builds?: Build[];
      };
      const build = res.builds?.[0];
      if (build && build.buildStatus !== 'IN_PROGRESS') return this.finish(id, build, outputPath);
      if (Date.now() - started > this.timeoutMs) {
        await this.o.codebuild.send(new StopBuildCommand({ id }));
        return {
          exitCode: 1,
          log: `deployment build ${id} exceeded ${this.timeoutMs} ms and was stopped; check the CloudFormation stack state before retrying`,
        };
      }
      await this.sleep(this.pollMs);
    }
  }

  private async finish(id: string, build: Build, outputPath: string) {
    const status = build.buildStatus ?? 'UNKNOWN';
    const phases = (build.phases ?? [])
      .filter((p) => p.phaseStatus && p.phaseStatus !== 'SUCCEEDED')
      .map((p) => ({
        phase: p.phaseType,
        status: p.phaseStatus,
        messages: (p.contexts ?? []).map((c) => c.message).filter(Boolean),
      }));
    // Phase metadata only: full logs stay in CloudWatch Logs and are not fetched here.
    const log = `build ${id} ${status}; ${JSON.stringify(phases).slice(-1500)}`;
    if (status !== 'SUCCEEDED') return { exitCode: 1, log };
    const got = (await this.o.s3.send(
      new GetObjectCommand({ Bucket: this.o.bucket, Key: `${outputPath}/cdk-outputs.json` }),
    )) as { Body?: { transformToString(): Promise<string> } };
    if (!got.Body) {
      return { exitCode: 1, log: `${log}; the build succeeded but produced no cdk-outputs.json` };
    }
    let outputs: Record<string, Record<string, string>>;
    try {
      outputs = JSON.parse(await got.Body.transformToString());
    } catch {
      return { exitCode: 1, log: `${log}; cdk-outputs.json is not valid JSON` };
    }
    return { exitCode: 0, log, outputs };
  }
}

/** Builds the deployer with the control plane's own credentials (default provider chain). */
export function createCodeBuildDeployer(
  region: string,
  bucket: string,
  opts: { projects: Record<string, string>; roleName: string; externalId?: string },
): CodeBuildDeployer {
  return new CodeBuildDeployer({
    s3: new S3Client({ region }),
    codebuild: new CodeBuildClient({ region }),
    bucket,
    projects: opts.projects,
    roleName: opts.roleName,
    ...(opts.externalId ? { externalId: opts.externalId } : {}),
  });
}
