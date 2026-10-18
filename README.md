# Personal feature orchestrator

A local Herdr **0.7.1** plugin. Talk to Pi about one feature; it delegates project
work to visible specialist tabs. No third-party orchestration package, service,
new npm dependencies, or global agent configuration changes.

| Role | Harness | Model |
| --- | --- | --- |
| Orchestrator | Pi | `openai-codex/gpt-6.1-sol`, **high** reasoning |
| Coding/testing | Claude Code | Your configured Claude default |
| Independent review | OpenCode | `openai/gpt-6.1-sol` |
| Project research | OpenCode | `openai/gpt-5.6-sol` |
| Security audit | Claude Code | `claude-opus-5-5`, **medium** effort |
| Simplification | OpenCode | `openai/gpt-6.1-sol#medium` (medium reasoning) |

Security tasks always follow the `security-and-hardening` skill, in addition to any
skills Pi passes. The security agent is read-only (Read/Glob/Grep). The simplifier
can edit project files but cannot run shell commands or tests, so Pi should have a
coder run checks afterwards. Security and simplifier tasks get the same git
diff snapshot as review.

Pi has only `team_delegate`, `team_status`, `team_wait`, and `team_skill`. Built-in
tools, other extensions, MCP, project context files, Pi's own skill discovery, and
shell execution are disabled in this dedicated session. Ordinary Pi sessions
remain unchanged.

## Agent skills

