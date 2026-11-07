import { randomUUID } from 'node:crypto';
import { ENTITIES, routeFor, type EntityDef } from './entities.js';

export interface Repo {
  put(pk: string, sk: string, item: Record<string, unknown>): Promise<void>;
  get(pk: string, sk: string): Promise<Record<string, unknown> | undefined>;
  /** One page in sort-key order; `lastSk` is set only when more items may follow. */
  list(
    pk: string,
    skPrefix: string,
    page: { limit: number; afterSk?: string },
  ): Promise<{ items: Record<string, unknown>[]; lastSk?: string }>;
  remove(pk: string, sk: string): Promise<void>;
}

export interface HttpEvent {
  rawPath: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
  requestContext: {
    http: { method: string };
    authorizer?: { jwt?: { claims?: Record<string, string> } };
  };
}
export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

const respond = (statusCode: number, payload: unknown): HttpResult => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
});

/** Returns only declared fields, or a list of validation errors. */
export function validate(
  entity: EntityDef,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const src = input as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of entity.fields) {
    const v = src[f.name];
    if (v === undefined || v === null) {
      if (f.required) errors.push(`${f.name} is required`);
      continue;
    }
    if (typeof v !== f.type || (f.type === 'number' && !Number.isFinite(v))) {
      errors.push(`${f.name} must be a ${f.type}`);
      continue;
    }
    value[f.name] = v;
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

const encodeCursor = (sk: string) => Buffer.from(sk, 'utf8').toString('base64url');
const decodeCursor = (cursor: string) => Buffer.from(cursor, 'base64url').toString('utf8');

const publicItem = (item: Record<string, unknown>) => {
  const { pk: _pk, sk: _sk, ...rest } = item;
  return rest;
};

export function createHandler(repo: Repo, now: () => Date = () => new Date()) {
  return async (event: HttpEvent): Promise<HttpResult> => {
    const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (!sub) return respond(401, { message: 'unauthorized' });

    const [route, id, ...rest] = event.rawPath.split('/').filter(Boolean);
    const entity = ENTITIES.find((e) => routeFor(e) === route);
    if (!entity || rest.length > 0) return respond(404, { message: 'not found' });
    if (id !== undefined && !ID_PATTERN.test(id)) return respond(404, { message: 'not found' });

    const pk = `USER#${sub}`;
    const method = event.requestContext.http.method;

    if (id === undefined && method === 'GET') {
      const query = event.queryStringParameters ?? {};
      const limit = query.limit === undefined ? DEFAULT_PAGE_SIZE : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        return respond(400, { message: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` });
      }
      const prefix = `${entity.name}#`;
      const afterSk = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
      // The cursor is client-controlled: it must stay inside this entity's key range.
      if (afterSk !== undefined && !afterSk.startsWith(prefix)) {
        return respond(400, { message: 'invalid cursor' });
      }
      const page = await repo.list(pk, prefix, { limit, ...(afterSk ? { afterSk } : {}) });
      return respond(200, {
        items: page.items.map(publicItem),
        ...(page.lastSk ? { nextCursor: encodeCursor(page.lastSk) } : {}),
      });
    }
    if (id === undefined && method === 'POST') {
      const raw = event.body ?? '';
      const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) return respond(413, { message: 'body too large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return respond(400, { message: 'invalid JSON' });
      }
      const result = validate(entity, parsed);
      if (!result.ok) return respond(400, { message: 'validation failed', errors: result.errors });
      const newId = randomUUID();
      const item = {
        pk,
        sk: `${entity.name}#${newId}`,
        id: newId,
        entity: entity.name,
        createdAt: now().toISOString(),
        ...result.value,
      };
      await repo.put(pk, item.sk, item);
      return respond(201, publicItem(item));
    }
    if (id !== undefined && method === 'GET') {
      const item = await repo.get(pk, `${entity.name}#${id}`);
      return item ? respond(200, publicItem(item)) : respond(404, { message: 'not found' });
    }
    if (id !== undefined && method === 'PUT') {
      const raw = event.body ?? '';
      const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) return respond(413, { message: 'body too large' });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return respond(400, { message: 'invalid JSON' });
      }
      const result = validate(entity, parsed);
      if (!result.ok) return respond(400, { message: 'validation failed', errors: result.errors });
      const sk = `${entity.name}#${id}`;
      const existing = await repo.get(pk, sk);
      if (!existing) return respond(404, { message: 'not found' });
      const item = {
        pk,
        sk,
        id,
        entity: entity.name,
        createdAt: existing.createdAt,
        updatedAt: now().toISOString(),
        ...result.value,
      };
      await repo.put(pk, sk, item);
      return respond(200, publicItem(item));
    }
    if (id !== undefined && method === 'DELETE') {
      await repo.remove(pk, `${entity.name}#${id}`);
      return { statusCode: 204, headers: {}, body: '' };
    }
    return respond(405, { message: 'method not allowed' });
  };
}
