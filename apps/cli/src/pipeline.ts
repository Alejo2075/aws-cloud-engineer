import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactRef, Run } from '@cloud-engineer/contracts';
import {
  createDeploymentPlan,
  hashAssembly,
  deploy as deployPlan,
  awsDeployDeps,
  verifyApi,
  type DeployDeps,
  type DeploymentPlan,
} from '@cloud-engineer/deployment';
import { generateProject, hashFiles, writeProject } from '@cloud-engineer/generation';
import { buildManifest, exportProject, manifestResources } from '@cloud-engineer/handoff';
import { checkTraceability, planBlueprint, type ModelProvider } from '@cloud-engineer/planning';
import { ApplicationBlueprintSchema, type ApplicationBlueprint } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';
import {
  hasBlockers,
  readSynthesizedTemplate,
  repairLoop,
  reviewTemplate,
  runGates,
} from '@cloud-engineer/validation';
import type { WorkflowEngine } from '@cloud-engineer/workflow';

export interface PipelineDeps {
  engine: WorkflowEngine;
  /** Local state root, e.g. ./.cloud-engineer */
  root: string;
  provider: ModelProvider;
  gates?: typeof runGates;
  deployDeps?: DeployDeps;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Allow bounded model-driven repair when a quality gate fails. */
  repair?: boolean;
}

export const runDir = (root: string, runId: string) => join(root, 'runs', runId);
export const projectDir = (root: string, runId: string) => join(runDir(root, runId), 'project');

async function saveArtifact(
  d: PipelineDeps,
  run: Run,
  kind: ArtifactRef['kind'],
  name: string,
  content: string,
): Promise<ArtifactRef> {
  const dir = join(runDir(d.root, run.runId), 'artifacts');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, content);
  const ref: ArtifactRef = {
    kind,
    uri: `file://${path}`,
    sha256: createHash('sha256').update(content).digest('hex'),
    createdAt: (d.now ?? (() => new Date()))().toISOString(),
  };
  await d.engine.attachArtifact(run.runId, ref);
  return ref;
}

export interface CreateOptions {
  prompt: string;
  region: string;
  environment: string;
  /** Explicit target account (12 digits). Never inferred from ambient credentials. */
  accountId: string;
  /** Client-supplied blueprint. Gets the same validation as model output; skips the model. */
  blueprint?: unknown;
}

/** Validates an externally supplied blueprint exactly like AI output (spec 6.1). */
export function parseSuppliedBlueprint(input: unknown): ApplicationBlueprint {
  const bp = ApplicationBlueprintSchema.parse(input);
  const problems = checkTraceability(bp);
  if (problems.length > 0) {
    throw new CloudEngineerError('VALIDATION_FAILED', `Blueprint invalid: ${problems.join('; ')}`);
  }
  return bp;
}

/**
 * Drives a new run from the prompt to AWAITING_APPROVAL. Every stage is persisted before the
 * next starts, so an interrupted run can be inspected; failures mark the run FAILED with evidence.
 */
export async function createRun(d: PipelineDeps, opts: CreateOptions): Promise<Run> {
  if (!/^\d{12}$/.test(opts.accountId)) {
    throw new CloudEngineerError(
      'VALIDATION_FAILED',
      '--account must be a 12-digit AWS account id',
    );
  }
  let run = await d.engine.createRun({
    prompt: opts.prompt,
    region: opts.region,
    targetEnvironment: opts.environment,
  });
  const id = run.runId;
  const fail = async (e: unknown): Promise<never> => {
    await d.engine.fail(id, e instanceof Error ? e.message : String(e));
    throw e;
  };
  const step = (to: Parameters<WorkflowEngine['transition']>[1]) => d.engine.transition(id, to);

  try {
    await saveArtifact(d, run, 'prompt', 'prompt.txt', opts.prompt);
    await step('INTAKE');
    await step('REQUIREMENTS');
    const blueprint =
      opts.blueprint !== undefined
        ? parseSuppliedBlueprint(opts.blueprint)
        : await planBlueprint(d.provider, opts.prompt);
    await saveArtifact(
      d,
      run,
      'requirements',
      'requirements.json',
      JSON.stringify(blueprint.requirements, null, 2),
    );
    await step('DESIGN');
    await saveArtifact(d, run, 'blueprint', 'blueprint.json', JSON.stringify(blueprint, null, 2));
    await step('PLAN');
    await step('GENERATE');
    const files = await generateProject(blueprint);
    const dir = projectDir(d.root, id);
    await writeProject(files, dir);
    await saveArtifact(d, run, 'source', 'source.sha256', hashFiles(files));

    await step('BUILD');
    const gates = d.gates ?? runGates;
    let report = await gates(dir);
    if (!report.passed && d.repair) {
      const outcome = await repairLoop(dir, d.provider, gates);
      report = outcome.reports[outcome.reports.length - 1]!;
    }
    await saveArtifact(d, run, 'test-report', 'gates.json', JSON.stringify(report, null, 2));
    if (!report.passed)
      throw new CloudEngineerError(
        'VALIDATION_FAILED',
        `Quality gate failed: ${report.failed?.id}`,
      );
    await step('TEST');

    await step('SECURITY_REVIEW');
    const stackName = `${blueprint.name}-${opts.environment}`;
    const template = await readSynthesizedTemplate(dir, stackName);
    const findings = reviewTemplate(template);
    await saveArtifact(d, run, 'log', 'security-findings.json', JSON.stringify(findings, null, 2));
    if (hasBlockers(findings))
      throw new CloudEngineerError('BLOCKED', 'Security review found blocking issues', findings);

    await step('DEPLOYMENT_REVIEW');
    const templateText = await readFile(join(dir, 'cdk.out', `${stackName}.template.json`), 'utf8');
    const { plan, hash } = createDeploymentPlan({
      runId: id,
      stackName,
      accountId: opts.accountId,
      region: opts.region,
      environment: opts.environment,
      templateText,
      assemblySha256: await hashAssembly(join(dir, 'cdk.out')),
    });
    // The artifact's sha256 is the plan hash, which is exactly what approval binds to.
    const planPath = join(runDir(d.root, id), 'artifacts', 'plan.json');
    await mkdir(join(runDir(d.root, id), 'artifacts'), { recursive: true });
    await writeFile(planPath, JSON.stringify(plan, null, 2));
    await d.engine.attachArtifact(id, {
      kind: 'plan',
      uri: `file://${planPath}`,
      sha256: hash,
      createdAt: (d.now ?? (() => new Date()))().toISOString(),
    });
    run = await step('AWAITING_APPROVAL');
    return run;
  } catch (e) {
    return fail(e);
  }
}

