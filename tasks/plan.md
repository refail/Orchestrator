# Implementation plan

The owner approved implementation with “yes, start it”. Keep the approved scope in SPEC.md.

1. Build role adapters and a coordination-only Pi launch profile; test argv and model selection first.
2. Build durable run/task records, exclusive coder/reviewer checkout leases, and Herdr 0.7.1 pane launch. Test ambiguity and concurrent dispatch before adding real workers.
3. Run one-shot specialist CLIs inside visible plugin panes, capture structured outcomes, and support follow-up assignments with prior reports. Add cancellation/timeout and error tests.
4. Wire narrow Pi tools, plugin actions, local install instructions, and status view. Smoke-load the real Pi extension without model calls.
5. Review, run all tests, and install/verify from a Herdr-managed pane. This session is outside Herdr: do not control its focused pane or claim a live smoke passed.

Dependencies: role adapters → task runtime → worker runner → Pi/plugin wiring → verification.

## Decisions

- Each assignment is an explicit one-shot worker attempt; follow-ups get the previous brief/report. No fragile terminal transcript scraping or hidden worker sessions.
- Manifest-declared worker and coordinator panes are supported by Herdr 0.7.1; use those rather than newer agent APIs.
- Local JSON records, standard-library Node.js, no dependencies or background service.
- A coder/reviewer lease is shared across all runs for the canonical checkout. Research may run concurrently. Uncertain launches or killed runners retain their lease until the owner resolves them; never blindly retry.
- OpenCode profiles deny all operations except explicit read/search operations and tightly scoped git inspection for review. No shell for research, MCP, edit, or nested agents. These harness permissions are not an OS sandbox.
- Claude uses normal edit permissions, not bypass mode; permission denials are reported as blocked.

## Risks/checkpoints

- Verify both provider event formats with captured fake events; a missing terminal result is not success.
- Run the actual Pi loader/RPC without a model request to validate the extension ABI and tool allowlist.
- Live authentication, paid model access, and Herdr layout behavior need the final owner-supervised smoke.
