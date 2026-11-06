import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationBlueprintSchema, type ApplicationBlueprint } from '@cloud-engineer/contracts';
import { CloudEngineerError } from '@cloud-engineer/shared';

export interface GeneratedFile {
  path: string;
  content: string;
}

/** Pinned versions written into generated projects (verified against the npm registry 2026-11-06). */
export const GENERATED_VERSIONS = {
  V_CDK_LIB: '2.275.0',
  V_CONSTRUCTS: '10.8.1',
  V_CDK_CLI: '2.1148.0',
  V_SDK: '3.1163.0',
  V_TYPES_NODE: '26.6.6',
  V_ESBUILD: '0.28.2',
  V_TSX: '4.23.15',
  V_TS: '6.0.3',
  V_VITEST: '5.1.0',
} as const;

const TEMPLATE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'templates',
  'api-dynamodb',
);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

/** Rejects blueprints whose names would collide or break generated routes. */
export function assertGeneratable(bp: ApplicationBlueprint): void {
  const routes = new Set<string>();
  for (const e of bp.entities) {
    const route = `${e.name.toLowerCase()}s`;
    if (routes.has(route)) {
      throw new CloudEngineerError('VALIDATION_FAILED', `Entity route collision: ${route}`);
    }
    routes.add(route);
    const fields = new Set<string>();
    for (const f of e.fields) {
      if (fields.has(f.name) || ['id', 'pk', 'sk', 'entity', 'createdAt'].includes(f.name)) {
        throw new CloudEngineerError(
          'VALIDATION_FAILED',
          `Reserved or duplicate field ${e.name}.${f.name}`,
        );
      }
      fields.add(f.name);
    }
  }
}

/** Deterministic: the same blueprint always yields byte-identical files. */
export async function generateProject(input: ApplicationBlueprint): Promise<GeneratedFile[]> {
  const bp = ApplicationBlueprintSchema.parse(input);
  assertGeneratable(bp);

  const entityDocs = bp.entities
    .map(
      (e) =>
        `- **${e.name}** (\`/${e.name.toLowerCase()}s\`): ` +
        e.fields
          .map((f) => `\`${f.name}\` (${f.type}${f.required ? ', required' : ''})`)
          .join(', '),
    )
    .join('\n');
  const tokens: Record<string, string> = {
    ...GENERATED_VERSIONS,
    APP_NAME: bp.name,
    ENTITIES_JSON: JSON.stringify(bp.entities, null, 2),
    ENTITY_DOCS: entityDocs,
  };

  const files: GeneratedFile[] = [];
  for (const abs of (await walk(TEMPLATE_DIR)).sort()) {
    let path = relative(TEMPLATE_DIR, abs).split(sep).join('/');
    let content = await readFile(abs, 'utf8');
    if (path.endsWith('.tmpl')) {
      path = path.slice(0, -'.tmpl'.length);
      content = content.replace(/__([A-Z0-9_]+)__/g, (m, key: string) => {
        const v = tokens[key];
        if (v === undefined)
          throw new CloudEngineerError('VALIDATION_FAILED', `Unknown template token ${m}`);
        return v;
      });
    }
    files.push({ path, content });
  }
  files.push({ path: 'blueprint.json', content: JSON.stringify(bp, null, 2) + '\n' });
  return files;
}

export function hashFiles(files: GeneratedFile[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(f.path).update('\0').update(f.content).update('\0');
  }
  return h.digest('hex');
}

/** Writes files under `dir`, refusing any path that would escape it. */
export async function writeProject(files: GeneratedFile[], dir: string): Promise<void> {
  const root = resolve(dir);
  for (const f of files) {
    const target = resolve(root, f.path);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new CloudEngineerError('VALIDATION_FAILED', `Path escapes project root: ${f.path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content);
  }
}
