import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  SFNClient,
  SendTaskSuccessCommand,
  StartExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { DocClient } from './dynamo-store.js';

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
type Kind = 'input' | 'approval';

/**
 * Parks Step Functions task tokens (bearer secrets) in the run table: pk=RUN#<id>, sk=TOKEN#<kind>.
 * `take` deletes with ReturnValues so only one caller can ever obtain a given token.
 */
export class DynamoTokenStore {
  constructor(
    private readonly client: DocClient,
    private readonly table: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(runId: string, kind: Kind) {
    if (!RUN_ID.test(runId)) throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid run id');
    return { pk: `RUN#${runId}`, sk: `TOKEN#${kind}` };
  }

  async save(runId: string, kind: Kind, token: string): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: { ...this.key(runId, kind), token, savedAt: this.now().toISOString() },
      }),
    );
  }

  async take(runId: string, kind: Kind): Promise<string | undefined> {
    const res = (await this.client.send(
      new DeleteCommand({
        TableName: this.table,
        Key: this.key(runId, kind),
        ReturnValues: 'ALL_OLD',
      }),
    )) as { Attributes?: { token?: string } };
    return res.Attributes?.token;
  }

  /** For tests and diagnostics: whether a token is parked, without revealing it. */
  async has(runId: string, kind: Kind): Promise<boolean> {
    const res = (await this.client.send(
      new GetCommand({ TableName: this.table, Key: this.key(runId, kind) }),
    )) as { Item?: unknown };
    return res.Item !== undefined;
  }
}

/** SendTaskSuccess with the caller's own AWS credentials. */
export class SfnTaskCallbacks {
  constructor(private readonly client: DocClient) {}

  async success(token: string, output: Record<string, unknown>): Promise<void> {
    await this.client.send(
      new SendTaskSuccessCommand({ taskToken: token, output: JSON.stringify(output) }),
    );
  }
}

export function createSfnTaskCallbacks(region: string): SfnTaskCallbacks {
  return new SfnTaskCallbacks(new SFNClient({ region }));
}

/**
 * Starts one execution per run, named after the run id: Step Functions treats a repeated start with
 * the same name and input as the same execution, so a retried API call cannot run a run twice.
 */
export class SfnWorkflowStarter {
  constructor(
    private readonly client: DocClient,
    private readonly stateMachineArn: string,
  ) {}

  private executionArn(runId: string): string {
    if (!RUN_ID.test(runId)) throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid run id');
    // arn:aws:states:<region>:<acct>:stateMachine:<name> -> ...:execution:<name>:<runId>
    return this.stateMachineArn.replace(':stateMachine:', ':execution:') + `:${runId}`;
  }

  async start(runId: string): Promise<void> {
    this.executionArn(runId);
    try {
      await this.client.send(
        new StartExecutionCommand({
          stateMachineArn: this.stateMachineArn,
          name: runId,
          input: JSON.stringify({ runId }),
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ExecutionAlreadyExists') throw err;
    }
  }

  async stop(runId: string, cause: string): Promise<void> {
    try {
      await this.client.send(
        new StopExecutionCommand({
          executionArn: this.executionArn(runId),
          error: 'RunCancelled',
          cause: cause.slice(0, 200),
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== 'ExecutionDoesNotExist') throw err;
    }
  }
}

export function createSfnWorkflowStarter(
  region: string,
  stateMachineArn: string,
): SfnWorkflowStarter {
  return new SfnWorkflowStarter(new SFNClient({ region }), stateMachineArn);
}
