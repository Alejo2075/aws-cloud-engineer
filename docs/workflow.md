# Workflow

```text
CREATED → INTAKE → REQUIREMENTS → DESIGN → PLAN → GENERATE → BUILD → TEST
        → SECURITY_REVIEW → DEPLOYMENT_REVIEW → AWAITING_APPROVAL → DEPLOY → VERIFY → HANDOFF → SUCCEEDED
```

Side statuses: `FAILED`, `CANCELLED`, `NEEDS_INPUT` (implemented); `BLOCKED` and `ROLLBACK_REQUIRED` are
defined in the contract but no code path sets them yet.

`NEEDS_INPUT`: while planning, the model may return up to 3 blocking questions (total per run). The
run keeps its stage, `questions.json` is stored, and `respond` appends the answers to `decisions.json`
and continues. Answers are untrusted text, passed to the model only inside `<decisions>` tags. Once
the budget is spent the model is told to use documented defaults; a question after that fails the stage.

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
