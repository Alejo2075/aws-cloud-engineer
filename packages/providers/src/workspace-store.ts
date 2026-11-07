import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudEngineerError } from '@cloud-engineer/shared';
import { zipDirectory } from './codebuild-gates.js';
import type { DocClient } from './dynamo-store.js';

const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/**
 * Extracts a zip written by `zipDirectory` (stored entries only) into `dir`. Entry names are
 * untrusted: anything that would land outside `dir`, any unsupported method, a CRC mismatch or
 * too many/large entries aborts the extraction.
 */
export async function unzipTo(zip: Buffer, dir: string): Promise<void> {
  const root = resolve(dir);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new CloudEngineerError('VALIDATION_FAILED', 'Not a zip archive');
  const count = zip.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new CloudEngineerError('VALIDATION_FAILED', 'Too many entries');
  let p = zip.readUInt32LE(end + 16);
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Corrupt zip directory');
    }
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (method !== 0) throw new CloudEngineerError('VALIDATION_FAILED', 'Unsupported zip method');
    total += size;
    if (total > MAX_ARCHIVE_BYTES)
      throw new CloudEngineerError('VALIDATION_FAILED', 'Archive too large');
    const target = resolve(root, name);
    if (name.endsWith('/') || !target.startsWith(root + sep)) {
      throw new CloudEngineerError('VALIDATION_FAILED', `Unsafe archive entry ${name}`);
    }
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(dataStart, dataStart + size);
    if (crc32(data) !== crc)
      throw new CloudEngineerError('VALIDATION_FAILED', `Corrupt entry ${name}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

/**
 * Carries a run's generated project (including the planned cdk.out) between stateless workers via
 * the artifact bucket: runs/<runId>/workspace/workspace.zip. `restore` replaces the directory
 * contents, so a stale local copy can never be mixed with the stored one. Offline-tested only.
 */
export class S3WorkspaceStore {
  constructor(
    private readonly client: DocClient,
    private readonly bucket: string,
  ) {}

  private key(runId: string) {
    if (!RUN_ID.test(runId)) throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid run id');
    return `runs/${runId}/workspace/workspace.zip`;
  }

  async persist(runId: string, dir: string): Promise<void> {
    const zip = await zipDirectory(dir, { includeBuildOutput: true });
    if (zip.length > MAX_ARCHIVE_BYTES) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Workspace is too large to persist');
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(runId),
        Body: zip,
        ContentType: 'application/zip',
        ServerSideEncryption: 'aws:kms',
      }),
    );
  }

  /** No stored workspace is not an error: the run has not generated anything yet. */
  async restore(runId: string, dir: string): Promise<void> {
    let body: { transformToByteArray(): Promise<Uint8Array> } | undefined;
    try {
      body = (
        (await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: this.key(runId) }),
        )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } }
      ).Body;
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey') return;
      throw err;
    }
    if (!body) return;
    const zip = Buffer.from(await body.transformToByteArray());
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await unzipTo(zip, dir);
  }
}
