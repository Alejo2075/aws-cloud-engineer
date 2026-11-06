#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { renderPlan } from '@cloud-engineer/deployment';
import { BedrockProvider } from '@cloud-engineer/providers';
import { CloudEngineerError } from '@cloud-engineer/shared';
import { FileRunStore, WorkflowEngine } from '@cloud-engineer/workflow';
import { approveAndDeploy, createRun, exportRun, loadPlan, type PipelineDeps } from './pipeline.js';

const program = new Command('cloud-engineer')
  .description('Turn a prompt into a verified AWS application')
  .option(
    '--state-dir <dir>',
    'where runs are stored',
    process.env.CLOUD_ENGINEER_HOME ?? '.cloud-engineer',
  );

const noModel: PipelineDeps['provider'] = {
  generate: () =>
    Promise.reject(
      new CloudEngineerError('VALIDATION_FAILED', 'This command does not use a model'),
    ),
};

function deps(provider: PipelineDeps['provider'] = noModel): PipelineDeps {
  const root = resolve(program.opts<{ stateDir: string }>().stateDir);
  return { engine: new WorkflowEngine(new FileRunStore(root)), root, provider };
}

function bedrock(region: string) {
  const modelId = process.env.CLOUD_ENGINEER_MODEL_ID;
  if (!modelId) {
    throw new CloudEngineerError(
      'VALIDATION_FAILED',
      'Set CLOUD_ENGINEER_MODEL_ID (a Bedrock model or inference profile id)',
    );
  }
  return new BedrockProvider({ modelId, region });
}

program
  .command('create <prompt>')
  .description('Plan, generate, build and test an application, then stop for deployment approval')
  .requiredOption('--account <id>', 'target AWS account id (12 digits)')
  .option('--region <region>', 'target region', 'us-east-1')
  .option('--environment <name>', 'target environment', 'staging')
  .option('--blueprint <file>', 'use this Application Blueprint JSON instead of the model')
  .option('--repair', 'allow bounded model-driven repair of failing gates', false)
  .action(
    async (
      prompt: string,
      o: {
        account: string;
        region: string;
        environment: string;
        repair: boolean;
        blueprint?: string;
      },
    ) => {
      const blueprint = o.blueprint ? JSON.parse(await readFile(o.blueprint, 'utf8')) : undefined;
      const d = { ...deps(blueprint ? undefined : bedrock(o.region)), repair: o.repair };
      const run = await createRun(d, {
        prompt,
        region: o.region,
        environment: o.environment,
        accountId: o.account,
        blueprint,
      });
      const { plan, hash } = await loadPlan(d, run.runId);
      console.log(`Run ${run.runId} is ${run.stage}\n`);
      console.log(renderPlan(plan, hash));
      console.log(
        `\nNothing has been deployed. To deploy:\n  cloud-engineer approve ${run.runId} --plan-hash ${hash} --environment ${plan.environment}`,
      );
    },
  );

program
  .command('status <runId>')
  .description('Show run status')
  .action(async (runId: string) => {
    const d = deps();
    const run = await d.engine.getRun(runId);
    console.log(
      JSON.stringify(
        {
          runId,
          stage: run.stage,
          status: run.status,
          environment: run.targetEnvironment,
          artifacts: run.artifacts.map((a) => a.kind),
          updatedAt: run.updatedAt,
        },
        null,
        2,
      ),
    );
  });

const runs = program.command('runs').description('Inspect runs');
runs.command('list').action(async () => {
  for (const r of await deps().engine['store'].list())
    console.log(`${r.runId}  ${r.stage.padEnd(18)} ${r.status}`);
});
runs.command('artifacts <runId>').action(async (runId: string) => {
  const run = await deps().engine.getRun(runId);
  for (const a of run.artifacts)
    console.log(`${a.kind.padEnd(13)} ${a.sha256.slice(0, 12)}  ${a.uri}`);
});

program
  .command('approve <runId>')
  .description('Approve the exact plan hash and deploy to the target account')
  .requiredOption('--plan-hash <hash>', 'hash shown in the deployment plan')
  .requiredOption('--environment <name>', 'must match the plan environment')
  .option(
    '--actor <name>',
    'approver identity recorded in the audit trail',
    process.env.USER ?? 'local',
  )
  .action(async (runId: string, o: { planHash: string; environment: string; actor: string }) => {
    const res = await approveAndDeploy(deps(), runId, {
      planHash: o.planHash,
      environment: o.environment,
      actor: o.actor,
    });
    console.log(
      `deployed: ${res.deployed}\nverified: ${res.verified}\nstatus:   ${res.run.status} (${res.run.stage})\n${res.detail}`,
    );
    if (!res.verified) process.exitCode = 1;
  });

program
  .command('cancel <runId>')
  .description('Cancel an active run (never undoes a completed deployment)')
  .option('--actor <name>', 'identity recorded in the audit trail', process.env.USER ?? 'local')
  .action(async (runId: string, o: { actor: string }) => {
    const run = await deps().engine.cancel(runId, o.actor);
    console.log(`${runId}: ${run.status} (${run.stage})`);
  });

program
  .command('export <runId>')
  .requiredOption('--output <dir>', 'destination directory')
  .action(async (runId: string, o: { output: string }) => {
    const written = await exportRun(deps(), runId, resolve(o.output));
    console.log(`Exported to ${resolve(o.output)} (${written.join(', ')})`);
  });

program.parseAsync().catch((e: unknown) => {
  console.error(
    e instanceof CloudEngineerError
      ? `${e.code}: ${e.message}`
      : e instanceof Error
        ? `${e.name}: ${e.message}`
        : e,
  );
  process.exitCode = 1;
});
