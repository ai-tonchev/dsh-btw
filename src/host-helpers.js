/**
 * Pure host helpers for dsh-btw, extracted so they can be unit-tested without
 * a harness. The Host half (src/index.js) imports these; tests import them
 * directly.
 */

/** Read-only toolset granted to every side child (intersected with what is actually registered). */
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
 * The child toolset: intersect the safe read-only set with the tools actually
 * registered (tools.restrict rejects unknown names loudly in the child's
 * creation window). A profile-level context exposes no agent tool scope, so
 * `tools.schemas()` may return an empty set — in that case (and whenever the
 * intersection is empty) we FALL BACK to the full read-only set rather than
 * silently dropping the filter: a genuinely unknown name then surfaces as a
 * clear start error instead of a security downgrade.
 */
export function computeToolFilter(tools) {
  let known = null;
  try {
    if (tools) {
      const schemas = tools.schemas();
      if (Array.isArray(schemas)) known = new Set(schemas.map((s) => s && s.name).filter(Boolean));
    }
  } catch (err) { /* best-effort */ }
  const intersected = known !== null ? SAFE_TOOLS.filter((name) => known.has(name)) : null;
  if (intersected === null || intersected.length === 0) {
    console.warn('dsh-btw: no safe read-only tools resolvable from this context; using the full read-only set');
    return { allow: SAFE_TOOLS.slice() };
  }
  return { allow: intersected };
}
