/**
 * BTW — Host half.
 *
 * This file is the exact `code.host` value passed to `cordis_define` (a plain
 * JavaScript function body returning a Cordis Plugin). It is not executed
 * directly; load it into the harness with cordis_define/cordis_run (see README).
 *
 * What it does:
 *  - registers the `/btw` human command. The command lifecycle (`command/run` +
 *    `command/done`) is log-only and NEVER enters the model surface, so the main
 *    conversation's prompt and provider prefix cache stay untouched.
 *  - spawns each side ask as a forked subagent (`subagents.start('fork', …)`):
 *    a separate child session seeded with the parent's completed-turn prefix
 *    (the exact message history the parent already sent → provider prefix cache
 *    covers it), restricted to a read-only toolset via `toolFilter` so it cannot
 *    race the main task's file writes.
 *  - exposes package-private RPC for the Client: btw/status, btw/ask, btw/list,
 *    btw/cancel.
 */
return {
  inject: ['commands', 'subagents', 'agents'],
  apply(ctx) {
    const commands = ctx.commands;
    const subagents = ctx.subagents;
    const agents = ctx.agents;
    const jobs = ctx.get('jobs');
    const tools = ctx.get('tools');

    const SAFE_TOOLS = ['read', 'glob', 'grep', 'web_search', 'read_image', 'skill'];
    const runs = new Map();

    // The Host sandbox exposes no AbortController/AbortSignal globals (only ctx,
    // harness, console, btoa, atob, TextEncoder, TextDecoder). Signals flow in
    // from UI/tool contexts; here we use a never-aborting stub wherever an
    // AbortSignal is required (commands.execute, subagents.start) and cancel
    // explicitly via SubagentRun.dispose().
    const NEVER_ABORT = Object.freeze({
      aborted: false,
      reason: undefined,
      addEventListener() {},
      removeEventListener() {},
    });

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
      const allow = known ? SAFE_TOOLS.filter((name) => known.has(name)) : SAFE_TOOLS.slice();
      if (allow.length === 0) {
        console.warn('btw: no safe read-only tools resolvable; child runs without a tool filter');
        return null;
      }
      return { allow };
    }

    function spawnAsk(agent, commandId, question) {
      const entry = {
        commandId,
        sessionId: agent.session.id,
        question,
        status: 'running',
        answer: '',
        error: '',
        childId: null,
        dispose: null,
      };
      runs.set(commandId, entry);
      const preamble = buildPreamble(agent);
      const prompt =
        'Answer this side question ("by the way") directly and concisely, while the user\'s main task keeps running. ' +
        'Use read or search tools only if needed; do not modify anything.' +
        (preamble ? '\n\nCurrent context of the main conversation:\n' + preamble : '') +
        '\n\n' + question;
      const toolFilter = computeToolFilter();
      subagents.start('fork', {
        label: 'BTW: ' + excerpt(question, 48),
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal: NEVER_ABORT,
        ...(toolFilter ? { toolFilter } : {}),
      }).then((run) => {
        entry.childId = run.id;
        entry.dispose = () => run.dispose();
        run.result.then((res) => {
          if (entry.status === 'cancelled') return;
          if (res.stopReason === 'completed') {
            entry.status = 'done';
            entry.answer = textOf(res.output);
          } else if (res.stopReason === 'aborted') {
            entry.status = 'cancelled';
          } else {
            entry.status = 'error';
            entry.error = res.diagnostic || ('side agent stopped: ' + res.stopReason);
          }
        }, (err) => {
          if (entry.status === 'cancelled') return;
          entry.status = 'error';
          entry.error = err instanceof Error ? err.message : String(err);
        });
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

    ctx.effect(() => harness.handle('btw/status', (args) => {
      const entry = runs.get(String((args && args.commandId) || ''));
      if (!entry) return null;
      return { status: entry.status, question: entry.question, answer: entry.answer, error: entry.error };
    }));

    ctx.effect(() => harness.handle('btw/ask', async (args) => {
      const sessionId = String((args && args.sessionId) || '');
      const question = String((args && args.question) || '').trim();
      const agent = agents.get(sessionId);
      if (!agent) return { ok: false, error: 'no live agent for this session' };
      if (!question) return { ok: false, error: 'empty question' };
      const execution = await commands.execute(agent, '/btw ' + question, [], NEVER_ABORT);
      if (!execution) return { ok: false, error: 'btw command unavailable' };
      return { ok: true, commandId: execution.commandId };
    }));

    ctx.effect(() => harness.handle('btw/list', (args) => {
      const sessionId = String((args && args.sessionId) || '');
      return Array.from(runs.values())
        .filter((entry) => entry.sessionId === sessionId)
        .slice(-20)
        .map((entry) => ({ commandId: entry.commandId, status: entry.status, question: entry.question, answer: entry.answer, error: entry.error }));
    }));

    ctx.effect(() => harness.handle('btw/cancel', (args) => {
      const entry = runs.get(String((args && args.commandId) || ''));
      if (!entry) return { ok: false };
      if (entry.dispose) { try { entry.dispose().catch(() => {}); } catch (err) {} }
      entry.status = 'cancelled';
      return { ok: true };
    }));

    // Plugin teardown: cancel every in-flight child so stopping/updating the
    // plugin never leaves a side agent running.
    ctx.effect(() => () => {
      for (const entry of runs.values()) {
        if (entry.dispose) { try { entry.dispose().catch(() => {}); } catch (err) {} }
      }
      runs.clear();
    });
  },
};
