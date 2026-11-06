# Cloud Engineer

Open-source engine that turns a natural-language request into a reviewed, tested AWS application
(API Gateway + Lambda + DynamoDB + Cognito, defined with AWS CDK), and stops at an explicit,
hash-bound approval gate before anything is deployed.

> **Status: `0.1.0` pre-release (M0 + local M1 slice).** The local, single-machine pipeline works and is
> tested. The cloud control plane (Step Functions, CodeBuild workers, DynamoDB/S3 persistence), frontend
> generation, and a real end-to-end deployment have **not** been built or verified yet. See
> [Known limitations](#known-limitations).

## What works today

```text
prompt ──► Blueprint (Bedrock or your own JSON, schema + traceability validated)
       ──► generated TypeScript CDK project (deterministic templates)
       ──► npm install · typecheck · unit tests · cdk synth   (sandboxed, allowlisted commands)
       ──► template security review (public routes, IAM wildcards, S3, fixed-cost resources)
       ──► deployment plan with an immutable SHA-256  ──►  AWAITING_APPROVAL
approve <run> --plan-hash <hash> ──► deploy (pinned CDK CLI, verified assembly) ──► smoke test
       ──► Cloud System Manifest ──► export
```

- Durable local runs (`runs/<id>/run.json` + append-only `events.jsonl`); restart-safe.
- Approval is bound to the exact plan hash, environment, run and AWS account.
- `deployed` and `verified` are reported separately; `SUCCEEDED` requires verification.
- Generated app: per-user data isolation, JWT-protected routes, on-demand DynamoDB with PITR, throttled stage.

## Requirements

Node.js ≥ 22, pnpm 9. To run the model-driven planner you also need Amazon Bedrock access to a model
in your account. To deploy you need AWS credentials and a CDK-bootstrapped account.

## Install and test

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format && pnpm test
```

## Quick start (no AWS calls)

Supply your own blueprint; nothing contacts AWS until you run `approve`.

```bash
pnpm build
node apps/cli/dist/index.js create "restaurant booking API" \
  --account 123456789012 --blueprint examples/reservation-app/blueprint.json
```

This runs the real gates (install, typecheck, tests, `cdk synth`) and prints the deployment plan.

With Bedrock planning instead of `--blueprint`:

```bash
export CLOUD_ENGINEER_MODEL_ID=<bedrock model or inference profile id>
node apps/cli/dist/index.js create "Build a booking app" --account 123456789012 --region us-east-1
```

## CLI

| Command                                                | Purpose                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `create <prompt> --account <id> [--blueprint f]`       | Plan → generate → build/test → plan; stops for approval |
| `status <runId>` · `runs list` · `runs artifacts <id>` | Inspect persisted state                                 |
| `approve <runId> --plan-hash <h> --environment <e>`    | Approve that exact plan **and deploy it**               |
| `export <runId> --output <dir>`                        | Source + `cloud-system-manifest.json`                   |

`resume` and `cancel` exist in the engine API but are not CLI commands yet.

## Layout

`packages/` — `contracts` (zod schemas), `workflow` (state machine, stores), `planning`, `generation`
(templates), `validation` (gates, review, repair), `deployment`, `handoff`, `providers` (Bedrock),
`shared`. `apps/cli` — pipeline and commands. `docs/` — architecture, security model, workflow,
manifest JSON Schema. `examples/reservation-app` — blueprint and its generated project (kept in sync by a test).

## Known limitations

- **Never verified against live AWS.** Deploy, STS and CloudFormation code paths are covered by
  unit/pipeline tests with injected fakes only. The Bedrock adapter reached the service once but the
  author's account had no usable model, so a model-planned run has not completed.
- No Step Functions / CodeBuild / DynamoDB / S3 control plane: gates run on the local machine with an
  environment sandbox (empty `HOME`, no AWS credentials), not a container or microVM boundary.
- No frontend, no `resume`/`cancel` CLI commands, one template (API + DynamoDB + Cognito).
- Repair loop is implemented and unit-tested but unproven against real model output.

## Documentation

[Architecture](docs/architecture.md) · [Security model](docs/security-model.md) · [Workflow](docs/workflow.md) ·
[Manifest schema](docs/integration/cloud-system-manifest.schema.json) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

## License

Apache-2.0 — see [LICENSE](LICENSE).
