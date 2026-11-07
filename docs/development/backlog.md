# Backlog

1. Live validation: enable a Bedrock model, run a model-planned `create` end to end.
2. Live validation: deploy the example to a sandbox account with a budget alarm; confirm `verify` and teardown plan.
3. Wire `S3ArtifactStore` into the pipeline (Dynamo run store is selectable via `CLOUD_ENGINEER_TABLE`; both offline-tested only).
4. CodeBuild gate runner client (project defined in `infra/`; local sandbox stays dev-only).
5. Step Functions Standard definition + approval callback (task token).
6. CLI: `runs approve` alias; `NEEDS_INPUT` flow for blocking questions.
7. Upgrade the frontend to React/Next.js static export; custom domain + WAF; Cognito hosted UI.
8. PATCH (partial update) and conditional writes in the generated API.
9. Cost estimate from the Pricing API instead of qualitative notes.
10. Git forge adapters (push to GitHub etc.); local `export --git` already exists.
