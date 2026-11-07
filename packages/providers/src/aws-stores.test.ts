/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { WorkflowEngine } from '@cloud-engineer/workflow';
import {
  DynamoRunStore,
  DynamoTokenStore,
  EventBridgePublisher,
  S3ArtifactStore,
  SfnTaskCallbacks,
  SfnWorkflowStarter,
  type DocClient,
} from './index.js';

type Item = Record<string, unknown>;

/** In-memory stand-in for the subset of DynamoDB the store uses. */
class FakeDynamo implements DocClient {
  items = new Map<string, Item>();
  pageSize = 2;
  sent: string[] = [];
  async send(cmd: unknown): Promise<unknown> {
    const c = cmd as { constructor: { name: string }; input: Record<string, any> };
    const name = c.constructor.name;
    this.sent.push(name);
    const i = c.input;
    if (name === 'GetCommand') return { Item: this.items.get(`${i.Key.pk}|${i.Key.sk}`) };
    if (name === 'PutCommand') {
      const k = `${i.Item.pk}|${i.Item.sk}`;
      const cur = this.items.get(k);
      if (
        i.ConditionExpression === 'updatedAt = :e' &&
        cur?.updatedAt !== i.ExpressionAttributeValues[':e']
      ) {
        throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
      }
      if (i.ConditionExpression === 'attribute_not_exists(pk)' && cur) {
        throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
      }
      this.items.set(k, i.Item);
      return {};
    }
    if (name === 'QueryCommand') {
      const all = [...this.items.values()]
        .filter((it) =>
          i.IndexName
            ? it.gsi1pk === i.ExpressionAttributeValues[':p']
            : it.pk === i.ExpressionAttributeValues[':p'] &&
              String(it.sk).startsWith(i.ExpressionAttributeValues[':e']),
        )
        .sort((a, b) =>
          String(i.IndexName ? a.gsi1sk : a.sk).localeCompare(
            String(i.IndexName ? b.gsi1sk : b.sk),
          ),
        );
      const start = i.ExclusiveStartKey ? Number(i.ExclusiveStartKey.n) : 0;
      const page = all.slice(start, start + this.pageSize);
      return {
        Items: page,
        ...(start + this.pageSize < all.length
          ? { LastEvaluatedKey: { n: start + this.pageSize } }
          : {}),
      };
    }
    throw new Error(`unexpected ${name}`);
  }
}

