import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
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
