# Security model

Threat model: prompts, repositories, generated code and model output are untrusted; deployment
can cost money or affect data.

## Implemented controls

| Risk                                | Control                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Model-authored commands             | Never executed. Gates are fixed in code; `assertAllowed` accepts only `npm ci/install/test/run {typecheck,test,build,synth}`; `shell: false`.  |
| Generated code stealing credentials | Gates run with an empty `HOME`, `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE=/dev/null`, no tokens, no `NODE_OPTIONS`.                       |
| Deploy-time code execution          | Deploys the pre-synthesized `cdk.out` with the CDK CLI pinned in this repo, from a temp dir, minimal env. No `npx`, no project `node_modules`. |
| Tampering between review and deploy | Plan includes SHA-256 of the template and of every assembly file; deploy re-hashes.                                                            |
| Standing or generic approval        | Approval binds run id, plan hash, environment; credentials' account must equal plan account.                                                   |
| Injection through blueprint names   | Strict identifier regexes; entities embedded as JSON data; reserved-name and collision checks.                                                 |
| Path traversal                      | Run ids and written paths validated; repair may only touch `src                                                                                | lib | bin | test` `.ts/.json`. |
| Prompt injection in logs/prompts    | User text and tool logs are delimited as untrusted data in model prompts.                                                                      |
| Secret leakage                      | Log redaction; manifest builder rejects secret-shaped values.                                                                                  |
| Public exposure / IAM / cost        | Template review blocks public routes, wildcard IAM actions, open buckets; flags fixed-cost resources.                                          |

## Not yet implemented

The local sandbox is defense in depth, **not** an isolation boundary: generated code still runs as your
OS user with network access. Production design: ephemeral CodeBuild with a dedicated role, separate
control-plane / artifact / build / deployment roles, short-lived assumed credentials, KMS-encrypted
artifacts and retention policies. Until then, only run `create` on blueprints and prompts you trust.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
