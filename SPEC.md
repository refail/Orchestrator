# Herdr Orchestrator — v1 specification

Status: Owner approved implementation (“yes, start it”). v1 implemented locally;
installation and owner-supervised live Herdr/model smoke remain pending.

## Objective

A small, personal, locally developed Herdr plugin. The user talks to a Pi
orchestrator about a feature. Pi delegates all project research, implementation,
testing, and code review to visible specialist processes in Herdr. Pi handles
clarification, task breakdown, assignments, progress, blockers, and summaries only.

Source directory: `/Users/refailgjeli/dotfiles/herdr/plugins/orchestrator`.
No dependency on a third-party orchestration plugin or hosted service.

## Verified environment and role defaults

| Role | Harness | Model | Reasoning |
| --- | --- | --- | --- |
| Orchestrator | Pi 1.2.0 | `openai-codex/gpt-6.1-sol` | `high` |
| Coder | Claude Code | Existing configured default | Existing configured default |
| Reviewer | OpenCode 2.0.30 | `openai/gpt-6.1-sol` | Existing configured default |
| Researcher | OpenCode 2.0.30 | `openai/gpt-5.6-sol` | Existing configured default |

Herdr is exactly 0.7.1. Requested model IDs were found through each installed
CLI's model listing. Listing does not prove that a paid model request will succeed.
Use existing harness authentication; never copy credentials into plugin files.

Assumptions for approval:
- The researcher uses OpenCode, like the reviewer.
- Claude Code uses the owner's current default model unless later configured.
- `start.sh` runs the coordinator in the invoking interactive pane and current
  project directory. The plugin Start action remains a new-tab alternative;
  background Herdr actions cannot own the invoking shell's terminal.
- Specialists start on demand, not all at launch. Additional specialists are
  instances of these three profiles, with task-specific role descriptions.
- Keep one active coding assignment per project checkout in v1. Read-only work
  can run alongside it; review of a changing diff must wait for coding to stop.
- No automatic commits, pushes, merges, deployments, permission bypasses, or
  destructive cleanup.

## Scope and behavior

1. Foreground `start.sh` or the new-tab Start action opens Pi for a new feature
   run in the invoking project. Foreground launch captures the explicit caller's
   stable terminal ID before running Pi, without selecting a focused pane.
2. Pi has only narrow plugin tools: delegate, inspect task/team status, collect
   results/wait, and send follow-up assignments. No general shell, file-reading,
   file-writing, code-execution, MCP, or unrelated extension tools are exposed.
3. The plugin launches specialists in visible Herdr tabs/panes, with explicit
   project directory, role instructions, task brief, and acceptance criteria.
4. Workers report results and errors through plugin-owned task files. Completion
   requires a recorded worker outcome, not just Herdr reporting an idle terminal.
5. Pi reads those reports through its coordination tools and either assigns
   follow-up work, requests review, asks the user about a blocker, or summarizes.
6. Persist task briefs, statuses, results, and logs locally in Herdr's plugin state
   directory. A status action can inspect a run without launching more agents.
7. Permission/authentication failures and interrupted or missing workers remain
   explicit failures or unresolved tasks, never successful completions. Do not
   blindly resubmit a launch after an ambiguous error.
8. Reviewer and researcher receive read-only profiles. Exact harness permission
   enforcement must be verified before claiming it; profiles are not OS sandboxes.
9. A coordination-only tool allowlist constrains the orchestrator, not the coder
   it intentionally delegates to. This is not an adversarial security boundary.

## Technical direction and project structure

- Node.js ES modules for the plugin runtime and worker adapters.
- One explicitly loaded Pi TypeScript extension for coordination tools.
- Herdr `herdr-plugin.toml` with minimum version 0.7.1.
- Use the installed Herdr binary via `HERDR_BIN_PATH` and its 0.7.1 interface.
  Do not use newer `agent prompt` or `agent start --kind` command forms.
- Prefer standard-library functionality; no web UI, daemon, database, worktree
  manager, automatic global Pi extension installation, or Herdr upgrade in v1.

```text
herdr-plugin.toml       # start and status actions
src/                   # runtime, Herdr adapter, worker adapters
pi/                    # dedicated coordination-only extension
prompts/               # orchestrator and specialist instructions
config.example.json    # non-secret model and role defaults
tests/                 # Node unit/integration tests using fake CLIs
start.sh               # foreground coordinator in the invoking Herdr terminal
README.md              # setup, usage, limitations, uninstall
SPEC.md                # this document
```

## Code style

Small named functions, explicit argv arrays for subprocesses, validated task IDs,
atomic state-file publication, bounded waits, and errors with actionable context.
Never interpolate a user task into executable shell code.

```js
const args = ["--model", profile.model, "--thinking", "high"];
```

## Commands (planned)

