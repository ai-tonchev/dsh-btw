/**
 * dsh-btw — Host half.
 *
 * Recreates Claude CLI's `/btw`: the user asks a question "by the way" while
 * the main agent keeps running. The question is answered by a durable,
 * continuable FORK subagent (a separate child session seeded with the parent's
 * completed-turn prefix, restricted to a read-only toolset) and rendered as a
 * resumable command card in the web chat with live token stats.
 *
 * - registers the `/btw` human command. The command lifecycle (`command/run` +
 *   `command/done`) is log-only and NEVER enters the model surface, so the main
 *   conversation's prompt and provider prefix cache stay untouched.
 * - observes each child's own log (events past the seed boundary) for answer
 *   exchanges and token usage, and exposes a `btwPanel` Typert Remote for the
 *   web client: status / followup / cancel.
 * - the `typert` seam is optional (non-web profiles skip the remote); the
 *   command itself works in any profile.
 *
 * This file is the source of `lib/index.js` (committed after `npm run
 * build:host`); the profile installs the committed `lib/` as-is.
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

export const name = 'dsh-btw';
export const inject = ['commands', 'subagents', 'agents', 'timer'];

/**
 * `btwPanel` Remote 命名空间的调用描述符（src-json codec）。手工经
 * `ctx.typert.register()` 注册——运行时 registry 接受 src-json，免去 zod
 * 依赖；Web 客户端半边（lib/client.js）按同一套参数顺序调用。
 */
function panelDescriptor(method, parameters, cancellation) {
  return Object.freeze({
    id: `dsh-btw#btwPanel/${method}`,
    service: 'btwPanel',
    namespace: 'btwPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({
      name: p,
      wire: p,
      source: 'json',
      codec: Object.freeze({ mode: 'src-json' }),
    }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'src-json' }),
  });
}

const PANEL_INVOCATIONS = Object.freeze([
  panelDescriptor('status', ['commandId']),
  panelDescriptor('followup', ['commandId', 'text'], true),
  panelDescriptor('cancel', ['commandId'], true),
]);

/** `btwPanel` 宿主服务：命令卡片轮询 / 续写 / 取消的 RPC 面。 */
class BtwPanelService extends TypertRemoteService {
  constructor(ctx, ops) {
    super(ctx, 'btwPanel');
    this.ops = ops;
  }

  /** 卡片快照：状态、问题、问答交换、累计 token 用量。 */
  status(commandId) {
    return this.ops.status(commandId);
  }

  /** 在同一子会话上续写一条后续消息。 */
  followup(commandId, text, signal) {
    return this.ops.followup(commandId, text, signal);
  }

  /** 中断正在进行的回答。 */
  cancel(commandId, signal) {
    return this.ops.cancel(commandId, signal);
  }
}