describe('DynamoRunStore', () => {
  it('runs the whole workflow engine on top of it, including paginated list and events', async () => {
    const e = new WorkflowEngine(new DynamoRunStore(new FakeDynamo(), 't'));
    const runs = [];
    for (let n = 0; n < 5; n++)
      runs.push(await e.createRun({ prompt: `p${n}`, region: 'us-east-1' }));
    await e.transition(runs[0]!.runId, 'INTAKE');
    expect(await e.listRuns()).toHaveLength(5);
    expect((await e.getRun(runs[0]!.runId)).stage).toBe('INTAKE');
  });

  it('detects concurrent writers via the conditional put', async () => {
    const store = new DynamoRunStore(new FakeDynamo(), 't');
    const e = new WorkflowEngine(store);
    const run = await e.createRun({ prompt: 'x', region: 'us-east-1' });
    await expect(store.put({ ...run, stage: 'INTAKE' }, 'stale')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('keeps events ordered and never overwrites one', async () => {
    const fake = new FakeDynamo();
    const store = new DynamoRunStore(fake, 't');
    const e = new WorkflowEngine(store);
    const run = await e.createRun({ prompt: 'x', region: 'us-east-1' });
    await e.transition(run.runId, 'INTAKE');
    await e.transition(run.runId, 'REQUIREMENTS');
    const types = (await store.events(run.runId)).map((x) => x.type);
    expect(types).toEqual(['RunCreated', 'StageChanged', 'StageChanged']);
  });

  it('rejects malformed run ids and returns undefined for unknown runs', async () => {
    const store = new DynamoRunStore(new FakeDynamo(), 't');
    await expect(store.get('RUN#x|y')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await store.get('missing')).toBeUndefined();
  });
});

describe('S3ArtifactStore', () => {
  const makeFake = () => {
    const objects = new Map<string, string>();
    const puts: Record<string, any>[] = [];
    const client: DocClient = {
      async send(cmd: unknown) {
        const c = cmd as { constructor: { name: string }; input: Record<string, any> };
        if (c.constructor.name === 'PutObjectCommand') {
          puts.push(c.input);
          objects.set(c.input.Key, c.input.Body);
          return {};
        }
        const body = objects.get(c.input.Key);
        return { Body: { transformToString: async () => body ?? '' } };
      },
    };
    return { client, objects, puts };
  };

  it('stores encrypted, checksummed objects and reads back verified content', async () => {
    const { client, puts } = makeFake();
    const s = new S3ArtifactStore(client, 'bucket');
    const ref = await s.put('run-1', 'plan', 'plan.json', '{"a":1}');
    expect(ref.uri).toBe('s3://bucket/runs/run-1/artifacts/plan.json');
    expect(puts[0]).toMatchObject({ ServerSideEncryption: 'aws:kms' });
    expect(puts[0]!.ChecksumSHA256).toBeTruthy();
    expect(await s.get(ref)).toBe('{"a":1}');
  });

  it('detects tampered content and foreign or traversal references', async () => {
    const { client, objects } = makeFake();
    const s = new S3ArtifactStore(client, 'bucket');
    const ref = await s.put('run-1', 'plan', 'plan.json', 'good');
    objects.set('runs/run-1/artifacts/plan.json', 'evil');
    await expect(s.get(ref)).rejects.toThrow(/hash mismatch/);
    await expect(s.get({ ...ref, uri: 's3://other/runs/x' })).rejects.toThrow(/not in this bucket/);
    await expect(s.get({ ...ref, uri: 's3://bucket/runs/../secret' })).rejects.toThrow(
      /Invalid artifact key/,
    );
    await expect(s.put('../x', 'plan', 'a.json', '')).rejects.toThrow(/Invalid/);
    await expect(s.put('run-1', 'plan', '../a', '')).rejects.toThrow(/Invalid/);
  });
});

describe('DynamoTokenStore and SfnTaskCallbacks', () => {
  it('hands each parked token to exactly one caller', async () => {
    const items = new Map<string, Record<string, unknown>>();
    const client: DocClient = {
      send: async (c: unknown) => {
        const { constructor, input } = c as {
          constructor: { name: string };
          input: { Item?: Record<string, unknown>; Key?: { pk: string; sk: string } };
        };
        const k = input.Item
          ? `${input.Item.pk}|${input.Item.sk}`
          : `${input.Key!.pk}|${input.Key!.sk}`;
        if (constructor.name === 'PutCommand') items.set(k, input.Item!);
        if (constructor.name === 'DeleteCommand') {
          const old = items.get(k);
          items.delete(k);
          return { Attributes: old };
        }
        if (constructor.name === 'GetCommand') return { Item: items.get(k) };
        return {};
      },
    };
    const store = new DynamoTokenStore(client, 'tbl');
    await store.save('run-1', 'approval', 'tok');
    expect(await store.has('run-1', 'approval')).toBe(true);
    expect(await store.take('run-1', 'approval')).toBe('tok');
    expect(await store.take('run-1', 'approval')).toBeUndefined();
    await expect(store.save('../x', 'input', 't')).rejects.toThrow(/Invalid run id/);
  });

  it('sends the decision as the task output', async () => {
    const sent: unknown[] = [];
    const cb = new SfnTaskCallbacks({
      send: async (c) => void sent.push((c as { input: unknown }).input),
    });
    await cb.success('tok', { approved: true });
    expect(sent).toEqual([{ taskToken: 'tok', output: '{"approved":true}' }]);
  });
});

describe('SfnWorkflowStarter', () => {
  const arn = 'arn:aws:states:us-east-1:123456789012:stateMachine:Flow';

  it('names the execution after the run, tolerates a repeated start, and stops by derived ARN', async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    let fail: string | undefined;
    const starter = new SfnWorkflowStarter(
      {
        send: async (c) => {
          const cmd = c as { constructor: { name: string }; input: Record<string, unknown> };
          sent.push({ name: cmd.constructor.name, input: cmd.input });
          if (fail) throw Object.assign(new Error(fail), { name: fail });
          return {};
        },
      },
      arn,
    );
    await starter.start('run-1');
    expect(sent[0]!.input).toMatchObject({ name: 'run-1', input: '{"runId":"run-1"}' });
    fail = 'ExecutionAlreadyExists';
    await expect(starter.start('run-1')).resolves.toBeUndefined();
    fail = undefined;
    await starter.stop('run-1', 'cancelled');
    expect(sent.at(-1)!.input.executionArn).toBe(
      'arn:aws:states:us-east-1:123456789012:execution:Flow:run-1',
    );
    fail = 'AccessDeniedException';
    await expect(starter.start('run-1')).rejects.toThrow();
    await expect(starter.stop('../x', 'c')).rejects.toThrow(/Invalid run id/);
  });
});

describe('EventBridgePublisher', () => {
  const event = {
    schemaVersion: '1.0.0' as const,
    id: 'e1',
    type: 'RunCreated' as const,
    runId: 'run-1',
    correlationId: 'c1',
    at: '2026-11-07T00:00:00.000Z',
    stage: 'CREATED' as const,
  };

  it('puts one entry with the event type as detail type', async () => {
    const sent: unknown[] = [];
    const pub = new EventBridgePublisher(
      { send: async (c) => (sent.push((c as { input: unknown }).input), { FailedEntryCount: 0 }) },
      'bus',
    );
    await pub.publish(event);
    expect(sent).toEqual([
      {
        Entries: [
          {
            EventBusName: 'bus',
            Source: 'cloud-engineer',
            DetailType: 'RunCreated',
            Detail: JSON.stringify(event),
          },
        ],
      },
    ]);
  });

  it('throws when EventBridge reports a failed entry', async () => {
    const pub = new EventBridgePublisher(
      { send: async () => ({ FailedEntryCount: 1, Entries: [{ ErrorMessage: 'denied' }] }) },
      'bus',
    );
    await expect(pub.publish(event)).rejects.toThrow(/denied/);
  });
});
