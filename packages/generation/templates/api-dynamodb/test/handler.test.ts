import { describe, expect, it } from 'vitest';
import { ENTITIES, routeFor } from '../src/lambda/entities.js';
import { createHandler, type HttpEvent, type Repo } from '../src/lambda/handler.js';

class MemoryRepo implements Repo {
  rows = new Map<string, Record<string, unknown>>();
  async put(pk: string, sk: string, item: Record<string, unknown>) {
    this.rows.set(`${pk}|${sk}`, item);
  }
  async get(pk: string, sk: string) {
    return this.rows.get(`${pk}|${sk}`);
  }
  async list(pk: string, prefix: string, page: { limit: number; afterSk?: string }) {
    const rows = [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${pk}|${prefix}`))
      .map(([k, v]) => [k.slice(pk.length + 1), v] as const)
      .sort(([a], [b]) => a.localeCompare(b))
      .filter(([sk]) => page.afterSk === undefined || sk > page.afterSk);
    const slice = rows.slice(0, page.limit);
    const last = slice.at(-1);
    return {
      items: slice.map(([, v]) => v),
      ...(rows.length > page.limit && last ? { lastSk: last[0] } : {}),
    };
  }
  async remove(pk: string, sk: string) {
    this.rows.delete(`${pk}|${sk}`);
  }
}

const entity = ENTITIES[0]!;
const base = `/${routeFor(entity)}`;
const validBody = Object.fromEntries(
  entity.fields.map((f) => [f.name, f.type === 'number' ? 1 : f.type === 'boolean' ? true : 'x']),
);
const ev = (
  method: string,
  path: string,
  sub: string | undefined,
  body?: unknown,
  query?: Record<string, string>,
): HttpEvent => ({
  rawPath: path,
  queryStringParameters: query ?? null,
  body: body === undefined ? null : JSON.stringify(body),
  requestContext: {
    http: { method },
    ...(sub ? { authorizer: { jwt: { claims: { sub } } } } : {}),
  },
});

describe('generated API handler', () => {
  it('rejects requests without a verified identity', async () => {
    const h = createHandler(new MemoryRepo());
    expect((await h(ev('GET', base, undefined))).statusCode).toBe(401);
  });

  it('creates, reads, lists and deletes an item', async () => {
    const h = createHandler(new MemoryRepo());
    const created = await h(ev('POST', base, 'u1', validBody));
    expect(created.statusCode).toBe(201);
    const item = JSON.parse(created.body);
    expect(item.pk).toBeUndefined();
    expect((await h(ev('GET', `${base}/${item.id}`, 'u1'))).statusCode).toBe(200);
    expect(JSON.parse((await h(ev('GET', base, 'u1'))).body).items).toHaveLength(1);
    expect((await h(ev('DELETE', `${base}/${item.id}`, 'u1'))).statusCode).toBe(204);
    expect((await h(ev('GET', `${base}/${item.id}`, 'u1'))).statusCode).toBe(404);
  });

  it('isolates data between users', async () => {
    const h = createHandler(new MemoryRepo());
    const item = JSON.parse((await h(ev('POST', base, 'u1', validBody))).body);
    expect((await h(ev('GET', `${base}/${item.id}`, 'u2'))).statusCode).toBe(404);
    expect(JSON.parse((await h(ev('GET', base, 'u2'))).body).items).toHaveLength(0);
  });

  it('validates input and drops undeclared fields', async () => {
    const h = createHandler(new MemoryRepo());
    expect((await h(ev('POST', base, 'u1', {}))).statusCode).toBe(400);
    expect((await h(ev('POST', base, 'u1', []))).statusCode).toBe(400);
    const ok = await h(ev('POST', base, 'u1', { ...validBody, pk: 'USER#evil', admin: true }));
    const body = JSON.parse(ok.body);
    expect(body.admin).toBeUndefined();
    expect(body.entity).toBe(entity.name);
  });

  it('returns 404 for unknown routes and malformed ids, 405 for bad methods', async () => {
    const h = createHandler(new MemoryRepo());
    expect((await h(ev('GET', '/nope', 'u1'))).statusCode).toBe(404);
    expect((await h(ev('GET', `${base}/../x`, 'u1'))).statusCode).toBe(404);
    expect((await h(ev('PUT', base, 'u1', validBody))).statusCode).toBe(405);
  });

  it('paginates listings with an opaque cursor and validates its inputs', async () => {
    const h = createHandler(new MemoryRepo());
    for (let i = 0; i < 3; i++) await h(ev('POST', base, 'u1', validBody));
    const first = JSON.parse((await h(ev('GET', base, 'u1', undefined, { limit: '2' }))).body);
    expect(first.items).toHaveLength(2);
    expect(typeof first.nextCursor).toBe('string');
    const second = JSON.parse(
      (await h(ev('GET', base, 'u1', undefined, { limit: '2', cursor: first.nextCursor }))).body,
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const ids = [...first.items, ...second.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(3);

    for (const limit of ['0', '101', 'abc', '1.5']) {
      expect((await h(ev('GET', base, 'u1', undefined, { limit }))).statusCode).toBe(400);
    }
    const foreign = Buffer.from('Other#00000000-0000-0000-0000-000000000000').toString('base64url');
    expect((await h(ev('GET', base, 'u1', undefined, { cursor: foreign }))).statusCode).toBe(400);
  });

  it('replaces an item on PUT, keeping identity and ownership', async () => {
    const repo = new MemoryRepo();
    const h = createHandler(repo);
    const item = JSON.parse((await h(ev('POST', base, 'u1', validBody))).body);
    const changed = { ...validBody, pk: 'USER#evil', id: 'x' };
    const res = await h(ev('PUT', `${base}/${item.id}`, 'u1', changed));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(item.id);
    expect(body.createdAt).toBe(item.createdAt);
    expect(body.updatedAt).toBeDefined();
    expect((await h(ev('PUT', `${base}/${item.id}`, 'u2', validBody))).statusCode).toBe(404);
    expect((await h(ev('PUT', `${base}/${item.id}`, 'u1', {}))).statusCode).toBe(400);
    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await h(ev('PUT', `${base}/${missing}`, 'u1', validBody))).statusCode).toBe(404);
    expect([...repo.rows.keys()].every((k) => k.startsWith('USER#u1|'))).toBe(true);
  });
});
