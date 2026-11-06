# Progress

Last updated: 2026-11-06. Scope: `CLAUDE.md`.

## Release readiness: 0.1.0 pre-release (local pipeline)

Verified by `pnpm typecheck && pnpm lint && pnpm format && pnpm test` (64 tests) and by running the
generated example's own `typecheck`, `test` (9) and `cdk synth`.

### Done

M0 complete. M1 implemented and tested offline: planning, generation, gates, review, repair,
deployment planning/approval/deploy/verify, handoff, CLI.

### After 0.1.0 (branch feat/m2-adapters)

DynamoRunStore, S3ArtifactStore, `infra/` control-plane stack (synth + assertions), CLI `cancel`. 74 tests. Still no AWS call of any kind.

### Frontend (branch feat/frontend)

Generated apps now include a static frontend on private S3 + CloudFront; 84 repo tests; generated project: 12 tests + synth. Still no AWS call of any kind.

### Not verified / not built

- No live AWS validation of any kind (no deploy, no CloudFormation/STS calls from tests).
- Bedrock: adapter reached the service; the author's account had no usable model (403 / daily token throttle). Planning is tested with fixtures only.
- M2+: control plane, CodeBuild isolation, frontend, resume/cancel CLI.

### Notes

- TypeScript pinned to 6.0.3 (typescript-eslint 8.72.1 supports `<6.1.0`).
- License Apache-2.0 chosen by the agent as a default; the owner may change it before release.
- Security review findings (deploy via `npx` with ambient env; HOME exposure in sandbox) were fixed in-repo.