export async function loadPlan(
  d: PipelineDeps,
  runId: string,
): Promise<{ plan: DeploymentPlan; hash: string }> {
  const run = await d.engine.getRun(runId);
  const ref = run.artifacts.findLast((a) => a.kind === 'plan');
  if (!ref) throw new CloudEngineerError('NOT_FOUND', 'Run has no deployment plan yet');
  const plan = JSON.parse(
    await readFile(join(runDir(d.root, runId), 'artifacts', 'plan.json'), 'utf8'),
  ) as DeploymentPlan;
  return { plan, hash: ref.sha256 };
}

export interface ApproveOptions {
  planHash: string;
  environment: string;
  actor: string;
}

export interface ApproveResult {
  run: Run;
  deployed: boolean;
  verified: boolean;
  detail: string;
}

/**
 * Records an approval bound to the exact plan hash + environment, deploys the pre-synthesized
 * assembly, verifies it, and writes the handoff manifest. "deployed" and "verified" are reported
 * separately; SUCCEEDED requires verification to pass.
 */
export async function approveAndDeploy(
  d: PipelineDeps,
  runId: string,
  opts: ApproveOptions,
): Promise<ApproveResult> {
  const { plan } = await loadPlan(d, runId);
  let run = await d.engine.approve(
    runId,
    { planHash: opts.planHash, targetEnvironment: opts.environment },
    opts.actor,
  );
  const approval = run.approvals[run.approvals.length - 1]!;
  const dir = projectDir(d.root, runId);

  const result = await deployPlan(dir, plan, approval, d.deployDeps ?? awsDeployDeps).catch(
    async (e) => {
      await d.engine.fail(runId, e instanceof Error ? e.message : String(e));
      throw e;
    },
  );
  if (result.status === 'failed') {
    run = await d.engine.fail(runId, 'Deployment failed');
    return { run, deployed: false, verified: false, detail: result.log };
  }

  await d.engine.transition(runId, 'VERIFY');
  const apiUrl = result.outputs.ApiUrl ?? '';
  const blueprint = JSON.parse(await readFile(join(dir, 'blueprint.json'), 'utf8')) as {
    entities: { name: string }[];
  };
  const report = await verifyApi(
    apiUrl,
    blueprint.entities.map((e) => `${e.name.toLowerCase()}s`),
    d.fetchImpl ?? fetch,
    d.now,
  );
  await saveArtifact(
    d,
    await d.engine.getRun(runId),
    'test-report',
    'verification.json',
    JSON.stringify(report, null, 2),
  );
  if (!report.verified) {
    run = await d.engine.fail(runId, 'Post-deployment verification failed');
    return { run, deployed: true, verified: false, detail: JSON.stringify(report.checks) };
  }

  await d.engine.transition(runId, 'HANDOFF');
  const template = JSON.parse(
    await readFile(join(dir, 'cdk.out', `${plan.stackName}.template.json`), 'utf8'),
  ) as { Resources?: Record<string, { Type: string }> };
  const manifest = buildManifest({
    systemId: plan.stackName.replace(`-${plan.environment}`, ''),
    name: plan.stackName,
    environment: plan.environment,
    accountId: plan.accountId,
    region: plan.region,
    stackName: plan.stackName,
    resources: manifestResources(template),
    artifactRef: `file://${runDir(d.root, runId)}/artifacts/manifest.json`,
    verifiedAt: report.checkedAt,
  });
  await saveArtifact(
    d,
    await d.engine.getRun(runId),
    'manifest',
    'manifest.json',
    JSON.stringify(manifest, null, 2),
  );
  run = await d.engine.transition(runId, 'SUCCEEDED');
  return { run, deployed: true, verified: true, detail: apiUrl };
}

export async function exportRun(d: PipelineDeps, runId: string, output: string): Promise<string[]> {
  const run = await d.engine.getRun(runId);
  const manifestRef = run.artifacts.findLast((a) => a.kind === 'manifest');
  const manifest = manifestRef
    ? JSON.parse(await readFile(join(runDir(d.root, runId), 'artifacts', 'manifest.json'), 'utf8'))
    : undefined;
  return exportProject(projectDir(d.root, runId), output, manifest);
}