Pi plans with the [Agent Skills](https://agentskills.io) in `~/.agents/skills`.
`team_skill` lists them or returns one `SKILL.md` (names only, no path access).
The prompt makes Pi start from `using-agent-skills` and load the skill for each
phase (spec, planning, debugging...). Steps a skill describes that need tools are
delegated. `team_delegate` takes up to four `skills`; their text is snapshotted
to the task's `skills.md` and appended to the worker's system prompt (Claude
`--append-system-prompt`, OpenCode agent `system`), so the visible prompt stays
the brief. Role permissions still win over skill instructions.

## Install

Requirements: macOS/Linux, Node.js 22+, Herdr 0.7.1, Pi 1.2.0+, Claude Code, and
OpenCode **v2** (tested with **2.0.30**). Authenticate the three agent CLIs normally
beforehand. OpenCode v1 is no longer supported by this adapter.

**Inside a Herdr-managed terminal pane**, run:

```sh
sh ~/dotfiles/herdr/plugins/orchestrator/install.sh
```

The installer runs tests, links this directory, and lists its actions. It refuses
to run outside Herdr. No model requests are made by the tests. Herdr 0.7.1 stores
plugin registration per session; link again if you use a different named session.

## Start a feature

In a Herdr terminal, `cd` to the intended project and run:

```sh
sh ~/dotfiles/herdr/plugins/orchestrator/start.sh
```

Pi runs **in that same pane**, using your shell's current project directory. Exit
Pi to return to your shell. This needs an interactive terminal and explicit
`HERDR_PANE_ID`; the launcher verifies that pane's foreground processes include
itself and never falls back to whichever pane happens to be focused. Workers
still open in their own tabs.

The existing action remains available when you explicitly want a **new tab**:

```sh
herdr plugin action invoke personal.orchestrator.start
```

Herdr 0.7.1 runs actions in background processes without a terminal; that command
cannot directly host an interactive agent in the invoking shell. Use `start.sh`
for foreground launch rather than sending commands into a live pane.

Describe the feature to Pi, for example:

> Find how login validation works, have the coder fix empty-password handling and
> add tests, then obtain an independent review. Do not commit anything.

Each worker opens in its own tab, renamed `role · title` (e.g. `coder · Fix empty
password`), running the agent's **real interactive TUI**, so you see the prompt
and every step:

- **Claude Code** gets the brief as its initial prompt. A `Stop`/`StopFailure`
  hook from `--settings` runs `src/cli.mjs claude-hook`, which records Claude's
  first final message (`last_assistant_message`) in `stop.json`. That turn is
  the report. Permission prompts appear in the tab; answer them there.
- **OpenCode** runs a private localhost `opencode serve --stdio` with a random
  password. A headless `opencode run --server … --session …` produces the
  machine-readable report, and the TUI attaches to the same session.

When `team_wait` collects a **completed** task, Pi closes its pane. It looks the
pane up by the stable terminal ID, never by a possibly reused pane ID. Failed,
blocked, timed-out, interrupted and unknown panes stay open for inspection. Close
them yourself when done.

Pi creates specialists only when needed. Multiple instances can use the same role.
A checkout lease permits at most one coder, reviewer, security or simplifier task at a time, even across
feature runs. Researchers may work alongside a coder. Other ordinary agents and
human edits are not locked by this plugin.

Each assignment is a **fresh, bounded worker attempt**, not a persistent specialist
chat. Follow-up assignments carry the previous brief and final report. Pi handles
routing findings between roles. This avoids brittle terminal scraping.

For status, type `/team` in Pi (no model call), or run:

```sh
herdr plugin action invoke personal.orchestrator.status
```

The status overlay shows recent runs for the selected project: `r` refreshes;
`q` closes it. Worker tabs print their role, task ID, report, and outcome. Starting
again makes a new feature run; it does not replace or stop old agents.

## Permissions and limitations

- The orchestrator coordinates; it cannot directly run shell/file tools. It can
  intentionally delegate implementation to a coder. This is not an OS sandbox or
  protection against malicious code running as your user.
- OpenCode v2 profiles deny everything except read/glob/grep (plus `edit` for
  the simplifier, excluding `.env` files). Each worker uses a
  private `--standalone` server and empty per-task config directory, with project
  config disabled. Ambient plugins, MCP servers, and user-global agent settings
  are not loaded; built-in authentication still uses existing credentials.
  Shell, edits (except the simplifier's), nested agents, external tools, and
  arbitrary external directories are denied. Review receives a bounded git status/diff snapshot and can inspect
  files, but cannot run tests or fix code. System-managed policies can restrict
  local settings; the installed v2 resolver is included in tests.
- The security agent runs Claude with only Read/Glob/Grep and default permissions.
- The coder's Claude uses `acceptEdits`, not permission-bypass mode. Bash/tests still follow
  your existing Claude permissions; a command needing approval waits for you in
  the coder's tab (the task timeout still applies). The plugin never enables
  YOLO/auto mode.
- An assignment ends at the worker's first final answer. Whatever you then type
  into a still-open TUI is outside the record and the checkout lease, like any
  other human edit. The lease is released when the outcome is recorded.
- Commits/pushes/merges/deployment are forbidden in the role instructions, not an
  OS-level restriction on the coder. Review before trusting any worker's claims.
- Workers run in your **shared checkout**, not isolated worktrees. Preserve your
  own changes; don't run unrelated writers simultaneously. Review snapshots can
  be incomplete (untracked files, oversized diffs, repositories without HEAD).
- Default limits: 3 concurrent assignments per run, 30 total tasks, 15 minutes per
  worker, and 8 MiB of captured output. Reports passed to Pi are capped at 32,000
  characters. There is no total dollar budget or automatic remote cost control.
- Pi waits for task records, not Herdr's idle detection. Interrupting Pi's wait
  does **not** stop workers. To stop a worker, quit its TUI (Ctrl+C belongs to
  the TUI) or close its tab; the runner records `interrupted` and stops the
  OpenCode server/client process groups. Claude runs in the pane's foreground
  group so it can own the terminal; closing the pane stops it. Deliberately
  detached processes are outside this cooperative boundary.
- Hard-killing a runner, closing panes, or ambiguous API failures can leave an
  unresolved attempt and checkout lease. Never blindly retry or delete the lease:
  inspect the exact task/logs and verify all its processes have stopped first.
  There is no automatic stale-lock recovery or branch cleanup in v1; only
  completed panes are closed automatically.
- Workspace numbers can change. Worker placement resolves the coordinator's
  recorded stable terminal ID before launching, rather than trusting an old
  workspace number. If that terminal disappears, dispatch refuses to continue.
- No automatic coordinator restart/resume in v1. Sessions/task records remain on
  disk, but reopening a lost feature requires manual recovery rather than a new
  task being silently duplicated.

## Configuration

Defaults are built in. Optional overrides go in `config.json` under the directory
printed by:

```sh
herdr plugin config-dir personal.orchestrator
```

Use `config.example.json` as a reference; include only the keys you want to change.
For example, `{"coderModel":"sonnet","maxParallel":2}`. New feature runs snapshot
the current configuration; existing runs keep their original settings. Store no
credentials in this file. Existing CLI authentication is used unchanged.

## Records and troubleshooting

Herdr's `HERDR_PLUGIN_STATE_DIR` owns `runs/<run-id>/run.json`, Pi sessions, task
briefs, `skills.md`, launch receipts, OpenCode `events.jsonl`/`stderr.log`, Claude
`stop.json` (with its transcript path), `closed.json`, and `result.json`. Status shows
the exact run directory. These local records may contain project/source data;
don't publish them or commit them to dotfiles. No telemetry is added by this
plugin; the agent CLIs retain their own normal network/settings behavior.

Inspect saved records without controlling Herdr:

```sh
node ~/dotfiles/herdr/plugins/orchestrator/src/cli.mjs inspect /absolute/path/to/run
```

If Start appears to do nothing, inspect action logs from inside Herdr:

```sh
herdr plugin log list --plugin personal.orchestrator --limit 10
```

If Pi opened but delegation reports **Missing coordinator terminal receipt**, check
whether the run has `coordinator.json`. Earlier code misread Herdr 0.7.1's
`result.plugin_pane.pane` response, leaving an open Pi tab without that record.
The response adapter now unwraps and validates the receipt. Source updates do
not repair old runs or reload an already-running coordinator: inspect the old
run, verify no workers are still running, then start a new feature run. Do not
fabricate receipts, delete checkout leases, or blindly retry old assignments.

After upgrading OpenCode, restart the coordinator and use new worker attempts;
old running processes do not reload source changes. V2 uses a different plugin
API and config schema, and no longer supports `--pure`. The adapter uses private
config/server isolation instead. A successful v2 CLI run must exit zero, produce
a nonempty final report, and contain no error events; v2 may omit the final
`step_finish` event, including after an earlier tool-call step.

The local `~/.config/opencode/plugins/herdr-agent-state.js` integration also has a
v2 default definition (`id` + `setup`). Its named v1 export is retained. For
ordinary OpenCode sessions that need pane-specific Herdr status reporting, use
`opencode --standalone`: a shared background service does not reliably inherit
the current pane's identity, so the v2 integration stays inert there. Herdr owns
that integration file; reinstalling/updating it may overwrite this local patch.

`failed`, `blocked`, `timed_out`, `interrupted`, `unknown`, and `launch_uncertain`
are not success. A completed CLI report is also not proof of correct code; require
test evidence and independent review. Keep failed records for recovery. Local
records have no automatic expiry; remove only runs you deliberately no longer
need, after their agents have stopped, never while they own a checkout lease.

## Development and verification

```sh
cd ~/dotfiles/herdr/plugins/orchestrator
node --test
```

Tests use disposable directories and fake Herdr/agent subprocesses. When installed,
the real Pi RPC loader and OpenCode v2 profile resolver are also checked **without
model requests**. A real OpenCode 2.0.30 research worker successfully read a
fixture and returned its contents without changing files. The repaired Herdr
state integration also loaded as `active` in the real v2 plugin loader. Live
Herdr layout and foreground TTY behavior still require an owner-supervised check
inside Herdr.

Test the separately managed Herdr/OpenCode integration with:

```sh
node --test ~/dotfiles/config/.config/opencode/tests/herdr-agent-state.test.mjs
```

Owner-supervised live smoke (inside Herdr):
1. Use a disposable Git project with a committed baseline.
2. Install/link, then Start in that workspace.
3. Ask Pi to delegate a read-only entrypoint search, a tiny tested change, and a
   review, without commits. Expect named tabs showing the live Claude/OpenCode
   TUIs, real reports, and completed tabs closing after Pi collects them.
4. Verify the diff/tests yourself and verify `/team` lists only coordination tools.

## Uninstall

After stopping this plugin's agents, run inside the session where it was linked:

```sh
herdr plugin unlink personal.orchestrator
```

Source, settings, state and ordinary agents are left alone. No global keybindings
or agent extension directories are modified.

## References

- [Herdr 0.7.1 plugins](https://herdr.dev/docs/0.7.1/plugins/)
- [Herdr 0.7.1 CLI](https://herdr.dev/docs/0.7.1/cli-reference/)
- [OpenCode 2.0.30 plugin API](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/plugin/src/README.md)
- [OpenCode 2.0.30 config schema](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/schema/src/config.ts)
- [OpenCode 2.0.30 CLI completion semantics](https://github.com/anomalyco/opencode/blob/v2.0.30/packages/cli/src/run/noninteractive.ts)
- Pi's installed `docs/cli.md`, `docs/extensions.md`, and `docs/rpc.md`.
