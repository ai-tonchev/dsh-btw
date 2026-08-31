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
- The answer renders inline in a **command card** in the chat flow
  (`conversation.chat.commandview` keyed `btw`) — a resumable side thread: it
  shows the question/answer transcript, the **token stats** (input / cache hit /
  output as reported by the model adapter), a cancel action while answering, and
  a **follow-up input** that continues the same child session. The card is
  *live-only*: on replay from an earlier process it renders nothing (the
  transcript is not part of the durable main log). The main agent never sees the
  question or the answer.

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
        toolFilter: { allow: [read, glob, grep, web_search, read_image, skill] }
      )
        │
        ▼
Host: poll loop reads the child's own log (events past the seed boundary)
        │   → transcript exchanges + token usage
        ▼
Client: command card polls btw/status ──► answer + stats
        follow-up input ──► btw/followup ──► subagents.followup (same child)
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
   context preamble, and the question. Because the child is **continuable**
   (`subagents.startContinuable` + `followup`), every follow-up asked from the
   card continues the SAME child session, so successive exchanges hit the
   child's own growing prefix — incremental cost only, and the card's stats
   line shows the actual cache-hit/input/output tokens reported by the adapter
   (`assistant/message` usage folded from the child's log). Honest caveat: the
   child's system prompt differs from the parent's (subagent instructions +
   reduced tool list), so whether the parent's exact cache entry is *reused*
   rather than just *covered* depends on the provider's cache keying (Anthropic
   per-block breakpoints vs. DeepSeek/OpenAI whole-prefix).
3. **Sequential model — untouched.** DSH serializes per session, not globally.
   The side child is a separate agent+session, exactly like the background
   `subagent` tool. The main agent's inbox, turn ordering, and tool executions
   are never reordered or interrupted. The child's tools are restricted to a
   read-only allow-list (`toolFilter`, computed by intersecting the safe set
   with the tools actually registered, because `tools.restrict` rejects unknown
   names loudly), so it cannot race the main task's file writes or delegate.

### Trajectory and durability (what is recorded, what is not)

DSH's source of truth is the append-only session log — every event is lossless
JSON and "a bad event fails at the append site" (`Session.append` only accepts
declared `SessionEventMap` types). Here is how a `/btw` ask maps onto that:

- **Recorded in the main session trajectory — the ask.** `command/run` (with
  the question) and `command/done` are appended to the main session's log.
  They are *log-only*, so the model surface is untouched, but they are fully
  durable: the trajectory view replays them and the live chat card renders the
  ask while the plugin is running. The ask is therefore visible in the main
  conversation's history, forever.
- **Recorded in the child session trajectory — the full thread.** Every ask
  creates a durable **continuable** fork subagent, so the preamble + every
  exchange (question, answer, and any read/search tool calls) live in the
  *child session's* own log, discoverable via the subagent catalog under the
  main session and resumable with follow-ups from the card.
- **Not recorded anywhere durable in the main view — the rendered answer.**
  The answer text shown in the card comes from the plugin's **in-memory
  registry**, which is volatile: after a process restart with the plugin
  unloaded, the answer is gone from the main view (the answer itself remains in
  the child session). Because a replay cannot reconstruct the answer, **the card
  is live-only**: when the registry no longer has the entry, the card renders
  nothing rather than a dead card with a fake outcome. Caveat: this suppression
  applies while the plugin is running; if the plugin is stopped or removed, the
  default command card (question + "Asked.") reappears for old btw asks.

**The deliberate non-resonance.** The volatile answer registry is the one piece
that is *not fully resonant* with DSH's philosophy: the main trajectory records
the question but not its answer, and a replay alone cannot reconstruct the
answer — you must open the child session. That is an accepted trade-off: writing
the answer into the main log would require a new declared event type in the
deployment's `SessionEventMap` (a dynamic plugin cannot add one), and keeping
the answer out of the main log preserves the byte-identical model surface that
the cache guarantee depends on. The `command/run`/`command/done` records remain
in the raw log (the trajectory view still shows them as log records); only the
chat card is suppressed on replay. If a fully self-contained main trajectory
ever becomes a requirement, the answer could be folded into the main log by a
deployment-level event type (e.g. a log-only `btw/answer`) — out of scope for
this dynamic plugin.

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

To stop: `cordis_stop` (interrupts in-flight side threads via `subagents.interrupt`).

## Runtime prerequisites

- `dsh-commands` (the `/` slash-source + command registry) — shipped.
- `dsh-subagent-fork-in-process` (provider name `fork`) — shipped; without it
  the command returns an error result and never silently degrades.
- The subagent continuation manager (backs `startContinuable`/`followup`; the
  `subagent_fork` tool depends on it) — shipped.
- `dsh-agent-loop`, `dsh-client-ui-commands` (command card fallback) — shipped.

## Behavior notes & limitations

- **Bare `/btw`** returns an error result so the composer keeps your draft.
- **Concurrent asks** each get their own continuable child and registry entry
  (`btw-<commandId>`); each renders its own command card.
- **Resume** — the card's follow-up input continues the same child session
  (`subagents.followup`); follow-ups are queued FIFO while the child is busy.
- **Cancel** (`btw/cancel` or stopping the plugin) interrupts the child via
  `subagents.interrupt` under the parent agent's authority.
- **Stats** — the card's `in X · cache hit Y · out Z` line sums
  `assistant/message` usage from the child's log (`inputTokens`,
  `cacheReadTokens`, `outputTokens`; `write` shown when `cacheWriteTokens` is
  reported). Billed input = in + cache hit + write. The line is omitted when the
  adapter reported no usage.
- **Host sandbox:** no `AbortController`/`AbortSignal` globals exist there.
  The plugin uses a never-aborting stub wherever a signal is required
  (`commands.execute`, `subagents.startContinuable`, `subagents.followup`) and
  cancels explicitly via `subagents.interrupt`.
- **Streaming:** the card shows status + the accumulated answer (polled every
  ~0.7–0.9 s). Live token streaming from the child is a documented follow-up
  (scoped `session/event` listener on the child's ctx).
- **Session accumulation:** each ask creates a continuable child session
  (durable, resumable). Cleanup/archival of old threads is future work.
- **Cache verification** is provider-level; this plugin structurally guarantees
  main-session cache preservation and prefix sharing, and states the
  provider-dependent part honestly in this README.

## Follow-ups

- Live streaming of the child's tokens into the command card.
- "Copy answer" action on the card.
- Optional auto-prefill of `/btw ` in the composer when a background job starts.
