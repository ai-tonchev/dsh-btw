# dsh-btw — `/btw` for the DeepSeek Harness

A dynamic Cordis plugin that recreates Claude CLI's `/btw` command: **ask a
question "by the way" while another process is running**, without interrupting
or polluting the main agent's conversation.

- `/btw <question>` in the composer works **while the main agent is running**
  (waiting on a background job, mid-turn, or running a subagent). The composer
  stays editable during runs, and slash-command lines are adjudicated *before*
  the message/queue path, so the command executes instantly.
- While the session agent is busy (the send button becomes **Stop**), a small
  grey **BTW** button appears in the composer tool row (`conversation.input.left`).
  Clicking it prefills the composer with `/btw `; type the question and hit
  Enter. The button hides again once the agent is idle.
- The answer renders inline in a **durable command card** in the chat flow
  (`conversation.chat.commandview` keyed `btw`), with a cancel action while the
  side ask is running. The main agent never sees the question or the answer.

## How it works

```
Composer: BTW button (busy only) → "/btw " draft, or type /btw <question>
        │
        ▼
Host: commands.execute('/btw …')      ← command/run + command/done are
        │                                log-only, NEVER model surface
        ▼
Host: subagents.start('fork', {        ← separate child agent + session
        parent: mainAgent,               seeded with the parent's
        prompt: [preamble + question],   completed-turn prefix
        toolFilter: { allow: [read, glob, grep, web_search, read_image, skill] }
      })
        │
        ▼
Client: command card polls btw/status ──► host.call → Host registry → answer
```

### Why this satisfies "cache hits" and "no impact on DSH's sequential approach"

1. **Main conversation cache — preserved by construction.** The only events a
   `/btw` invocation appends to the main session are `command/run` and
   `command/done`, which DSH declares as *log-only (never model surface)* —
   the projection excludes them from the model-visible message stream. The main
   agent's next model call is byte-identical to what it would have been, so the
   provider's prompt/prefix cache stays warm. The side child never writes to
   the main session.
2. **Side ask — shares the parent's prefix.** The `fork` provider seeds the
   child with the parent's completed-turn prefix: the exact message events the
   parent already sent. The provider's prefix cache therefore covers that
   history and the child only "pays" for its own system prompt, the small
   context preamble, and the question. Honest caveat: the child's system prompt
   differs from the parent's (subagent instructions + reduced tool list), so
   whether the parent's exact cache entry is *reused* rather than just
   *covered* depends on the provider's cache keying (Anthropic per-block
   breakpoints vs. DeepSeek/OpenAI whole-prefix). A future "continuable side
   session" mode (`subagents.startContinuable` + `followup`) would make
   successive asks hit the child's own growing prefix — incremental cost only.
3. **Sequential model — untouched.** DSH serializes per session, not globally.
   The side child is a separate agent+session, exactly like the background
   `subagent` tool. The main agent's inbox, turn ordering, and tool executions
   are never reordered or interrupted. The child's tools are restricted to a
   read-only allow-list (`toolFilter`, computed by intersecting the safe set
   with the tools actually registered, because `tools.restrict` rejects unknown
   names loudly), so it cannot race the main task's file writes or delegate.

### The in-flight context preamble

The fork seed ends at the last `turn/end` — the current in-flight turn (the
task the user is running right now) is excluded by design. To compensate, the
Host reads leaf fields from the main session's live events and prepends a short
snapshot to the child's prompt: "the main conversation is mid-turn", the last
user instruction, the last tool invoked, and the number of running background
jobs.

## Files

- `plugin/host.js` — the exact `code.host` value (plain JS function body).
- `plugin/client.js` — the exact `code.client` value (plain JS, no JSX/TS).
- `load.mjs` — prints the `cordis_define`/`cordis_run` payload for a fresh
  session (dynamic plugins are session-owned; there is no file-based loader).

## Loading it into the harness

Dynamic plugins are defined and run through the harness's own tools, not by
`node`. In any session with the `cordis` preset:

1. `cordis_define` with `plugin: { kind: 'new', idPrefix: 'btw' }`,
   `code.host` = contents of `plugin/host.js`, `code.client` = contents of
   `plugin/client.js`.
2. `cordis_run` the returned `pluginId`/`packageId` and approve the client
   package in the UI (first run only).
3. To update: `cordis_define` with `kind: 'existing'` + the same `pluginId`,
   then `cordis_run mode: 'update'` with the new `packageId`.

To stop: `cordis_stop` (cancels in-flight children via `run.dispose()`).

## Runtime prerequisites

- `dsh-commands` (the `/` slash-source + command registry) — shipped.
- `dsh-subagent-fork-in-process` (provider name `fork`) — shipped; without it
  the command returns an error result and never silently degrades.
- `dsh-agent-loop`, `dsh-client-ui-commands` (command card fallback) — shipped.

## Behavior notes & limitations

- **Bare `/btw`** returns an error result so the composer keeps your draft.
- **Concurrent asks** each get their own child agent and registry entry
  (`btw-<commandId>`); each renders its own command card.
- **Cancel** (`btw/cancel` or stopping the plugin) calls `SubagentRun.dispose()`.
- **Host sandbox:** no `AbortController`/`AbortSignal` globals exist there.
  The plugin uses a never-aborting stub wherever a signal is required
  (`commands.execute`, `subagents.start`) and cancels explicitly via
  `run.dispose()`.
- **Streaming:** v1 shows status + the final answer (polled). Live token
  streaming from the child is a documented follow-up (scoped `session/event`
  listener on `run.localAgent.ctx`).
- **Session accumulation:** each ask creates a one-shot child session (same as
  the built-in subagent tool). Cleanup/archival is future work.
- **Cache verification** is provider-level; this plugin structurally guarantees
  main-session cache preservation and prefix sharing, and states the
  provider-dependent part honestly in this README.

## Follow-ups

- Continuable side session so repeated asks hit an ever-growing child prefix
  (stronger side-thread cache hits) and the thread keeps its own Q&A history.
- Live streaming of the child's tokens into the command card.
- Optional auto-prefill of `/btw ` in the composer when a background job starts.
