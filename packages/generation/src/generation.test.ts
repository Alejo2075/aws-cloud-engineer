import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApplicationBlueprint } from '@cloud-engineer/contracts';
import { generateProject, hashFiles, writeProject } from './index.js';

export const blueprint: ApplicationBlueprint = {
  schemaVersion: '1.0.0',
  kind: 'ApplicationBlueprint',
  name: 'booking-app',
  requirements: [{ id: 'R1', type: 'functional', text: 'Create bookings' }],
  entities: [
    {
      name: 'Booking',
      fields: [
        { name: 'guestName', type: 'string', required: true },
        { name: 'partySize', type: 'number', required: true },
        { name: 'vip', type: 'boolean', required: false },
      ],
    },
  ],
  components: [{ id: 'C1', type: 'api', awsService: 'API Gateway', justification: 'HTTP API' }],
  tasks: [{ id: 'T1', title: 'API', satisfies: ['R1'], acceptance: ['works'] }],
  risks: [],
};

describe('generateProject', () => {
  it('is deterministic and substitutes every token', async () => {
    const a = await generateProject(blueprint);
    const b = await generateProject(blueprint);
    expect(hashFiles(a)).toBe(hashFiles(b));
    expect(a.some((f) => /__[A-Z0-9_]+__/.test(f.content))).toBe(false);
    const pkg = JSON.parse(a.find((f) => f.path === 'package.json')!.content);
    expect(pkg.name).toBe('booking-app');
    expect(a.map((f) => f.path)).toContain('lib/stack.ts');
  });

  it('embeds entities as data, not code', async () => {
    const files = await generateProject(blueprint);
    expect(files.find((f) => f.path === 'src/lambda/entities.ts')!.content).toContain(
      '"guestName"',
    );
  });

  it('rejects reserved fields and route collisions', async () => {
    const reserved = structuredClone(blueprint);
    reserved.entities[0]!.fields[0]!.name = 'pk';
    await expect(generateProject(reserved)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const dup = structuredClone(blueprint);
    dup.entities.push(structuredClone(dup.entities[0]!));
    await expect(generateProject(dup)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to write outside the project directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ce-gen-'));
    try {
      await expect(writeProject([{ path: '../escape.txt', content: 'x' }], dir)).rejects.toThrow(
        /escapes/,
      );
      await writeProject([{ path: 'a/b.txt', content: 'ok' }], dir);
      expect(await readFile(join(dir, 'a/b.txt'), 'utf8')).toBe('ok');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
