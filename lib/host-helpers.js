/**
 * Pure host helpers for dsh-btw, extracted so they can be unit-tested without
 * a harness. The Host half (src/index.js) imports these; tests import them
 * directly.
 */

/** Pool of read-only tools a side child MAY be granted (the safety whitelist). */
export const SAFE_TOOLS = ['read', 'glob', 'grep', 'web_search', 'read_image', 'skill'];

/** Join the text blocks of a content array; non-text blocks are skipped. */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      if (out !== '') out += '\n';
      out += block.text;
    }
  }
  return out;
}

/** Join the reasoning (thinking) blocks of a content array; other blocks are skipped. */
export function reasoningOf(blocks) {
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string') {
      if (out !== '') out += '\n';
      out += block.text;
    }
  }
  return out;
}

/** Truncate to n chars with an ellipsis. */
export function excerpt(text, n) {
  return text.length > n ? text.slice(0, n) + '\u2026' : text;
}

/**
 * The fork provider seeds the child with the parent's events up to and
 * including the last `turn/end`. The child's OWN activity starts one seq
 * later, so everything at seq > seedEndSeq is this thread's Q&A.
 */
export function seedEndSeqOf(agent) {
  const events = agent && agent.session && Array.isArray(agent.session.events) ? agent.session.events : null;
  if (!events) return -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event && event.type === 'turn/end') return event.seq;
  }
  return -1;
}

/**
 * Compact snapshot of what the main conversation is doing right now. The fork
 * seed ends at the last turn/end (the in-flight turn is excluded), so this
 * preamble gives the side agent minimal awareness of the in-flight state.
 * `jobs` is the optional `jobs` service (best-effort).
 */
export function buildPreamble(agent, jobs) {
  const lines = [];
  const session = agent && agent.session;
  const events = session && Array.isArray(session.events) ? session.events : null;
  if (events) {
    let lastUser = '';
    let lastTool = '';
    let lastTurnMarker = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (!event || typeof event !== 'object') continue;
      if (lastTurnMarker === null && (event.type === 'turn/start' || event.type === 'turn/end')) lastTurnMarker = event.type;
      if (!lastUser && event.type === 'user/message' && Array.isArray(event.content)) lastUser = textOf(event.content).trim();
      if (!lastTool && event.type === 'tool/call' && typeof event.name === 'string') lastTool = event.name;
      if (lastUser && lastTool && lastTurnMarker !== null) break;
    }
    if (lastTurnMarker === 'turn/start') lines.push('The user\'s main conversation is mid-turn: the main agent is working right now.');
    if (lastUser) lines.push('Last user instruction to the main agent: ' + excerpt(lastUser, 220));
    if (lastTool) lines.push('Last tool the main agent invoked: ' + lastTool);
  }
  if (jobs) {
    try {
      const list = jobs.list(agent);
      const running = Array.isArray(list) ? list.filter((job) => job && job.status === 'running').length : 0;
      if (running > 0) lines.push('Background jobs running in the main session: ' + running);
    } catch (err) { /* best-effort */ }
  }
  return lines.join('\n');
}

/** Fold one adapter usage report into the entry's cumulative totals. */
export function foldUsage(entry, usage) {
  if (!usage || typeof usage !== 'object') return;
  entry.usage.input += typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
  entry.usage.output += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
  entry.usage.cacheRead += typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
  entry.usage.cacheWrite += typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
}

/**
 * Walk the child session's live event log (events past the seed boundary) and
 * fold it into the side-thread entry: assistant answers + usage into the
 * transcript, and turn completion into the status. Session events carry their
 * payload under `data` (`{type, seq, time, data}`), so the assistant message,
 * usage, and turn reason are read from `event.data`. Live sequence numbers
 * equal array indexes; a mismatch (or a missing object) stops the walk.
 *
 * @returns the new `lastSeenSeq` for the entry.
 */
export function foldChildEvents(entry, events) {
  if (!Array.isArray(events)) return entry.lastSeenSeq;
  let last = entry.lastSeenSeq;
  for (let i = entry.lastSeenSeq + 1; i < events.length; i++) {
    const event = events[i];
    if (!event || typeof event !== 'object') { last = i; continue; }
    if (event.seq !== i) break; // seq must equal index in the live log; resume at i next tick
    last = i;
    if (event.seq <= entry.seedEndSeq) continue; // seeded parent history
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    if (event.type === 'assistant/chunk') {
      // Raw token-level stream: accumulate visible text and reasoning live, so the
      // card can show progress instead of an opaque "answering…" for the whole turn.
      const chunk = data.chunk && typeof data.chunk === 'object' ? data.chunk : null;
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        entry.streamingText = (entry.streamingText || '') + chunk.text;
      } else if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
        entry.streamingReasoning = (entry.streamingReasoning || '') + chunk.text;
      }
    } else if (event.type === 'assistant/message' && data.message && Array.isArray(data.message.content)) {
      // Finalized message: promote the accumulated stream into the transcript and
      // reset the streaming buffers (the assembled content supersedes the deltas).
      // Reasoning (thinking) precedes the visible answer, matching model order.
      const reasoning = reasoningOf(data.message.content);
      if (reasoning) entry.exchanges.push({ role: 'reasoning', text: reasoning });
      const text = textOf(data.message.content);
      if (text) entry.exchanges.push({ role: 'assistant', text });
      foldUsage(entry, data.usage);
      if (entry.pending > 0) entry.pending -= 1;
      entry.streamingText = '';
      entry.streamingReasoning = '';
    } else if (event.type === 'turn/end') {
      // `turn/end.reason` is the authoritative terminal signal: the turn may end
      // with ZERO assistant/message events (blocked / error / aborted before any
      // streamed content), so it must NOT be gated on `pending` having reached 0.
      const kind = data.reason && data.reason.kind;
      if (entry.status === 'running') {
        if (kind === 'completed') entry.status = 'done';
        else if (kind === 'aborted') entry.status = 'cancelled';
        else {
          entry.status = 'error';
          if (!entry.error) {
            const failure = data.reason && data.reason.error;
            entry.error = failure && typeof failure === 'object' && typeof failure.message === 'string'
              ? failure.message
              : 'side agent turn ended: ' + kind;
          }
        }
      }
      entry.pending = 0;
    }
  }
  return last;
}

/**
 * The child toolset: intersect the configured allow-list (`allowed`, defaulting
 * to none) with the tools actually registered. Returns `{ allow: [] }` (no global
 * tools) when the configured list is empty — an empty allow-list is a deliberate
 * "no tools" grant, not a security downgrade. When tools are wanted but
 * `tools.schemas()` is unavailable (profile-level host), the full configured
 * list is passed through so a genuinely unknown name still fails loudly inside
 * `tools.restrict` at child creation.
 *
 * @param tools - the `tools` service (best-effort; may be absent at profile level).
 * @param allowed - names to grant; defaults to none (`[]`).
 */
export function computeToolFilter(tools, allowed = []) {
  if (allowed.length === 0) return { allow: [] };
  let known = null;
  try {
    if (tools) {
      const schemas = tools.schemas();
      if (Array.isArray(schemas)) known = new Set(schemas.map((s) => s && s.name).filter(Boolean));
    }
  } catch (err) { /* best-effort */ }
  const intersected = known !== null ? allowed.filter((name) => known.has(name)) : null;
  if (intersected === null || intersected.length === 0) {
    // Unknown scope (profile-level host) or an empty intersection: pass the full
    // configured list through so a genuinely unknown name fails loudly inside
    // tools.restrict at child creation, instead of silently downgrading to none.
    return { allow: allowed.slice() };
  }
  return { allow: intersected };
}
