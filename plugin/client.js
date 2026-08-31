/**
 * BTW — Client half.
 *
 * This file is the exact `code.client` value passed to `cordis_define` (a plain
 * JavaScript function body returning a Cordis Plugin; no TS/JSX/bundler). It is
 * not executed directly; load it into the harness with cordis_define/cordis_run
 * (see README).
 *
 * UI contributed:
 *  - `conversation.input.left` id `btw-toggle` — a small "BTW" button in the
 *    composer tool row, visible ONLY while the session agent is busy (the main
 *    send button becomes Stop). Clicking it prefills the composer draft with
 *    "/btw " so the user types the question and hits Enter.
 *  - `conversation.chat.commandview` keyed `btw` — the rich command card for
 *    /btw invocations: a resumable side thread. It renders the question/answer
 *    transcript, token stats (input / cache hit / output), a cancel action
 *    while answering, and a follow-up input that continues the same child
 *    session (`btw/followup`). The card is live-only: on replay (registry miss
 *    from an earlier process) it renders nothing, because the transcript is not
 *    part of the durable main log.
 *
 * All state crossing the RPC boundary is plain scalars (question/status/
 * exchanges/usage/error), never live DSH objects.
 */
return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;

    styles.insert(
      '.btw-tool{height:28px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15));color:var(--dsw-alias-label-secondary,#a0a4ad);font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:4px}' +
      '.btw-tool:hover{color:var(--dsw-alias-label-primary,#e8eaee)}' +
      '.btw-card{display:flex;flex-direction:column;gap:6px;padding:10px 14px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));max-width:min(680px,82%)}' +
      '.btw-card-head{font-size:12px;font-weight:600;color:var(--dsw-alias-label-caption,#7c818c)}' +
      '.btw-card-you{font-size:13px;color:var(--dsw-alias-label-secondary,#a0a4ad);word-break:break-word}' +
      '.btw-card-a{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e8eaee);white-space:pre-wrap;word-break:break-word}' +
      '.btw-card-run{font-size:12px;color:var(--dsw-alias-state-business-primary,#2b6de8)}' +
      '.btw-card-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}' +
      '.btw-card-cx{font-size:12px;color:var(--dsw-alias-label-caption,#7c818c)}' +
      '.btw-card-cancel{align-self:flex-start;border:none;background:none;color:var(--dsw-alias-label-caption,#7c818c);font-size:11px;cursor:pointer;padding:0;text-decoration:underline}' +
      '.btw-card-stats{font-size:11px;color:var(--dsw-alias-label-caption,#7c818c)}' +
      '.btw-card-inputrow{display:flex;gap:8px;align-items:center}' +
      '.btw-card-input{flex:1;min-width:0;background:var(--dsw-specific-input-major,#1b1e24);color:var(--dsw-alias-label-primary,#e8eaee);border:1px solid var(--dsw-alias-border-l2,#383d48);border-radius:8px;padding:5px 10px;font-size:13px;outline:none}' +
      '.btw-card-input:focus{border-color:var(--dsw-alias-state-business-primary,#2b6de8)}' +
      '.btw-card-send{border:none;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;background:var(--dsw-alias-button-info-fill,#2b6de8);color:#fff}' +
      '.btw-card-send:disabled{opacity:.5;cursor:default}'
    );

    function formatStats(usage) {
      const parts = [];
      if (usage.input > 0) parts.push('in ' + usage.input);
      if (usage.cacheRead > 0) parts.push('cache hit ' + usage.cacheRead);
      if (usage.output > 0) parts.push('out ' + usage.output);
      if (usage.cacheWrite > 0) parts.push('write ' + usage.cacheWrite);
      return parts.join(' \u00b7 ');
    }

    // Command card: a resumable side thread. Polls the Host registry; pauses
    // polling once the outcome is terminal (a follow-up restarts it) and stops
    // entirely on a registry miss (replayed ask -> renders nothing).
    function BtwCard(props) {
      const node = props.node;
      const [state, setState] = React.useState(null);
      const [checked, setChecked] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const intervalRef = React.useRef(null);
      const pollRef = React.useRef(() => {});
      React.useEffect(() => {
        let disposed = false;
        const poll = () => {
          host.call('btw/status', { commandId: node.commandId }).then((value) => {
            if (disposed) return;
            setChecked(true);
            if (value === null || value === undefined) {
              setState(null);
              if (intervalRef.current) { intervalRef.current(); intervalRef.current = null; }
            } else {
              setState(value);
              if (value.status !== 'running' && intervalRef.current) {
                intervalRef.current(); intervalRef.current = null;
              }
            }
          }, () => {});
        };
        pollRef.current = poll;
        intervalRef.current = ctx.interval(poll, 700);
        poll();
        return () => { disposed = true; if (intervalRef.current) intervalRef.current(); };
      }, [node.commandId]);

      const submitFollowup = () => {
        const text = draft.trim();
        if (!text) return;
        setDraft('');
        host.call('btw/followup', { commandId: node.commandId, text }).then(() => {
          if (!intervalRef.current) {
            intervalRef.current = ctx.interval(pollRef.current, 700);
            pollRef.current();
          }
        }, () => {});
      };

      // First poll still in flight: the ask was just submitted.
      if (!checked) {
        return React.createElement('div', { className: 'btw-card' },
          React.createElement('div', { className: 'btw-card-head' }, 'BTW'),
          React.createElement('div', { className: 'btw-card-run' }, 'checking\u2026'),
        );
      }
      // Registry miss on replay: the thread is gone, so the card renders nothing.
      if (state === null) return null;

      const usage = state.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const cells = [React.createElement('div', { className: 'btw-card-head', key: 'head' }, 'BTW')];
      (state.exchanges || []).forEach((exchange, i) => {
        if (exchange.role === 'user') {
          cells.push(React.createElement('div', { className: 'btw-card-you', key: 'u' + i }, 'You: ' + exchange.text));
        } else {
          cells.push(React.createElement('div', { className: 'btw-card-a', key: 'a' + i }, exchange.text));
        }
      });
      if (state.status === 'running') {
        cells.push(React.createElement('div', { className: 'btw-card-run', key: 'r' }, 'answering\u2026'));
        cells.push(React.createElement('button', {
          className: 'btw-card-cancel',
          key: 'c',
          onClick: () => host.call('btw/cancel', { commandId: node.commandId }).then(() => {}, () => {}),
        }, 'cancel'));
      } else if (state.status === 'cancelled') {
        cells.push(React.createElement('div', { className: 'btw-card-cx', key: 'c' }, 'cancelled'));
      } else if (state.status === 'error') {
        cells.push(React.createElement('div', { className: 'btw-card-err', key: 'e' }, state.error || 'side ask failed'));
      } else {
        const stats = formatStats(usage);
        if (stats !== '') cells.push(React.createElement('div', { className: 'btw-card-stats', key: 's' }, stats));
        cells.push(React.createElement('div', { className: 'btw-card-inputrow', key: 'f' },
          React.createElement('input', {
            className: 'btw-card-input',
            placeholder: 'follow up\u2026',
            value: draft,
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submitFollowup(); },
          }),
          React.createElement('button', { className: 'btw-card-send', onClick: submitFollowup, disabled: draft.trim() === '' }, 'Ask'),
        ));
      }
      return React.createElement('div', { className: 'btw-card' }, cells);
    }

    // Composer tool-row toggle: visible only while the session agent is busy
    // (the send button becomes Stop). Clicking prefills the draft with "/btw "
    // so the question is typed in the composer and submitted as a command.
    function BtwTool(props) {
      if (!props.session || !props.session.running) return null;
      return React.createElement('button', {
        className: 'btw-tool',
        title: 'Ask a question by the way - the running task is not interrupted',
        onClick: () => { if (props.inputActions && props.inputActions.setDraft) props.inputActions.setDraft('/btw '); },
      }, 'BTW');
    }

    slots.inject('conversation.input.left', () => slots.register(
      { name: 'conversation.input.left', id: 'btw-toggle', order: 10 },
      (props) => React.createElement(BtwTool, { session: props.session, inputActions: props.inputActions }),
    ));

    slots.inject('conversation.chat.commandview', () => slots.register(
      { name: 'conversation.chat.commandview', key: 'btw' },
      (props) => React.createElement(BtwCard, { node: props.node }),
    ));
  },
};
