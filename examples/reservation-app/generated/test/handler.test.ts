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
  async list(pk: string, prefix: string) {
    return [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${pk}|${prefix}`))
      .map(([, v]) => v);
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
const ev = (method: string, path: string, sub: string | undefined, body?: unknown): HttpEvent => ({
  rawPath: path,
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
});
