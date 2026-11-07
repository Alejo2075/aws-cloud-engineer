# Changelog

Format: Keep a Changelog; versioning: Semantic Versioning (pre-1.0, minor versions may break).

## [Unreleased]

## [0.5.0] - 2026-11-07

### Removed

- All frontend support: the generated static web page (`frontend/`), its private S3 bucket and CloudFront distribution, the CORS configuration, the `public-website` approval gate, `verifySite` and its pipeline check, and the `frontend` component type in blueprints. Generated apps are API only (Cognito-protected HTTP API + Lambda + DynamoDB). The example was regenerated. Existing blueprints that declare a `frontend` component no longer validate.

## [0.4.0] - 2026-11-07

### Added

- Domain events (`RunCreated`, `BlueprintPublished`, `BuildCompleted`, `TestsFailed`, `DeploymentApprovalRequested`, `DeploymentCompleted`, `VerificationFailed`, `SystemHandoffPublished`): derived from the audit trail, validated by a published JSON Schema (`docs/integration/domain-event.schema.json`), and published best-effort through an `EventPublisher` port (failures never affect a run). `EventBridgePublisher` and wiring into the control-plane functions (`EVENT_BUS_NAME`, `events:PutEvents` on the Cloud Engineer bus only). Verified with fakes and synth; nothing was published to a real bus. `RequirementsApproved` is not emitted because no requirements-approval step exists.

- `CodeBuildDeployer` and opt-in per-account `Deployer` CodeBuild projects and roles in `ControlPlaneApiStack` (`-c deployAccounts=...`): uploads the approved assembly (all files), assumes `CloudEngineerDeploy` of that one account inside the build, drops the build role's credentials, verifies the account with `sts:GetCallerIdentity`, and runs the pinned CDK CLI installed outside the assembly with `--ignore-scripts`; outputs are read back from S3. `DeployDeps` gains an optional expected account and deploy context. Verified with fakes and synth only; never run against AWS. Without the option the control plane still refuses to deploy.

- The deployer upload now refuses tooling files (`.npmrc`, `cdk.json`, `cdk.context.json`, `package.json`, `node_modules`) at the assembly root, leaves unknown root entries out, and the build removes `.npmrc`/`cdk.json` from the source directory before deploying.

## [0.3.0] - 2026-11-07

### Added

- Control-plane entrypoints (`apps/control-plane`: worker and HTTP API Lambdas), `createApi` (create/list/status/approve/respond/cancel; IAM-authenticated, strict input validation, approvals bound to plan hash + environment), `SfnWorkflowStarter` (one execution per run id, idempotent start) and `ControlPlaneApiStack` (workflow + worker + HTTP API with scoped IAM; opt-in in `infra/src/app.ts`). Verified by synth and assertions only. **The control-plane worker cannot deploy applications: its deployer refuses until a scoped CodeBuild deployer exists.**
- `S3WorkspaceStore`: persists a run's generated project and planned `cdk.out` to `runs/<id>/workspace/workspace.zip` and restores it (replacing the directory) so stateless workers can share them. Extraction rejects path traversal, corrupt entries, unsupported methods and oversized archives. Offline-tested with a fake S3 client.
- Worker and approval/answers logic for the run workflow (`packages/pipeline`: `createWorker`, `submitApproval`, `submitAnswers`) plus `DynamoTokenStore` and `SfnTaskCallbacks`. The pipeline now lives in `packages/pipeline` (moved out of `apps/cli`). Approval delivery re-checks the plan hash and environment before the task token is consumed and keeps the token if delivery fails. Offline-tested with fakes; **no Lambda entrypoints, bundling or API exist yet, and the workspace (generated source + cdk.out) is not yet carried between invocations.**
- `RunWorkflow` CDK construct (`infra/src/workflow.ts`): Standard Step Functions workflow with task-token waits for answers and approval (7-day bound), explicit failure/cancel paths, and no automatic retry of `deploy`/`verify`. Takes a worker Lambda by contract; **the worker and the approval API are not implemented**, and the construct is not part of the deployed control-plane stack yet. Verified by synth and structural assertions only.
- Opt-in S3 artifact storage in the pipeline (`CLOUD_ENGINEER_BUCKET`): artifacts are written to and read back from the store with hash verification; the stored plan is re-hashed against the hash approval binds to. Local files remain the default. Offline-tested with a fake S3 client.
- `CodeBuildGateRunner`: runs the quality gates in the `infra/` CodeBuild project (per-run source upload, bounded wait, `cdk.out` download with path-escape and size checks). Opt-in via `CLOUD_ENGINEER_BUILD_PROJECT` + `CLOUD_ENGINEER_BUCKET`. The build role may now write `build-output/*` (never `runs/*`). Offline-tested with fakes; not verified against live CodeBuild.
- `export --push <url>` pushes the exported repository as `main` to an https/ssh/file remote using your own git credentials. URLs with embedded credentials are rejected, nothing is force-pushed, and a diverged remote makes the export fail. Tested against a local bare repository only (no GitHub).
- `NEEDS_INPUT` flow: the planner may ask up to 3 blocking questions in total; the run pauses at its stage, `respond` records the answers as a persisted `decisions.json` and continues. After the budget the model must use documented defaults. Cancel works while waiting.
- `export --git` initializes a local git repository with one commit (ignores user git config and hooks; refuses an existing repository). No remote push.
- Generated APIs support `PUT /<name>s/{id}` (replaces declared fields, keeps `id`/`createdAt`, sets `updatedAt`; 404 for other users' items).
- Generated list endpoints are paginated (`?limit=1..100`, default 50; opaque `nextCursor`, validated to stay inside the entity's key range). The generated frontend follows cursors (bounded to 20 pages).

## [0.2.0] - 2026-11-06

### Added

- `DynamoRunStore` and `S3ArtifactStore` adapters (offline-tested with fakes; not wired into the CLI).
- `infra/` CDK stack for the control-plane data layer and a CodeBuild gate project (synth/assertions only).
- CLI `cancel` and `resume` (retry from the failed stage; refused after approval). Optional DynamoDB run store via `CLOUD_ENGINEER_TABLE`.
- Generated apps include a static frontend (private S3 + CloudFront OAC, CSP/HSTS headers, CORS limited to the site origin, Cognito sign-in); deployment `verifySite` checks it.
- Pipeline refactored into resumable, idempotent stages.

## [0.1.0] - 2026-11-06

### Added

- Workspace, strict TypeScript, zod contracts, run state machine with plan-hash-bound approval.
- File-backed durable run store with audit trail.
- Bedrock planning adapter with bounded retries; client-supplied blueprints.
- Deterministic generator for an API Gateway + Lambda + DynamoDB + Cognito CDK project.
- Sandboxed, allowlisted quality gates; template security review; bounded repair loop.
- Deployment planning, assembly-hash-checked deployer, API smoke verification.
- Cloud System Manifest builder, JSON Schema, export; CLI `create/status/runs/approve/export`.

### Known limitations

See README.
