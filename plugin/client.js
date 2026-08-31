/**
 * BTW — Client half.
 *
 * This file is the exact `code.client` value passed to `cordis_define` (a plain
 * JavaScript function body returning a Cordis Plugin; no TS/JSX/bundler). It is
 * not executed directly; load it into the harness with cordis_define/cordis_run
 * (see README).
 *
 * UI contributed:
 *  - `conversation.chat.commandview` keyed `btw` — rich command card for
 *    /btw invocations (question + live status + answer), polling the Host
 *    registry via package-private `host.call('btw/status', …)`.
 *  - `shell.overlay` id `btw-panel` — floating pill while the session agent is
 *    busy; expands to a panel with an input and the ask list (submit routes
 *    through `btw/ask` → the Host's `commands.execute('/btw …')`, so composer
 *    and panel share one code path and both produce the durable command card).
 *  - `conversation.input.left` id `btw-toggle` — composer tool-row toggle.
 *
 * All state crossing the RPC boundary is plain scalars (question/status/
 * answer/error), never live DSH objects.
 */
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;

    const store = { open: false, listeners: new Set() };
    const emitStore = () => { for (const fn of store.listeners) fn(); };
    const togglePanel = () => { store.open = !store.open; emitStore(); };
    const subscribePanel = (fn) => { store.listeners.add(fn); return () => { store.listeners.delete(fn); }; };

    styles.insert(
      '.btw-tool{height:28px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-secondary,#a0a4ad);font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:4px}' +
      '.btw-tool:hover{color:var(--dsw-alias-label-primary,#e8eaee)}' +
      '.btw-tool-open{background:var(--dsw-alias-state-business-primary,#2b6de8);color:#fff}' +
      '.btw-trigger{position:fixed;right:18px;bottom:18px;z-index:60;pointer-events:auto;background:var(--dsw-alias-button-info-fill,#2b6de8);color:#fff;border:none;border-radius:999px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:var(--dsw-shadow-lv2,0 4px 16px rgba(0,0,0,.35))}' +
      '.btw-trigger:hover{background:var(--dsw-alias-button-info-hover,#1f55b8)}' +
      '.btw-panel{position:fixed;right:18px;bottom:54px;z-index:60;pointer-events:auto;width:min(420px,calc(100vw - 36px));max-height:min(60vh,560px);display:flex;flex-direction:column;background:var(--dsw-specific-input-major,#1b1e24);border:1px solid var(--dsw-alias-border-l2,#383d48);border-radius:14px;box-shadow:var(--dsw-shadow-lv2,0 8px 28px rgba(0,0,0,.45));overflow:hidden}' +
      '.btw-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eaee);border-bottom:1px solid var(--dsw-alias-border-l2,#383d48)}' +
      '.btw-close{border:none;background:none;color:var(--dsw-alias-label-caption,#7c818c);font-size:16px;cursor:pointer;padding:0 4px}' +
      '.btw-body{flex:1;min-height:0;overflow-y:auto;padding:8px 14px;display:flex;flex-direction:column;gap:10px}' +
      '.btw-row{border-left:2px solid var(--dsw-alias-state-business-primary,#2b6de8);padding:2px 0 2px 10px;display:flex;flex-direction:column;gap:4px}' +
      '.btw-q{font-size:13px;color:var(--dsw-alias-label-primary,#e8eaee);word-break:break-word}' +
      '.btw-a{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a0a4ad);white-space:pre-wrap;word-break:break-word}' +
      '.btw-run{font-size:12px;color:var(--dsw-alias-state-business-primary,#2b6de8)}' +
      '.btw-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}' +
      '.btw-cx{font-size:12px;color:var(--dsw-alias-label-caption,#7c818c)}' +
      '.btw-cancel{align-self:flex-start;border:none;background:none;color:var(--dsw-alias-label-caption,#7c818c);font-size:11px;cursor:pointer;padding:0;text-decoration:underline}' +
      '.btw-empty{font-size:12px;color:var(--dsw-alias-label-caption,#7c818c);padding:6px 0}' +
      '.btw-inputrow{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2,#383d48)}' +
      '.btw-input{flex:1;min-width:0;background:var(--dsw-specific-input-major,#1b1e24);color:var(--dsw-alias-label-primary,#e8eaee);border:1px solid var(--dsw-alias-border-l2,#383d48);border-radius:8px;padding:6px 10px;font-size:13px;outline:none}' +
      '.btw-input:focus{border-color:var(--dsw-alias-state-business-primary,#2b6de8)}' +
      '.btw-send{border:none;border-radius:8px;padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;background:var(--dsw-alias-button-info-fill,#2b6de8);color:#fff}' +
      '.btw-send:disabled{opacity:.5;cursor:default}' +
      '.btw-card{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));max-width:min(680px,82%)}' +
      '.btw-card-q{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eaee)}' +
      '.btw-card-run{font-size:12px;color:var(--dsw-alias-state-business-primary,#2b6de8)}' +
      '.btw-card-a{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a0a4ad);white-space:pre-wrap;word-break:break-word}' +
      '.btw-card-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}' +
      '.btw-card-cx{font-size:12px;color:var(--dsw-alias-label-caption,#7c818c)}'
    );

    // Command card: question + live status, polling the Host registry. Falls
    // back to the command/done text when the registry entry is gone (plugin
    // restarted).
    function BtwCard(props) {
      const node = props.node;
      const [state, setState] = React.useState(null);
      React.useEffect(() => {
        let disposed = false;
        const poll = () => {
          host.call('btw/status', { commandId: node.commandId }).then((value) => {
            if (!disposed) setState(value === null || value === undefined ? null : value);
          }, () => {});
        };
        poll();
        const dispose = ctx.interval(poll, 700);
        return () => { disposed = true; dispose(); };
      }, [node.commandId]);
      const question = (state && state.question) || String(node.args || '').replace(/^\s+/, '');
      const cells = [React.createElement('div', { className: 'btw-card-q', key: 'q' }, 'BTW \u00b7 ' + question)];
      if (state === null) {
        if (node.outcome && node.outcome.text) cells.push(React.createElement('div', { className: 'btw-card-a', key: 'o' }, node.outcome.text));
      } else if (state.status === 'running') {
        cells.push(React.createElement('div', { className: 'btw-card-run', key: 'r' }, 'answering\u2026'));
      } else if (state.status === 'done') {
        cells.push(React.createElement('div', { className: 'btw-card-a', key: 'a' }, state.answer || ''));
      } else if (state.status === 'cancelled') {
        cells.push(React.createElement('div', { className: 'btw-card-cx', key: 'c' }, 'cancelled'));
      } else {
        cells.push(React.createElement('div', { className: 'btw-card-err', key: 'e' }, state.error || 'side ask failed'));
      }
      return React.createElement('div', { className: 'btw-card' }, cells);
    }

    // Floating pill (shown while the session agent is busy) / panel with input
    // and the ask list.
    function BtwPanel({ useSessions }) {
      const current = useSessions((s) => s.current);
      const busy = useSessions((s) => {
        if (!s.current) return false;
        const summary = s.byId[s.current];
        if (summary && summary.running) return true;
        const jobs = s.jobsBySession[s.current];
        return Array.isArray(jobs) && jobs.some((job) => job && (job.status === 'running' || job.status === 'stopping'));
      });
      const [open, setOpen] = React.useState(store.open);
      const [draft, setDraft] = React.useState('');
      const [rows, setRows] = React.useState([]);
      React.useEffect(() => subscribePanel(() => setOpen(store.open)), []);
      React.useEffect(() => {
        if (!open || !current) return;
        let disposed = false;
        const poll = () => {
          host.call('btw/list', { sessionId: current }).then((value) => {
            if (!disposed && Array.isArray(value)) setRows(value);
          }, () => {});
        };
        poll();
        const dispose = ctx.interval(poll, 900);
        return () => { disposed = true; dispose(); };
      }, [open, current]);
      const submit = () => {
        const q = draft.trim();
        if (!q || !current) return;
        setDraft('');
        host.call('btw/ask', { sessionId: current, question: q }).then(() => {}, () => {});
      };
      const cancel = (commandId) => {
        host.call('btw/cancel', { commandId }).then(() => {}, () => {});
      };
      if (!open) {
        if (!busy) return null;
        return React.createElement('button', {
          className: 'btw-trigger',
          title: 'Ask a question by the way - the running task is not interrupted',
          onClick: togglePanel,
        }, 'BTW');
      }
      return React.createElement('div', { className: 'btw-panel' },
        React.createElement('div', { className: 'btw-head' },
          React.createElement('span', null, 'Ask a question by the way'),
          React.createElement('button', { className: 'btw-close', onClick: togglePanel, title: 'Close' }, '\u00d7'),
        ),
        React.createElement('div', { className: 'btw-body' },
          rows.length === 0
            ? React.createElement('div', { className: 'btw-empty', key: 'empty' }, 'No asks yet.')
            : rows.map((row) => React.createElement('div', { className: 'btw-row', key: row.commandId },
                React.createElement('div', { className: 'btw-q' }, row.question),
                row.status === 'running' ? React.createElement('div', { className: 'btw-run' }, 'answering\u2026') : null,
                row.status === 'done' && row.answer ? React.createElement('div', { className: 'btw-a' }, row.answer) : null,
                row.status === 'cancelled' ? React.createElement('div', { className: 'btw-cx' }, 'cancelled') : null,
                row.status === 'error' ? React.createElement('div', { className: 'btw-err' }, row.error || 'side ask failed') : null,
                row.status === 'running' ? React.createElement('button', { className: 'btw-cancel', onClick: () => cancel(row.commandId) }, 'cancel') : null,
              )),
        ),
        React.createElement('div', { className: 'btw-inputrow' },
          React.createElement('input', {
            className: 'btw-input',
            placeholder: 'ask anything\u2026',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); },
          }),
          React.createElement('button', { className: 'btw-send', onClick: submit, disabled: draft.trim() === '' }, 'Ask'),
        ),
      );
    }

    // Composer tool-row toggle (always available, including while busy).
    function BtwTool() {
      const [open, setOpen] = React.useState(store.open);
      React.useEffect(() => subscribePanel(() => setOpen(store.open)), []);
      return React.createElement('button', {
        className: 'btw-tool' + (open ? ' btw-tool-open' : ''),
        title: 'Ask a question by the way - the running task is not interrupted',
        onClick: togglePanel,
      }, 'BTW');
    }

    slots.inject('conversation.chat.commandview', () => slots.register(
      { name: 'conversation.chat.commandview', key: 'btw' },
      (props) => React.createElement(BtwCard, { node: props.node }),
    ));

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'btw-panel', order: 20 },
      (props) => React.createElement(BtwPanel, { useSessions: props.useSessions }),
    ));

    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'btw-toggle', order: 10 },
      () => React.createElement(BtwTool),
    ));
  },
};
