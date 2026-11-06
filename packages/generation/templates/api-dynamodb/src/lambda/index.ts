import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHandler, type Repo } from './handler.js';

const table = process.env.TABLE_NAME;
if (!table) throw new Error('TABLE_NAME is not set');
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const repo: Repo = {
  async put(_pk, _sk, item) {
    await doc.send(new PutCommand({ TableName: table, Item: item }));
  },
  async get(pk, sk) {
    const res = await doc.send(new GetCommand({ TableName: table, Key: { pk, sk } }));
    return res.Item;
  },
  async list(pk, skPrefix) {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': pk, ':p': skPrefix },
        Limit: 100,
      }),
    );
    return res.Items ?? [];
  },
  async remove(pk, sk) {
    await doc.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
  },
};

export const handler = createHandler(repo);
