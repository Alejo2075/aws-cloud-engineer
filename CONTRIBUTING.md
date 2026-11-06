# Contributing

1. Read `CLAUDE.md` (scope and rules) and `docs/architecture.md`.
2. `pnpm install`, then make sure `pnpm typecheck && pnpm lint && pnpm format && pnpm test` pass.
3. Small vertical slices with tests. Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …).
4. Branches: `feat/*`, `fix/*`, `docs/*`, `chore/*`; open a PR against `main`.

Rules that reviewers enforce:

- No fabricated results: do not document a feature as working until a test proves it.
- Anything touching deployment, IAM or sandboxing needs a test for its refusal paths.
- Tests never call AWS. Use ports and fakes (`FixtureProvider`, `DeployDeps`).
- Changing the generator? Regenerate `examples/reservation-app/generated` (the drift test tells you).
- Cloud Engineer ends at first verified deployment and handoff; post-deployment operations belong to Cloud Agent.
