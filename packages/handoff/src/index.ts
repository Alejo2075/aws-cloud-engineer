import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { CloudSystemManifestSchema, type CloudSystemManifest } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';

export const MANIFEST_SCHEMA_VERSION = '1.0.0';

export function manifestJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://github.com/Alejo2075/aws-cloud-engineer/docs/integration/cloud-system-manifest.schema.json',
    title: 'CloudSystemManifest',
    ...z.toJSONSchema(CloudSystemManifestSchema),
  };
}

const SECRET_SHAPES = [
  /AKIA[0-9A-Z]{16}/,
  /ASIA[0-9A-Z]{16}/,
  /aws_secret_access_key/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
];

export function assertNoSecrets(text: string): void {
  for (const re of SECRET_SHAPES) {
    if (re.test(text))
      throw new CloudEngineerError('VALIDATION_FAILED', `Secret-like value matched ${re}`);
  }
}

export interface ManifestInput {
  systemId: string;
  name: string;
  repositoryUrl?: string;
  revision?: string;
  environment: string;
  accountId: string;
  region: string;
  stackName: string;
  resources: { logicalId: string; type: string }[];
  artifactRef?: string;
  /** Only set once post-deployment verification has actually passed. */
  verifiedAt?: string;
}

/** Builds and validates the handoff manifest. Contains references only, never credentials. */
export function buildManifest(i: ManifestInput): CloudSystemManifest {
  const manifest = CloudSystemManifestSchema.parse({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: 'CloudSystemManifest',
    system: { id: i.systemId, name: i.name },
    source: {
      ...(i.repositoryUrl ? { repositoryUrl: i.repositoryUrl } : {}),
      ...(i.revision ? { revision: i.revision } : {}),
    },
    environments: [
      {
        name: i.environment,
        provider: 'aws',
        accountId: i.accountId,
        region: i.region,
        stacks: [i.stackName],
        resources: i.resources,
      },
    ],
    deployment: {
      iac: 'aws-cdk',
      ...(i.artifactRef ? { artifactRef: i.artifactRef } : {}),
      ...(i.verifiedAt ? { verifiedAt: i.verifiedAt } : {}),
    },
  });
  assertNoSecrets(JSON.stringify(manifest));
  return manifest;
}

/** Resources worth listing in the manifest: skips CDK metadata and IAM plumbing noise. */
export function manifestResources(template: {
  Resources?: Record<string, { Type: string }>;
}): { logicalId: string; type: string }[] {
  return Object.entries(template.Resources ?? {})
    .filter(([, r]) => !r.Type.startsWith('Custom::') && r.Type !== 'AWS::CDK::Metadata')
    .map(([logicalId, r]) => ({ logicalId, type: r.Type }))
    .sort((a, b) => a.logicalId.localeCompare(b.logicalId));
}

const EXCLUDED = new Set(['node_modules', 'cdk.out', 'dist', 'cdk-outputs.json', '.env']);

/** Copies the generated source (without build output or dependencies) and writes the manifest. */
export async function exportProject(
  projectDir: string,
  outDir: string,
  manifest?: CloudSystemManifest,
): Promise<string[]> {
  const src = resolve(projectDir);
  const dest = resolve(outDir);
  await mkdir(dest, { recursive: true });
  await cp(src, dest, {
    recursive: true,
    filter: (p) => !p.split('/').some((seg) => EXCLUDED.has(seg)),
  });
  const written = ['source'];
  if (manifest) {
    const path = join(dest, 'cloud-system-manifest.json');
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
    written.push(path);
  }
  return written;
}
