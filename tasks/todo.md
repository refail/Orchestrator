# Tasks

- [x] Role adapters and Pi launch isolation
  - Verify: `node --test tests/profiles.test.mjs`
- [x] Durable dispatch, project leases, explicit workspace targeting
  - Verify: `node --test tests/team.test.mjs`
- [x] Worker outcomes, failures, cancellation and timeout
  - Verify: `node --test tests/worker.test.mjs`
- [x] Pi extension, manifest actions, start/status and installation helper
  - Verify: fake end-to-end test and real Pi RPC load without model calls
- [x] README, source review, full suite
  - Verify: `node --test`; syntax/manifest checks
- [ ] Install and owner-supervised live Herdr smoke
  - Verify from a Herdr-managed pane; never mark complete based on fake CLIs
