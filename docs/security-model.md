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

## Generated application controls

Routes require a Cognito JWT and items are scoped to the token's `sub`. The site bucket is private (served via
CloudFront origin access control, TLS-only); responses carry CSP (`default-src 'self'`, connections limited to
API Gateway and Cognito in the deployment region), HSTS, `X-Content-Type-Options`, frame-deny and no-referrer.
API CORS allows only the site's CloudFront origin. The client writes DOM with `textContent`, never `innerHTML`.
Known exception: the site deployment role needs `cloudfront:CreateInvalidation` on `*` (a CDK requirement).

## Deploy role you must create (control-plane deployments)

In each target account, create the role `CloudEngineerDeploy` yourself. Cloud Engineer never creates it. Trust only the deployer build role and require an external id:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<control-plane-account>:role/<DeployerRole name from the stack>"
      },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "<your external id>" } }
    }
  ]
}
```

Grant it only what the generated stacks need (and `sts:AssumeRole` on the account's CDK bootstrap roles). The account must already be CDK-bootstrapped, which creates resources there and is your decision. Its permissions bound what any approved plan can do. Unverified against a real account.

## Not yet implemented

- Deployment from the control plane is opt-in and unverified: synthesizing with `-c deployAccounts=<ids>` adds one CodeBuild `Deployer` project and role **per listed account**; each role may only `sts:AssumeRole` into `arn:aws:iam::<id>:role/CloudEngineerDeploy` of its own account. Without the option the worker's deployer refuses (BLOCKED). The assembly is hash-checked and approved before upload. In the build, the pinned CDK CLI is installed outside the uploaded assembly with `--ignore-scripts` (so an `.npmrc`, `node_modules` or scripts inside the assembly cannot influence it), the build role's container credentials are unset after `AssumeRole`, and the account is verified with `sts:GetCallerIdentity` before `cdk deploy --app <assembly>` runs. `cdk deploy` on an assembly directory does not execute code from it, and `node_modules` inside asset bundles are legitimate content, so they are not stripped.
- `ControlPlaneApiStack` grants `states:SendTaskSuccess` on `*` (the action has no resource-level permissions) to the API function, and Bedrock access only to the model ARNs given at synth time. API access is IAM-authenticated; there is no per-user authorization beyond who may sign requests.

- The CodeBuild gate role can read only `build-input/*` and write only `build-output/*` in the artifact bucket,
  never `runs/*`. `CodeBuildGateRunner` places one run's source under `build-input/<runId>/`, but the role can read
  every run's prefix there (per-run scoping with a session policy is not implemented). It can also list key names in
  the bucket (CDK adds bucket-level `s3:List*`).

The local sandbox is defense in depth, **not** an isolation boundary: generated code still runs as your
OS user with network access. Production design: ephemeral CodeBuild with a dedicated role, separate
control-plane / artifact / build / deployment roles, short-lived assumed credentials, KMS-encrypted
artifacts and retention policies. Until then, only run `create` on blueprints and prompts you trust.

## Reporting vulnerabilities

See [SECURITY.md](../SECURITY.md).
