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
  verifySite,
  type DeployDeps,
  type DeploymentPlan,
} from '@cloud-engineer/deployment';
import { generateProject, hashFiles, writeProject } from '@cloud-engineer/generation';
import {
  buildManifest,
  exportProject,
  initGitRepository,
  manifestResources,
} from '@cloud-engineer/handoff';
import {
  checkTraceability,
  planRequirements,
  type Decision,
  type ModelProvider,
} from '@cloud-engineer/planning';
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

interface Intake {
  accountId: string;
  blueprint?: unknown;
}

const now = (d: PipelineDeps) => (d.now ?? (() => new Date()))().toISOString();

async function readJson<T>(d: PipelineDeps, runId: string, name: string): Promise<T> {
  return JSON.parse(await readFile(join(runDir(d.root, runId), 'artifacts', name), 'utf8')) as T;
}

/**
 * Creates a run, persists its intake, and advances it to AWAITING_APPROVAL. Failures mark the
 * run FAILED with evidence; `resumeRun` can retry from the stage that failed.
 */
export async function createRun(d: PipelineDeps, opts: CreateOptions): Promise<Run> {
  if (!/^\d{12}$/.test(opts.accountId)) {
    throw new CloudEngineerError(
      'VALIDATION_FAILED',
      '--account must be a 12-digit AWS account id',
    );
  }
  const run = await d.engine.createRun({
    prompt: opts.prompt,
    region: opts.region,
    targetEnvironment: opts.environment,
  });
  const intake: Intake = {
    accountId: opts.accountId,
    ...(opts.blueprint !== undefined ? { blueprint: opts.blueprint } : {}),
  };
  await saveArtifact(d, run, 'prompt', 'prompt.txt', opts.prompt);
  await saveArtifact(d, run, 'prompt', 'intake.json', JSON.stringify(intake, null, 2));
  return advance(d, run.runId);
}

/**
 * Retries a FAILED run from the stage that failed, or continues an ACTIVE run whose process was
 * interrupted. Failures after approval (DEPLOY and later) are refused: deployment is never replayed.
 */
export async function resumeRun(d: PipelineDeps, runId: string, actor = 'local'): Promise<Run> {
  const run = await d.engine.getRun(runId);
  if (run.status === 'FAILED') await d.engine.resume(runId, actor);
  else if (run.status !== 'ACTIVE') {
    throw new CloudEngineerError(
      'INVALID_TRANSITION',
      `Run is ${run.status} and cannot be resumed`,
    );
  }
  return advance(d, runId);
}

/** Total clarifying questions a run may ask; after that the model must use defaults. */
const MAX_QUESTIONS = 3;

