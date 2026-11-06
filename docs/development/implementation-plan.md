# Implementation plan

Each milestone lists goal, deliverables, validation and definition of done. Checked items are verified by tests in this repo.

## M0 — Foundation

- [x] pnpm workspace, strict TS, ESLint, Prettier, Vitest, CI workflow
- [x] Contracts: Run, Blueprint, ArtifactRef, Approval, AuditEvent, Manifest, error codes
- [x] State machine + durable file store + audit trail
- [x] CLI create/status/runs/approve/export
- [x] README, architecture, security model, workflow, LICENSE, community files

Validation: `pnpm typecheck && pnpm lint && pnpm format && pnpm test`.

## M1 — First vertical slice

- [x] Planning with Bedrock adapter and validation/feedback loop (fixture-tested)
- [x] Deterministic generator; generated project typechecks, tests (9) and synthesizes (verified manually and in CI job)
- [x] Gates, template review, bounded repair (unit-tested)
- [x] Plan hash, assembly hash, approval-checked deployer, verification, manifest, export
- [ ] **Live**: Bedrock-planned run completes (blocked: no usable model/quota in author's account)
- [ ] **Live**: deploy + verify in an isolated sandbox account with a budget (needs owner authorization)

## M2 — Durable engineering (not started)

Step Functions Standard workflow around the existing stage functions; Lambda workers; CodeBuild for
gates; DynamoDB `RunStore`; S3 artifact store; EventBridge events; pause/resume/cancel; frontend.

## Definition of done (per feature)

Typed interface, tests including refusal paths, documented failure/idempotency, reviewed IAM/cost, docs match behavior.
