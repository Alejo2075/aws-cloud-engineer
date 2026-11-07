import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

export interface RunWorkflowProps {
  /**
   * Worker invoked as { action, runId, taskToken? } and returning { status } where status is one of
   * AWAITING_APPROVAL | NEEDS_INPUT | SUCCEEDED | FAILED. The worker is NOT implemented in this
   * repository yet: this construct fixes the contract and the durable control flow around it.
   */
  worker: lambda.IFunction;
  /** How long a run may wait for a human (approval or answers) before the execution fails. */
  humanWait?: cdk.Duration;
}

/**
 * Standard workflow for one run: advance -> (wait for answers | wait for approval) -> deploy -> verify.
 * Replay safety: only the read-only/idempotent `advance` action is retried, and only on Lambda
 * service errors; `deploy` is never retried automatically (a deployment must not be replayed), and
 * every failure ends in an explicit `markFailed` so the run record matches the execution.
 */
export class RunWorkflow extends Construct {
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: RunWorkflowProps) {
    super(scope, id);
    const humanWait = props.humanWait ?? cdk.Duration.days(7);

    const invoke = (name: string, action: string, extra: Record<string, unknown> = {}) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: props.worker,
        payload: sfn.TaskInput.fromObject({
          action,
          'runId.$': '$.runId',
          ...extra,
        }),
        payloadResponseOnly: true,
        // Retries are declared explicitly below; the default would also retry Deploy.
        retryOnServiceExceptions: false,
        resultPath: '$.result',
        taskTimeout: sfn.Timeout.duration(cdk.Duration.minutes(15)),
      });

    const waitFor = (name: string, action: string) =>
      new tasks.LambdaInvoke(this, name, {
        lambdaFunction: props.worker,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({
          action,
          'runId.$': '$.runId',
          taskToken: sfn.JsonPath.taskToken,
        }),
        resultPath: '$.decision',
        taskTimeout: sfn.Timeout.duration(humanWait),
      });

    const failed = new sfn.Fail(this, 'RunFailed', { error: 'RunFailed' });
    const cancelled = new sfn.Fail(this, 'RunCancelled', { error: 'RunCancelled' });
    const succeeded = new sfn.Succeed(this, 'RunSucceeded');

    const markFailed = invoke('MarkFailed', 'markFailed', {
      'error.$': '$.error',
    }).next(failed);

    const advance = invoke('Advance', 'advance');
    advance.addRetry({
      errors: [
        'Lambda.ServiceException',
        'Lambda.TooManyRequestsException',
        'Lambda.AWSLambdaException',
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });

    const waitInput = waitFor('WaitForInput', 'registerInputWait');
    const waitApproval = waitFor('WaitForApproval', 'registerApprovalWait');
    const deploy = invoke('Deploy', 'deploy');
    const verify = invoke('Verify', 'verify');

    for (const state of [advance, waitInput, waitApproval, deploy, verify]) {
      state.addCatch(markFailed, { resultPath: '$.error' });
    }

    const approvalGate = new sfn.Choice(this, 'Approved?')
      .when(sfn.Condition.booleanEquals('$.decision.approved', true), deploy)
      .otherwise(cancelled);

    const outcome = new sfn.Choice(this, 'Outcome')
      .when(sfn.Condition.stringEquals('$.result.status', 'NEEDS_INPUT'), waitInput)
      .when(sfn.Condition.stringEquals('$.result.status', 'AWAITING_APPROVAL'), waitApproval)
      .when(sfn.Condition.stringEquals('$.result.status', 'SUCCEEDED'), succeeded)
      .otherwise(markFailed);

    advance.next(outcome);
    waitInput.next(advance); // answers are recorded by the worker, then planning continues
    waitApproval.next(approvalGate);
    deploy.next(verify);
    verify.next(succeeded);

    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH });
    this.stateMachine = new sfn.StateMachine(this, 'Machine', {
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromChainable(advance),
      timeout: cdk.Duration.days(14),
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR },
    });
  }
}
