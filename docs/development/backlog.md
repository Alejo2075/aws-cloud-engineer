# Backlog

1. Live validation: enable a Bedrock model, run a model-planned `create` end to end.
2. Live validation: deploy the example to a sandbox account with a budget alarm; confirm `verify` and teardown plan.
3. Wire `DynamoRunStore`/`S3ArtifactStore` into the pipeline via a storage option (adapters done, offline-tested).
4. CodeBuild gate runner client (project defined in `infra/`; local sandbox stays dev-only).
5. Step Functions Standard definition + approval callback (task token).
6. CLI: `resume`, `runs approve` alias; `NEEDS_INPUT` flow for blocking questions.
7. Frontend template (static export on S3 + CloudFront) and Cognito hosted UI.
8. Pagination in the generated list endpoint; update expressions.
9. Cost estimate from the Pricing API instead of qualitative notes.
10. Git adapter for repository output.