async function readDecisions(d: PipelineDeps, runId: string): Promise<Decision[]> {
  try {
    return await readJson<Decision[]>(d, runId, 'decisions.json');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Questions the run is currently waiting on (empty unless NEEDS_INPUT). */
export async function pendingQuestions(d: PipelineDeps, runId: string): Promise<string[]> {
  const run = await d.engine.getRun(runId);
  return run.status === 'NEEDS_INPUT' ? readJson<string[]>(d, runId, 'questions.json') : [];
}

/**
 * Records the user's answers (one per pending question, in order) as a persisted decision and
 * continues the run. Answers are untrusted text and only ever reach the model inside <decisions>.
 */
export async function respondToInput(
  d: PipelineDeps,
  runId: string,
  answers: string[],
  actor = 'local',
): Promise<Run> {
  const run = await d.engine.getRun(runId);
  const questions = await pendingQuestions(d, runId);
  if (run.status !== 'NEEDS_INPUT') {
    throw new CloudEngineerError('INVALID_TRANSITION', `Run is ${run.status}, not NEEDS_INPUT`);
  }
  const clean = answers.map((a) => a.trim());
  if (clean.length !== questions.length || clean.some((a) => !a || a.length > 1000)) {
    throw new CloudEngineerError(
      'VALIDATION_FAILED',
      `Provide exactly ${questions.length} non-empty answers (max 1000 characters each)`,
    );
  }
  const decisions = [
    ...(await readDecisions(d, runId)),
    ...questions.map((question, i) => ({ question, answer: clean[i]! })),
  ];
  await saveArtifact(d, run, 'requirements', 'decisions.json', JSON.stringify(decisions, null, 2));
  await d.engine.provideInput(runId, actor);
  return advance(d, runId);
}

/** State-driven loop: each stage's work is idempotent and keyed off persisted artifacts. */
async function advance(d: PipelineDeps, runId: string): Promise<Run> {
  const dir = projectDir(d.root, runId);
  const step = (to: Parameters<WorkflowEngine['transition']>[1]) => d.engine.transition(runId, to);
  try {
    for (;;) {
      const run = await d.engine.getRun(runId);
      if (run.status !== 'ACTIVE') return run;
      switch (run.stage) {
        case 'CREATED':
          await step('INTAKE');
          break;
        case 'INTAKE':
          await step('REQUIREMENTS');
          break;
        case 'REQUIREMENTS': {
          const intake = await readJson<Intake>(d, runId, 'intake.json');
          let blueprint: ApplicationBlueprint;
          if (intake.blueprint !== undefined) {
            blueprint = parseSuppliedBlueprint(intake.blueprint);
          } else {
            const decisions = await readDecisions(d, runId);
            const result = await planRequirements(d.provider, run.prompt, {
              decisions,
              allowQuestions: decisions.length < MAX_QUESTIONS,
            });
            if (result.kind === 'questions') {
              await saveArtifact(
                d,
                run,
                'requirements',
                'questions.json',
                JSON.stringify(result.questions, null, 2),
              );
              return d.engine.requestInput(runId, result.questions);
            }
            blueprint = result.blueprint;
          }
          await saveArtifact(
            d,
            run,
            'requirements',
            'requirements.json',
            JSON.stringify(blueprint.requirements, null, 2),
          );
          await saveArtifact(
            d,
            run,
            'blueprint',
            'blueprint.json',
            JSON.stringify(blueprint, null, 2),
          );
          await step('DESIGN');
          break;
        }
        case 'DESIGN':
          await step('PLAN');
          break;
        case 'PLAN':
          await step('GENERATE');
          break;
        case 'GENERATE': {
          const blueprint = parseSuppliedBlueprint(await readJson(d, runId, 'blueprint.json'));
          const files = await generateProject(blueprint);
          await writeProject(files, dir);
          await saveArtifact(d, run, 'source', 'source.sha256', hashFiles(files));
          await step('BUILD');
          break;
        }
        case 'BUILD': {
          const gates = d.gates ?? runGates;
          let report = await gates(dir);
          if (!report.passed && d.repair) {
            const outcome = await repairLoop(dir, d.provider, gates);
            report = outcome.reports[outcome.reports.length - 1]!;
          }
          await saveArtifact(d, run, 'test-report', 'gates.json', JSON.stringify(report, null, 2));
          if (!report.passed) {
            throw new CloudEngineerError(
              'VALIDATION_FAILED',
              `Quality gate failed: ${report.failed?.id}`,
            );
          }
          await step('TEST');
          break;
        }
        case 'TEST':
          await step('SECURITY_REVIEW');
          break;
        case 'SECURITY_REVIEW': {
          const stackName = await stackNameOf(d, run);
          const findings = reviewTemplate(await readSynthesizedTemplate(dir, stackName));
          await saveArtifact(
            d,
            run,
            'log',
            'security-findings.json',
            JSON.stringify(findings, null, 2),
          );
          if (hasBlockers(findings)) {
            throw new CloudEngineerError(
              'BLOCKED',
              'Security review found blocking issues',
              findings,
            );
          }
          await step('DEPLOYMENT_REVIEW');
          break;
        }
        case 'DEPLOYMENT_REVIEW': {
          const stackName = await stackNameOf(d, run);
          const intake = await readJson<Intake>(d, runId, 'intake.json');
          const templateText = await readFile(
            join(dir, 'cdk.out', `${stackName}.template.json`),
            'utf8',
          );
          const { plan, hash } = createDeploymentPlan({
            runId,
            stackName,
            accountId: intake.accountId,
            region: run.region,
            environment: run.targetEnvironment,
            templateText,
            assemblySha256: await hashAssembly(join(dir, 'cdk.out')),
          });
          // The artifact's sha256 is the plan hash, which is exactly what approval binds to.
          const planPath = join(runDir(d.root, runId), 'artifacts', 'plan.json');
          await mkdir(join(runDir(d.root, runId), 'artifacts'), { recursive: true });
          await writeFile(planPath, JSON.stringify(plan, null, 2));
          await d.engine.attachArtifact(runId, {
            kind: 'plan',
            uri: `file://${planPath}`,
            sha256: hash,
            createdAt: now(d),
          });
          await step('AWAITING_APPROVAL');
          break;
        }
        default:
          return run; // AWAITING_APPROVAL and later stages are driven by approve
      }
    }
  } catch (e) {
    await d.engine.fail(runId, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

async function stackNameOf(d: PipelineDeps, run: Run): Promise<string> {
  const bp = await readJson<{ name: string }>(d, run.runId, 'blueprint.json');
  return `${bp.name}-${run.targetEnvironment}`;
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
  const apiReport = await verifyApi(
    apiUrl,
    blueprint.entities.map((e) => `${e.name.toLowerCase()}s`),
    d.fetchImpl ?? fetch,
    d.now,
  );
  // Frontend templates also publish a SiteUrl; it must pass its own checks for the run to verify.
  const siteReport = result.outputs.SiteUrl
    ? await verifySite(result.outputs.SiteUrl, d.fetchImpl ?? fetch, d.now)
    : undefined;
  const report = siteReport
    ? {
        verified: apiReport.verified && siteReport.verified,
        checkedAt: apiReport.checkedAt,
        checks: [...apiReport.checks, ...siteReport.checks],
      }
    : apiReport;
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

export async function exportRun(
  d: PipelineDeps,
  runId: string,
  output: string,
  opts: { git?: boolean } = {},
): Promise<string[]> {
  const run = await d.engine.getRun(runId);
  const manifestRef = run.artifacts.findLast((a) => a.kind === 'manifest');
  const manifest = manifestRef
    ? JSON.parse(await readFile(join(runDir(d.root, runId), 'artifacts', 'manifest.json'), 'utf8'))
    : undefined;
  const written = await exportProject(projectDir(d.root, runId), output, manifest);
  if (opts.git) written.push(`git:${await initGitRepository(output)}`);
  return written;
}