```sh
cd /Users/refailgjeli/dotfiles/herdr/plugins/orchestrator
node --test
herdr plugin link /Users/refailgjeli/dotfiles/herdr/plugins/orchestrator
herdr plugin action invoke personal.orchestrator.start
herdr plugin action invoke personal.orchestrator.status
herdr plugin unlink personal.orchestrator
```

No compilation step is expected: Node executes ES modules and Pi loads its own
extension. Confirm the exact install/action commands against Herdr 0.7.1 before
publishing the README.

## Testing strategy and success criteria

- Test launch argv, model selection, project targeting, and safe task handling
  against fake Herdr, Pi, Claude Code, and OpenCode executables.
- Verify the Pi tool allowlist and blocked access to coding/general execution
  tools, including after session changes.
- Test task/result persistence, concurrent assignment safety, failed launches,
  worker failure, cancellation, bounded waits, and stale/missing results.
- Verify that only the coder can receive a writing assignment and two coding
  tasks cannot mutate the shared checkout concurrently.
- Run an owner-supervised live Herdr 0.7.1 smoke: start orchestrator, delegate
  research, code a tiny disposable-project change, request review, summarize.
- Do not claim live verification until that smoke passes with the actual CLIs.

## Boundaries

Always: preserve existing user settings and work; keep source local; use existing
authentication; make errors visible; test without paid model calls first.

Ask first: new dependencies, broader permissions, global keybindings/settings,
paid live tests outside the approved smoke scope, or expanding v1 features.

Never: expose arbitrary shell/file mutation tools to the orchestrator; silently
switch models; enable unrestricted permission bypasses; push or deploy; close
unrelated panes; discard dirty work; embed secrets in source or logs.

This development session is not inside Herdr (`HERDR_ENV` is unset). Do not
inspect or control its focused pane from here. Installation/runtime verification
that requires a live session must be performed from a Herdr-managed pane.

## Sources

- Herdr 0.7.1 plugin docs: https://herdr.dev/docs/0.7.1/plugins/
- Herdr 0.7.1 CLI reference: https://herdr.dev/docs/0.7.1/cli-reference/
- Installed `herdr --version`, `herdr agent --help`, `herdr plugin --help`.
- Installed Pi docs: `docs/cli.md`, `docs/extensions.md`, `docs/models.md`.
- Installed Pi model list and OpenCode model list (no credential values read).
- OpenCode CLI reference: https://opencode.ai/docs/cli/

## OpenCode v2 migration

The owner upgraded to 2.0.30 and approved adapting the local plugin. Workers use
`run --standalone --format json`, an empty per-task config directory, disabled
project config, and v2 `agents`/`permissions` configuration. Built-in credential
adapters remain available; global/project external plugins are not loaded.
Completion requires a zero CLI exit, a nonempty report, and no error events. V2
can omit the final `step_finish`, so final report text following a started step
is accepted when the CLI exits successfully. Existing task records are retained.
A real read-only research smoke passed in a disposable project; live Herdr layout
verification remains pending. The separately managed Herdr state integration was
adapted to v2's default `id`/`setup` definition and event subscription API, while
retaining its named v1 export. Its v2 reporting only runs in standalone servers
to avoid attributing a shared service's sessions to the wrong Herdr pane.

## Approval and implementation notes

Owner approved implementation after selecting this dotfiles location. The plan
and verification checklist are in `tasks/plan.md` and `tasks/todo.md`.

Assignments are one-shot attempts; follow-ups carry prior briefs/reports. Pi has
three tools, with follow-ups expressed through `team_delegate(previousTask=...)`.
The coordinator's stable terminal receipt is saved to avoid relying on stale
workspace numbers during later dispatch. The status overlay groups saved runs by
canonical project path. No global agent settings or credentials are changed.

## Visible TUIs, pane names, cleanup and agent skills

Owner request: workers must show the real agent UI in a named tab, Pi closes
finished panes, and both Pi and workers use Agent Skills. Choices made: one
tab per worker; the real interactive TUI; close after Pi collects a completed
report, keeping unsuccessful panes; skills for Pi and workers.

- Completion stays machine-readable: Claude Stop/StopFailure hook →
  `stop.json`; OpenCode headless `run --server` on a private `serve --stdio`
  server whose session the TUI attaches to. A TUI never decides the outcome.
- Panes are renamed `role · title` (pane and tab). Rename failures are recorded,
  never make a launch uncertain. Closing resolves the stable terminal ID first.
- `team_skill` exposes only `~/.agents/skills/<name>/SKILL.md` by validated name.
  Delegated skills are snapshotted per task and appended to worker system prompts.
- Verified without model calls: real OpenCode 2.0.30 server/client/TUI attach to
  a pre-chosen session, and real Pi loads the four-tool extension. Live Claude
  hook behavior and streaming in the attached OpenCode TUI need the owner smoke.
