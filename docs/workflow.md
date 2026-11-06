# Workflow

```text
CREATED → INTAKE → REQUIREMENTS → DESIGN → PLAN → GENERATE → BUILD → TEST
        → SECURITY_REVIEW → DEPLOYMENT_REVIEW → AWAITING_APPROVAL → DEPLOY → VERIFY → HANDOFF → SUCCEEDED
```

Side statuses: `FAILED`, `CANCELLED` (implemented); `NEEDS_INPUT`, `BLOCKED`, `ROLLBACK_REQUIRED` are
defined in the contract but no code path sets them yet.

Allowed non-linear moves: `BUILD|TEST → GENERATE` (repair), `AWAITING_APPROVAL → PLAN` (revise).
`DEPLOY` is reachable only through `WorkflowEngine.approve`.

| Stage             | What happens                                                 | Artifact                    |
| ----------------- | ------------------------------------------------------------ | --------------------------- |
| INTAKE            | Prompt persisted                                             | `prompt`                    |
| REQUIREMENTS      | Blueprint planned or supplied; traceability checked          | `requirements`              |
| DESIGN/PLAN       | Blueprint persisted                                          | `blueprint`                 |
| GENERATE          | Project rendered from templates                              | `source` (content hash)     |
| BUILD/TEST        | install, typecheck, tests, `cdk synth`                       | `test-report`               |
| SECURITY_REVIEW   | Synthesized template reviewed                                | `log` (findings)            |
| DEPLOYMENT_REVIEW | Plan + hash                                                  | `plan` (sha256 = plan hash) |
| DEPLOY/VERIFY     | Deploy approved assembly; unauthenticated calls must get 401 | `test-report`               |
| HANDOFF           | Manifest built with `verifiedAt` only after VERIFY           | `manifest`                  |

Audit trail: `runs/<id>/events.jsonl` (RunCreated, StageChanged, ArtifactAttached, DeploymentApproved, RunFailed, RunCancelled).
