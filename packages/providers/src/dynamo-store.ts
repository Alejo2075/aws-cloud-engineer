import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { AuditEventSchema, RunSchema, type AuditEvent, type Run } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { RunStore } from '@cloud-engineer/workflow';
import { randomUUID } from 'node:crypto';

/** Minimal client surface so tests can inject a fake; a DynamoDBDocumentClient satisfies it. */
export interface DocClient {
  send(command: unknown): Promise<unknown>;
}

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;

const omit = (item: Record<string, unknown>, keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(item).filter(([k]) => !keys.includes(k)));

/**
 * Single-table layout. Run:   pk=RUN#<id>  sk=META  gsi1pk=RUNS  gsi1sk=<createdAt>
 *                     Event: pk=RUN#<id>  sk=EVT#<iso>#<uuid>
 * Table needs a GSI named `byCreatedAt` (gsi1pk, gsi1sk). Items stay small: artifacts are S3 refs.
 */
export class DynamoRunStore implements RunStore {
  /** Orders events written in the same millisecond by this writer. */
  private seq = 0;

  constructor(
    private readonly client: DocClient,
    private readonly table: string,
  ) {}

  private pk(runId: string): string {
    if (!RUN_ID.test(runId)) throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid run id');
    return `RUN#${runId}`;
  }

  async get(runId: string): Promise<Run | undefined> {
    const res = (await this.client.send(
      new GetCommand({ TableName: this.table, Key: { pk: this.pk(runId), sk: 'META' } }),
    )) as { Item?: Record<string, unknown> };
    return res.Item ? this.toRun(res.Item) : undefined;
  }

  async list(): Promise<Run[]> {
    const runs: Run[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const res = (await this.client.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: 'byCreatedAt',
          KeyConditionExpression: 'gsi1pk = :p',
          ExpressionAttributeValues: { ':p': 'RUNS' },
          ExclusiveStartKey: key,
        }),
      )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of res.Items ?? []) runs.push(this.toRun(item));
      key = res.LastEvaluatedKey;
    } while (key);
    return runs;
  }

  /** Conditional write: with `expectedUpdatedAt` only the caller that saw the latest version wins. */
  async put(run: Run, expectedUpdatedAt?: string): Promise<void> {
    const item = {
      ...RunSchema.parse(run),
      pk: this.pk(run.runId),
      sk: 'META',
      gsi1pk: 'RUNS',
      gsi1sk: run.createdAt,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ...(expectedUpdatedAt !== undefined
            ? {
                ConditionExpression: 'updatedAt = :e',
                ExpressionAttributeValues: { ':e': expectedUpdatedAt },
              }
            : {}),
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new CloudEngineerError('CONFLICT', `Run ${run.runId} was modified concurrently`);
      }
      throw err;
    }
  }

  async appendEvent(event: AuditEvent): Promise<void> {
    const e = AuditEventSchema.parse(event);
    await this.client.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          ...e,
          pk: this.pk(e.runId),
          sk: `EVT#${e.at}#${String(this.seq++ % 1_000_000).padStart(6, '0')}#${randomUUID()}`,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  }

  async events(runId: string): Promise<AuditEvent[]> {
    const out: AuditEvent[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const res = (await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :p AND begins_with(sk, :e)',
          ExpressionAttributeValues: { ':p': this.pk(runId), ':e': 'EVT#' },
          ExclusiveStartKey: key,
        }),
      )) as { Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> };
      for (const item of res.Items ?? []) {
        out.push(AuditEventSchema.parse(omit(item, ['pk', 'sk'])));
      }
      key = res.LastEvaluatedKey;
    } while (key);
    return out;
  }

  private toRun(item: Record<string, unknown>): Run {
    return RunSchema.parse(omit(item, ['pk', 'sk', 'gsi1pk', 'gsi1sk']));
  }
}
