import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { ArtifactRef } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { DocClient } from './dynamo-store.js';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Versioned-bucket artifact store. Keys are fixed to runs/<runId>/artifacts/<name>. */
export class S3ArtifactStore {
  constructor(
    private readonly client: DocClient,
    private readonly bucket: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(runId: string, name: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(runId) || !SAFE.test(name) || name.includes('..')) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid artifact location');
    }
    return `runs/${runId}/artifacts/${name}`;
  }

  async put(
    runId: string,
    kind: ArtifactRef['kind'],
    name: string,
    content: string,
  ): Promise<ArtifactRef> {
    const key = this.key(runId, name);
    const sha256 = createHash('sha256').update(content).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: 'application/json',
        ServerSideEncryption: 'aws:kms',
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        Metadata: { sha256 },
      }),
    );
    return { kind, uri: `s3://${this.bucket}/${key}`, sha256, createdAt: this.now().toISOString() };
  }

  /** Reads an artifact and refuses content whose hash differs from the reference. */
  async get(ref: ArtifactRef): Promise<string> {
    const prefix = `s3://${this.bucket}/`;
    if (!ref.uri.startsWith(prefix)) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Artifact is not in this bucket');
    }
    const key = ref.uri.slice(prefix.length);
    if (!key.startsWith('runs/') || key.includes('..')) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid artifact key');
    }
    const res = (await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    )) as {
      Body?: { transformToString(): Promise<string> };
    };
    const text = (await res.Body?.transformToString()) ?? '';
    if (createHash('sha256').update(text).digest('hex') !== ref.sha256) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Artifact hash mismatch');
    }
    return text;
  }
}