export function apply(ctx) {
  const commands = ctx.commands;
  const subagents = ctx.subagents;
  const agents = ctx.agents;
  const jobs = ctx.get('jobs');
  const tools = ctx.get('tools');

  const SAFE_TOOLS = ['read', 'glob', 'grep', 'web_search', 'read_image', 'skill'];
  const runs = new Map();

  function textOf(blocks) {
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

  function excerpt(text, n) {
    return text.length > n ? text.slice(0, n) + '\u2026' : text;
  }

  // The fork provider seeds the child with the parent's events up to and
  // including the last `turn/end`. The child's OWN activity starts one seq
  // later, so everything at seq > seedEndSeq is this thread's Q&A.
  function seedEndSeqOf(agent) {
    const events = agent && agent.session && Array.isArray(agent.session.events) ? agent.session.events : null;
    if (!events) return -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event && event.type === 'turn/end') return event.seq;
    }
    return -1;
  }

  // Compact snapshot of what the main conversation is doing right now. The fork
  // seed ends at the last turn/end (the in-flight turn is excluded), so this
  // preamble gives the side agent minimal awareness of the in-flight state.
  function buildPreamble(agent) {
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

  // Intersect the safe read-only set with the tools actually registered
  // (tools.restrict rejects unknown names loudly). Null when nothing is
  // resolvable -> child runs without a filter (logged).
  function computeToolFilter() {
    let known = null;
    try {
      if (tools) {
        const schemas = tools.schemas();
        if (Array.isArray(schemas)) known = new Set(schemas.map((s) => s && s.name).filter(Boolean));
      }
    } catch (err) { /* best-effort */ }
    const allow = known ? SAFE_TOOLS.filter((toolName) => known.has(toolName)) : SAFE_TOOLS.slice();
    if (allow.length === 0) {
      console.warn('dsh-btw: no safe read-only tools resolvable; child runs without a tool filter');
      return null;
    }
    return { allow };
  }

  function foldUsage(entry, usage) {
    if (!usage || typeof usage !== 'object') return;
    entry.usage.input += typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    entry.usage.output += typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    entry.usage.cacheRead += typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0;
    entry.usage.cacheWrite += typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : 0;
  }

  function pollChild(entry) {
    if (entry.childId === null) return;
    const agent = agents.get(entry.childId);
    if (!agent) return; // not resident (cold resume in progress) — retry next tick
    const events = agent.session && Array.isArray(agent.session.events) ? agent.session.events : null;
    if (!events) return;
    for (let i = entry.lastSeenSeq + 1; i < events.length; i++) {
      const event = events[i];
      if (!event || typeof event !== 'object') continue;
      if (event.seq !== i) break; // seq must equal index in the live log
      if (event.seq <= entry.seedEndSeq) continue; // seeded parent history
      if (event.type === 'assistant/message' && event.message && Array.isArray(event.message.content)) {
        const text = textOf(event.message.content);
        if (text) entry.exchanges.push({ role: 'assistant', text });
        foldUsage(entry, event.usage);
        if (entry.pending > 0) entry.pending -= 1;
      } else if (event.type === 'turn/end' && entry.pending <= 0) {
        const kind = event.reason && event.reason.kind;
        if (entry.status === 'running') {
          if (kind === 'completed') entry.status = 'done';
          else if (kind === 'aborted') entry.status = 'cancelled';
          else {
            entry.status = 'error';
            entry.error = entry.error || ('side agent turn ended: ' + kind);
          }
        }
      }
    }
    entry.lastSeenSeq = events.length - 1;
    maybeStopPoll(entry);
  }

  function ensurePoll(entry) {
    if (entry.poll) return;
    entry.poll = ctx.interval(() => pollChild(entry), 900);
  }

  function maybeStopPoll(entry) {
    if (!entry.poll) return;
    if ((entry.status === 'done' || entry.status === 'error' || entry.status === 'cancelled') && entry.pending <= 0) {
      try { entry.poll(); } catch (err) {}
      entry.poll = null;
    }
  }

  function spawnAsk(agent, commandId, question) {
    const entry = {
      commandId,
      sessionId: agent.session.id,
      question,
      childId: null,
      seedEndSeq: seedEndSeqOf(agent),
      exchanges: [{ role: 'user', text: question }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      pending: 1,
      status: 'running',
      error: '',
      parent: agent,
      controller: new AbortController(),
      poll: null,
      lastSeenSeq: -1,
    };
    runs.set(commandId, entry);
    const preamble = buildPreamble(agent);
    const prompt =
      'Answer this side question ("by the way") directly and concisely, while the user\'s main task keeps running. ' +
      'Use read or search tools only if needed; do not modify anything.' +
      (preamble ? '\n\nCurrent context of the main conversation:\n' + preamble : '') +
      '\n\n' + question;
    const toolFilter = computeToolFilter();
    subagents.startContinuable({
      provider: 'fork',
      label: 'BTW: ' + excerpt(question, 48),
      request: {
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        ...(toolFilter ? { toolFilter } : {}),
      },
      signal: entry.controller.signal,
    }).then((start) => {
      if (entry.status === 'cancelled') return;
      entry.childId = start.childId;
      entry.lastSeenSeq = entry.seedEndSeq;
      ensurePoll(entry);
    }).catch((err) => {
      if (entry.status === 'cancelled') return;
      entry.status = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
    });
  }

  ctx.effect(() => commands.register({
    name: 'btw',
    description: 'Ask a question by the way while the main task keeps running.',
    input: { hint: 'your question' },
    handler: (invocation) => {
      const question = (invocation.rawInput || '').trim();
      if (!question) return { kind: 'error', text: 'Ask a question, e.g. /btw what does this error mean?' };
      if (!subagents.list().includes('fork')) return { kind: 'error', text: 'btw: the fork subagent provider is not available in this deployment.' };
      spawnAsk(invocation.agent, invocation.commandId, question);
      return { kind: 'success', text: 'Asked.' };
    },
  }));

  const ops = {
    status(commandId) {
      const entry = runs.get(String(commandId || ''));
      if (!entry) return null;
      return {
        status: entry.status,
        question: entry.question,
        exchanges: entry.exchanges.slice(-12),
        usage: {
          input: entry.usage.input,
          output: entry.usage.output,
          cacheRead: entry.usage.cacheRead,
          cacheWrite: entry.usage.cacheWrite,
        },
        error: entry.error,
      };
    },

    followup(commandId, text, signal) {
      const entry = runs.get(String(commandId || ''));
      if (!entry) return { ok: false, error: 'unknown ask' };
      if (!entry.childId || !entry.parent) return { ok: false, error: 'side thread not ready yet' };
      const trimmed = String(text || '').trim();
      if (!trimmed) return { ok: false, error: 'empty follow-up' };
      const sig = signal && typeof signal.addEventListener === 'function' ? signal : entry.controller.signal;
      return subagents.followup(entry.parent, entry.childId, [{ type: 'text', text: trimmed }], {
        source: { kind: 'user' },
        signal: sig,
      }).then(() => {
        entry.question = trimmed;
        entry.exchanges.push({ role: 'user', text: trimmed });
        entry.pending += 1;
        entry.error = '';
        if (entry.status === 'done' || entry.status === 'error') entry.status = 'running';
        ensurePoll(entry);
        return { ok: true };
      }).catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    },

    cancel(commandId, signal) {
      const entry = runs.get(String(commandId || ''));
      if (!entry) return { ok: false };
      try { entry.controller.abort(); } catch (err) {}
      if (entry.childId && entry.parent) {
        try { subagents.interrupt(entry.childId, { kind: 'ancestor', agent: entry.parent }); } catch (err) {}
      }
      if (entry.poll) { try { entry.poll(); } catch (err) {} entry.poll = null; }
      entry.status = 'cancelled';
      return { ok: true };
    },
  };

  // 仅在装配了 Typert registry 的 profile（Web）里挂载面板远程；其余 profile 安静跳过。
  ctx.inject(['typert'], (scope) => {
    scope.effect(() => scope.typert.register({
      package: 'dsh-btw',
      face: 'host',
      schemas: [],
      invocations: PANEL_INVOCATIONS,
      model: Object.freeze({ services: Object.freeze([]), events: Object.freeze([]), objects: Object.freeze([]) }),
    }), 'dsh-btw: typert invocations');
    scope.plugin(BtwPanelService, ops);
  });

  // Plugin teardown: stop observers and interrupt in-flight side threads so
  // stopping/updating the plugin never leaves an ask mid-turn.
  ctx.effect(() => () => {
    for (const entry of runs.values()) {
      if (entry.poll) { try { entry.poll(); } catch (err) {} entry.poll = null; }
      try { entry.controller.abort(); } catch (err) {}
      if (entry.childId && entry.parent && entry.status === 'running') {
        try { subagents.interrupt(entry.childId, { kind: 'ancestor', agent: entry.parent }); } catch (err) {}
      }
    }
    runs.clear();
  });
}
