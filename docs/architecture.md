# Architecture

Source of truth for scope is `CLAUDE.md`. This page describes what is **implemented**; the target
serverless control plane is described under "Target".

## Implemented (local)

| Package      | Responsibility                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `contracts`  | zod schemas: Run, ApplicationBlueprint, ArtifactRef, Approval, AuditEvent, CloudSystemManifest |
| `workflow`   | Stage transition rules, `RunStore` port, file/in-memory stores, `WorkflowEngine`               |
| `planning`   | `ModelProvider` port, prompt → validated Blueprint with a 3-attempt cap                        |
| `providers`  | Amazon Bedrock Converse adapter                                                                |
| `generation` | Deterministic template renderer; entities embedded as JSON data, never as code                 |
| `validation` | Command allowlist, sandboxed runner, template review, bounded repair loop                      |
| `deployment` | Deployment plan + hash, approval-checked deployer, API smoke verification                      |
| `handoff`    | Manifest builder, secret scan, JSON Schema, source export                                      |
| `apps/cli`   | Pipeline orchestration and commands                                                            |

Ports (`RunStore`, `ModelProvider`, `DeployDeps`) keep AWS adapters swappable and tests offline.

## Data flow

Large artifacts (prompt, blueprint, plan, reports, manifest) are files under `runs/<id>/artifacts`,
referenced from the run by URI + SHA-256. The run record holds only metadata.

## Failure and idempotency

- Writes are atomic (temp file + rename); `put` supports compare-and-set on `updatedAt`.
- `attachArtifact` ignores replays of the same (kind, hash). A second `approve` is rejected
  because the run is no longer `AWAITING_APPROVAL`.
- Planning, repair and gate execution are bounded (3 plan attempts, 2 repairs, 5-minute step timeout).
- Any stage failure marks the run `FAILED` and keeps the stage for diagnosis.

## Partially built (offline-tested only)

`providers` contains `DynamoRunStore` (single table + `byCreatedAt` GSI, conditional writes) and
`S3ArtifactStore` (KMS, SHA-256 checked reads). `infra/` defines the matching table, bucket, event bus and a
CodeBuild gate project. `CodeBuildGateRunner` (providers) uploads a run's source to `build-input/<runId>/`,
starts a build with per-run source and artifact locations, waits within a time budget (stopping the build on
timeout) and downloads `cdk.out`. The CLI uses it only when `CLOUD_ENGINEER_BUILD_PROJECT` and
`CLOUD_ENGINEER_BUCKET` are set. None of it has run against AWS; the CodeBuild API behavior (per-run overrides,
artifact layout) is unverified.

## Target (not built)

API Gateway + Lambda → Step Functions Standard → Bedrock / ephemeral CodeBuild / deployment worker,
with DynamoDB for run metadata, S3 for artifacts and EventBridge for events (CLAUDE.md §4). The
ports above are where those adapters attach.

## Decisions

- **TypeScript 6.0.3**, not 7: typescript-eslint 8.72 supports `<6.1.0`. Revisit when it supports 7.
- **Templates over free-form codegen** for the first template: guarantees a project that compiles,
  tests and synthesizes; the model chooses the design, not arbitrary source text.
- **Deploy `cdk.out`, not the project**: the reviewed assembly is what runs with credentials.
