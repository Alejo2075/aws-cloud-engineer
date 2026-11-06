import { randomUUID } from 'node:crypto';
import { ENTITIES, routeFor, type EntityDef } from './entities.js';

export interface Repo {
  put(pk: string, sk: string, item: Record<string, unknown>): Promise<void>;
  get(pk: string, sk: string): Promise<Record<string, unknown> | undefined>;
  list(pk: string, skPrefix: string): Promise<Record<string, unknown>[]>;
  remove(pk: string, sk: string): Promise<void>;
}

export interface HttpEvent {
  rawPath: string;
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
      const items = await repo.list(pk, `${entity.name}#`);
      return respond(200, { items: items.map(publicItem) });
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
    if (id !== undefined && method === 'DELETE') {
      await repo.remove(pk, `${entity.name}#${id}`);
      return { statusCode: 204, headers: {}, body: '' };
    }
    return respond(405, { message: 'method not allowed' });
  };
}
