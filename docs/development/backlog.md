# Backlog

1. Live validation: enable a Bedrock model, run a model-planned `create` end to end.
2. Live validation: deploy the example to a sandbox account with a budget alarm; confirm `verify` and teardown plan.
3. Live validation of the DynamoDB run store and `S3ArtifactStore` (both selectable via environment variables; offline-tested only). The generated source and `cdk.out` still live in the local state directory, so a run cannot yet be resumed from another machine.
4. Live validation of `CodeBuildGateRunner` (per-run source/artifact overrides, artifact layout, log retrieval from CloudWatch); per-run IAM scoping.
5. Step Functions Standard definition + approval callback (task token).
6. CLI: `runs approve` alias.
7. Upgrade the frontend to React/Next.js static export; custom domain + WAF; Cognito hosted UI.
8. PATCH (partial update) and conditional writes in the generated API.
9. Cost estimate from the Pricing API instead of qualitative notes.
10. Forge-specific adapters (create the repository via API, PRs); plain `export --git/--push` exists.
