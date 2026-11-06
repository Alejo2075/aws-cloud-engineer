import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditEventSchema, RunSchema, type AuditEvent, type Run } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { RunStore } from './index.js';

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Durable local store: runs/<id>/run.json (atomic rename) and an append-only events.jsonl. */
export class FileRunStore implements RunStore {
  constructor(private readonly root: string) {}

  private dir(runId: string): string {
    if (!SAFE_ID.test(runId)) throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid run id');
    return join(this.root, 'runs', runId);
  }

  async get(runId: string): Promise<Run | undefined> {
    try {
      return RunSchema.parse(JSON.parse(await readFile(join(this.dir(runId), 'run.json'), 'utf8')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async list(): Promise<Run[]> {
    let ids: string[];
    try {
      ids = await readdir(join(this.root, 'runs'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const runs = await Promise.all(ids.filter((i) => SAFE_ID.test(i)).map((i) => this.get(i)));
    return runs
      .filter((r): r is Run => r !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async put(run: Run, expectedUpdatedAt?: string): Promise<void> {
    if (expectedUpdatedAt !== undefined) {
      const current = await this.get(run.runId);
      if (current?.updatedAt !== expectedUpdatedAt) {
        throw new CloudEngineerError('CONFLICT', `Run ${run.runId} was modified concurrently`);
      }
    }
    const dir = this.dir(run.runId);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `run.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(RunSchema.parse(run), null, 2));
    await rename(tmp, join(dir, 'run.json'));
  }

  async appendEvent(event: AuditEvent): Promise<void> {
    const dir = this.dir(event.runId);
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, 'events.jsonl'),
      JSON.stringify(AuditEventSchema.parse(event)) + '\n',
    );
  }

  async events(runId: string): Promise<AuditEvent[]> {
    try {
      const text = await readFile(join(this.dir(runId), 'events.jsonl'), 'utf8');
      return text
        .split('\n')
        .filter(Boolean)
        .map((l) => AuditEventSchema.parse(JSON.parse(l)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
