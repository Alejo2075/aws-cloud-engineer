import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  StartBuildCommand,
  StopBuildCommand,
  type Build,
} from '@aws-sdk/client-codebuild';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CloudEngineerError } from '@cloud-engineer/shared';
import type { GateReport } from '@cloud-engineer/validation';
import type { DocClient } from './dynamo-store.js';

const SKIP = new Set(['node_modules', 'cdk.out', 'dist', '.git', 'cdk-outputs.json']);
/** A workspace keeps cdk.out (the assembly that was planned) but never dependencies or VCS data. */
const WORKSPACE_SKIP = new Set(['node_modules', '.git']);
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_OUTPUT_OBJECTS = 2000;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

/** Deterministic, uncompressed zip (fixed timestamps, sorted entries) of a project directory. */
export async function zipDirectory(
  dir: string,
  opts: { includeBuildOutput?: boolean } = {},
): Promise<Buffer> {
  const skip = opts.includeBuildOutput ? WORKSPACE_SKIP : SKIP;
  const root = resolve(dir);
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (skip.has(e.name)) continue;
      if (e.isDirectory()) await walk(join(d, e.name));
      else if (e.isFile()) files.push(join(d, e.name));
    }
  };
  await walk(root);

  const DOS_DATE = (1 << 5) | 1; // 1980-01-01
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(relative(root, file).split(sep).join('/'));
    const data = await readFile(file);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

export interface CodeBuildGateOptions {
  s3: DocClient;
  codebuild: DocClient;
  bucket: string;
  projectName: string;
  pollMs?: number;
  /** Wall-clock cap for one gate run; the build is stopped when it is exceeded. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs the quality gates in the ephemeral CodeBuild project from `infra/` instead of on this
 * machine: uploads the project source to build-input/<runId>/, starts a build with a per-run source
 * and artifact location, waits (bounded), then downloads cdk.out so the plan is made from what the
 * isolated worker synthesized. Offline-tested with fakes only; not verified against live CodeBuild.
 */
export class CodeBuildGateRunner {
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: CodeBuildGateOptions) {
    this.pollMs = o.pollMs ?? 10_000;
    this.timeoutMs = o.timeoutMs ?? 35 * 60_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(dir: string, runId: string): Promise<GateReport> {
    if (!RUN_ID.test(runId)) {
      throw new CloudEngineerError('VALIDATION_FAILED', 'Invalid run id for a build');
    }
    const started = Date.now();
    const zip = await zipDirectory(dir);
    const sourceKey = `build-input/${runId}/source.zip`;
    const outputPath = `build-output/${runId}`;
    await this.o.s3.send(
      new PutObjectCommand({
        Bucket: this.o.bucket,
        Key: sourceKey,
        Body: zip,
        ContentType: 'application/zip',
        ServerSideEncryption: 'aws:kms',
      }),
    );
    const startRes = (await this.o.codebuild.send(
      new StartBuildCommand({
        projectName: this.o.projectName,
        sourceTypeOverride: 'S3',
        sourceLocationOverride: `${this.o.bucket}/${sourceKey}`,
        artifactsOverride: {
          type: 'S3',
          location: this.o.bucket,
          path: outputPath,
          namespaceType: 'NONE',
          packaging: 'NONE',
          name: '/',
          encryptionDisabled: false,
        },
      }),
    )) as { build?: Build };
    const id = startRes.build?.id;
    if (!id) throw new CloudEngineerError('CONFLICT', 'CodeBuild did not return a build id');

    let build: Build | undefined;
    for (;;) {
      const res = (await this.o.codebuild.send(new BatchGetBuildsCommand({ ids: [id] }))) as {
        builds?: Build[];
      };
      build = res.builds?.[0];
      if (build && build.buildStatus !== 'IN_PROGRESS') break;
      if (Date.now() - started > this.timeoutMs) {
        await this.o.codebuild.send(new StopBuildCommand({ id }));
        return this.report(id, build, true, Date.now() - started);
      }
      await this.sleep(this.pollMs);
    }

    const report = this.report(id, build, false, Date.now() - started);
    if (report.passed) await this.fetchOutput(outputPath, dir);
    return report;
  }

  private report(id: string, build: Build | undefined, timedOut: boolean, ms: number): GateReport {
    const status = build?.buildStatus ?? 'UNKNOWN';
    const phases = (build?.phases ?? []).map((p) => ({
      phase: p.phaseType,
      status: p.phaseStatus,
      messages: (p.contexts ?? []).map((c) => c.message).filter(Boolean),
    }));
    const failedPhases = phases.filter((p) => p.status && p.status !== 'SUCCEEDED');
    const step = {
      id: 'codebuild',
      argv: ['codebuild', this.o.projectName, id],
      exitCode: status === 'SUCCEEDED' ? 0 : 1,
      timedOut,
      durationMs: ms,
      // Phase metadata only: full logs stay in CloudWatch Logs and are not fetched here.
      logSha256: createHash('sha256').update(JSON.stringify(phases)).digest('hex'),
      logTail: timedOut
        ? `build exceeded ${this.timeoutMs} ms and was stopped`
        : `status ${status}; ${JSON.stringify(failedPhases).slice(-1500)}`,
    };
    return status === 'SUCCEEDED'
      ? { passed: true, steps: [step] }
      : { passed: false, steps: [step], failed: step };
  }

  /** Downloads <prefix>/cdk.out/** into <dir>/cdk.out, refusing keys that escape the prefix. */
  private async fetchOutput(prefix: string, dir: string): Promise<void> {
    const base = resolve(dir, 'cdk.out');
    const wanted = `${prefix}/cdk.out/`;
    let token: string | undefined;
    let count = 0;
    let bytes = 0;
    do {
      const page = (await this.o.s3.send(
        new ListObjectsV2Command({
          Bucket: this.o.bucket,
          Prefix: wanted,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      )) as {
        Contents?: { Key?: string; Size?: number }[];
        NextContinuationToken?: string;
      };
      for (const obj of page.Contents ?? []) {
        const key = obj.Key;
        if (!key || !key.startsWith(wanted) || key.endsWith('/')) continue;
        const target = resolve(base, key.slice(wanted.length));
        if (target !== base && !target.startsWith(base + sep)) {
          throw new CloudEngineerError('VALIDATION_FAILED', 'Build output escapes cdk.out');
        }
        count += 1;
        bytes += obj.Size ?? 0;
        if (count > MAX_OUTPUT_OBJECTS || bytes > MAX_OUTPUT_BYTES) {
          throw new CloudEngineerError('VALIDATION_FAILED', 'Build output is too large');
        }
        const got = (await this.o.s3.send(
          new GetObjectCommand({ Bucket: this.o.bucket, Key: key }),
        )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
        if (!got.Body) throw new CloudEngineerError('NOT_FOUND', `Missing build output ${key}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await got.Body.transformToByteArray());
      }
      token = page.NextContinuationToken;
    } while (token);
    if (count === 0) {
      throw new CloudEngineerError('NOT_FOUND', 'Build succeeded but produced no cdk.out');
    }
  }
}

/** Builds a runner that uses the caller's own AWS credentials (default provider chain). */
export function createCodeBuildGateRunner(opts: {
  region: string;
  bucket: string;
  projectName: string;
}): CodeBuildGateRunner {
  return new CodeBuildGateRunner({
    s3: new S3Client({ region: opts.region }),
    codebuild: new CodeBuildClient({ region: opts.region }),
    bucket: opts.bucket,
    projectName: opts.projectName,
  });
}
