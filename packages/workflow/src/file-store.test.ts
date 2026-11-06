import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileRunStore, WorkflowEngine } from './index.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function engine() {
  const root = await mkdtemp(join(tmpdir(), 'ce-store-'));
  dirs.push(root);
  return { root, e: new WorkflowEngine(new FileRunStore(root)) };
}

describe('FileRunStore', () => {
  it('survives a restart (new store instance, same directory)', async () => {
    const { root, e } = await engine();
    const run = await e.createRun({ prompt: 'x', region: 'us-east-1' });
    await e.transition(run.runId, 'INTAKE');
    const reopened = new WorkflowEngine(new FileRunStore(root));
    expect((await reopened.getRun(run.runId)).stage).toBe('INTAKE');
    expect(await new FileRunStore(root).events(run.runId)).toHaveLength(2);
  });

  it('rejects path-traversal run ids', async () => {
    const { e } = await engine();
    await expect(e.getRun('../../etc')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('detects concurrent modification', async () => {
    const { root, e } = await engine();
    const store = new FileRunStore(root);
    const run = await e.createRun({ prompt: 'x', region: 'us-east-1' });
    await expect(store.put({ ...run, stage: 'INTAKE' }, 'stale')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('lists runs and returns not found for unknown ids', async () => {
    const { e } = await engine();
    await e.createRun({ prompt: 'a', region: 'us-east-1' });
    await expect(e.getRun('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
