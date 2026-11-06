# Changelog

Format: Keep a Changelog; versioning: Semantic Versioning (pre-1.0, minor versions may break).

## [Unreleased]

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
