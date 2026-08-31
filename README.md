# dsh-btw — `/btw` for DeepSeek Harness

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Recreates Claude CLI's `/btw`: **ask a question "by the way" while the main
agent keeps running**, without interrupting or polluting the main conversation.

- `/btw <question>` works **while the main agent is running** (mid-turn, waiting
  on a background job, or running a subagent). The composer stays editable
  during runs and slash-command lines are adjudicated *before* the message/queue
  path, so the command executes instantly and returns.
- While the session agent is busy (the send button becomes **Stop**), a small
  grey **BTW** button appears in the composer tool row; clicking it prefills the
  composer with `/btw `.
- The answer renders inline in a **resumable command card**: the Q&A transcript,
  **token stats** (`in X · cache hit Y · out Z`), a cancel action while
  answering, and a **follow-up input** that continues the same child session.
- The question is answered by a **durable, continuable fork subagent** — a
  separate child session seeded with the parent's completed-turn prefix
  (provider prefix-cache friendly) and restricted to a **read-only toolset**, so
  it can neither race the main task's file writes nor pollute the main
  conversation's prompt surface.

Repository: <https://github.com/ai-tonchev/dsh-btw>

---

## Installation (exact DSH profile steps)

### Prerequisites

- A working [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
  installation with the `dsh` CLI on `PATH` (or use `npx -y @deepseek-ai/dsh`).
- Node.js **>= 20** and a package manager (pnpm is the profile default).
- A **web profile** for the full UI (the client half needs the web shell; the
  `/btw` command itself also works in headless profiles). `web` is the built-in
  template; `dsh plugin` creates it on first use.

### Install

```bash
# canonical install (committed lib/ — no build happens on your machine)
dsh plugin --profile web add github:ai-tonchev/dsh-btw

# or, when `dsh` is not on PATH:
npx -y @deepseek-ai/dsh plugin --profile web add github:ai-tonchev/dsh-btw

# local checkout install (development / pre-release):
dsh plugin --profile web add /absolute/path/to/dsh-btw
```

What this does: `dsh plugin` forwards `pnpm add` inside the profile
(`~/.dsh/profiles/web`), then reconciles the profile's `dsh.profile.bundles`
layer list — the package declares `dsh.bundle.patch`, so it joins the layer
stack and its `cordis.patch.yml` inserts the plugin row.

### Restart

**Restart the DSH web process** after installing. The profile composes its
bundles at boot and the web shell scans `dsh.client` modules to serve the
client half.

### Verify

- The composer tool row shows a grey **BTW** button while the session agent is
  busy (send button = Stop).
- Type `/btw what does this error mean?` while the agent works → the command
  card appears instantly and the answer lands in the card.
- `~/.dsh/profiles/web/package.json` lists `"dsh-btw"` under
  `dsh.profile.bundles`, and `dsh plugin --profile web list` shows the package.

### Uninstall

```bash
dsh plugin --profile web remove dsh-btw   # pnpm remove + layer reconcile
```

Then restart the DSH web process. In-flight side threads are interrupted on
plugin teardown; previously asked cards become plain log records (see
[Known limitations](#known-limitations)).

---

## Usage

1. While the agent is running, click **BTW** (or type `/btw <question>`) and hit
   Enter.
2. The card shows the question, "answering…", then the answer plus the token
   stats line.
3. Ask a **follow-up** in the card's input — it continues the *same* child
   session (the child's own prompt prefix grows, so later exchanges are
   incremental-cost and cache-friendly).
4. **Cancel** stops the current answer (`subagents.interrupt`).

## How it works

```
Composer: BTW button (busy only) → "/btw " draft, or type /btw <question>
        │
        ▼
Host: commands.execute('/btw …')      ← command/run + command/done are
        │                                log-only, NEVER model surface
        ▼
Host: subagents.startContinuable(      ← durable continuable child, seeded
        provider: 'fork',                with the parent's completed-turn
        prompt: [preamble + question],   prefix; toolFilter = read-only set
      )
        │
        ▼
Host: poll loop reads the child's own log (events past the seed boundary)
        │   → transcript exchanges + token usage (input/cacheRead/output)
        ▼
Client: card polls btwPanel.status ──► answer + stats
        follow-up input ──► btwPanel.followup ──► subagents.followup (same child)
```

**Cache:** the only events a `/btw` invocation appends to the main session are
`command/run` + `command/done`, declared *log-only (never model surface)* — the
main prompt is byte-identical, so its provider prefix cache stays warm. The
child shares the parent's completed-turn prefix, so the provider's prefix cache
covers that history; follow-ups hit the child's own growing prefix. Whether the
*parent's exact* cache entry is reused by the child depends on the provider's
cache keying (Anthropic per-block breakpoints vs. DeepSeek/OpenAI whole-prefix).
The card's stats line reports the adapter's actual numbers.

**Sequential model:** DSH serializes per session, not globally. The side child
is a separate agent+session (the same mechanism as the background `subagent`
tool); the main agent's inbox, turn ordering, and tool executions are never
reordered or interrupted.

**Trajectory:** the ask is durably recorded in the main session (log-only
events); the full Q&A lives in the child session's own log (discoverable via
the subagent catalog, resumable). The transcript rendered in the card lives in
the plugin's in-memory registry and is *not* part of the durable main log —
this is a deliberate trade-off (keeping the answer out of the main log
preserves the byte-identical model surface), so **cards are live-only**: on
replay from an earlier process they render nothing.

## Prerequisites & supported platforms

| Aspect | Requirement |
| --- | --- |
| Harness | Web profile for the client UI (any profile for the `/btw` command; the `typert` remote is optional and skipped where absent) |
| Node | >= 20 |
| OS | Any platform DSH supports (macOS / Linux / Windows) — no native dependencies |
| Browser | Any browser the DSH web shell supports |
| Peer deps | `@deepseek-ai/cordis ^4.0.1`, `@deepseek-ai/dsh-commands`, `@deepseek-ai/dsh-subagent`, `@deepseek-ai/dsh-typert-protocol` (`^0.1.1-rc.2` line) |

## Permissions & boundaries

| Area | What the plugin does |
| --- | --- |
| Commands | Registers the `btw` command (log-only lifecycle; never enters the model surface) |
| Subagents | Spawns **continuable fork** children per ask, seeded with the parent's completed-turn prefix and restricted via `toolFilter` to a read-only set (`read`, `glob`, `grep`, `web_search`, `read_image`, `skill` — intersected with tools actually registered) |
| Remote (web only) | `btwPanel` Typert namespace: `status` / `followup` / `cancel` |
| Network | The plugin itself opens **no** connections; `web_search` inside the child is the agent's own configured capability |
| Credentials | **None** read, stored, or transmitted |
| Workspace | The side child is **read-only**; the plugin never writes to the main session's model surface |
| Timers | One host poll per active thread + client polling intervals, all disposed on stop/update |
| Storage | None of its own; threads persist as ordinary DSH child sessions |

## Known limitations

- **Live-only cards**: replayed asks (after a process restart) render nothing in
  the chat; the answer is recoverable from the child session.
- **Session accumulation**: each ask creates a durable continuable child
  session; pruning old threads is future work.
- **Provider-dependent cache accounting**: exact cache-hit numbers come from the
  adapter's usage report; the stats line is omitted when the adapter reports
  none.
- **Busy button**: appears only while the *agent* is running (send = Stop), not
  for background jobs alone — `/btw` typed directly still works in that case.
- **Follow-ups queue FIFO** while the child is busy.
- The child does not see the main conversation's *in-flight* turn (fork seed
  ends at the last completed turn); a short context preamble compensates.

## Update / upgrade

```bash
dsh plugin --profile web add github:ai-tonchev/dsh-btw   # re-run pulls latest; pin with #vX.Y.Z
```

Restart the DSH web process afterwards. See the [GitHub releases](https://github.com/ai-tonchev/dsh-btw/releases)
for versioned changes.

## Development

```
src/index.js     Host half (plain ESM)  → lib/index.js   (committed copy)
src/client.js    Client half (browser)  → lib/client.js  (esbuild + ModuleLoader handshake)
scripts/         build-host, build-client, verify, smoke-host, e2e-host, link-harness
cordis.patch.yml Profile layer patch    (dsh.bundle.patch target)
```

```bash
pnpm install          # or: npm install (esbuild + zod devDependencies)
npm run build         # copies host + bundles client + verifies
npm run verify        # checks the committed lib/ contract (bundle + smoke)
npm test              # unit tests for the pure host/client helpers (node --test)
npm run e2e           # boots a real Cordis ctx with the REAL timer/sessions/commands/
                      #   typert services, mounts lib/index.js, drives commands.execute
                      #   and the btwPanel remote, and asserts the full host contract
                      #   (the subagent continuation stack is stubbed)
```

`npm run e2e` needs the real DSH packages resolvable; link them from a local
harness checkout with `npm run link:harness -- <checkout>/node_modules`
(or `DSH_HARNESS_NODE_MODULES`).

`lib/` is committed (the profile install path builds nothing on the user's
machine). To test against a live harness, install the checkout into a scratch
profile: `dsh plugin --profile <scratch> add /absolute/path/to/dsh-btw`. A
`link:` install keeps the profile pointing at this checkout, so local changes
apply on the next DSH restart; switch to the canonical
`dsh plugin --profile web add github:ai-tonchev/dsh-btw` once published.

## License

[MIT](LICENSE) — © 2026 ai-tonchev.
