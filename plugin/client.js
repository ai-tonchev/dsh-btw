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
 *    /btw invocations (question + live status + answer + cancel), polling the
 *    Host registry via package-private `host.call('btw/status', …)`. The card
 *    is live-only: on replay (registry miss from an earlier process) it renders
 *    nothing, because the answer text is not part of the durable log.
 *
 * All state crossing the RPC boundary is plain scalars (question/status/
 * answer/error), never live DSH objects.
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
      '.btw-card-q{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e8eaee)}' +
      '.btw-card-run{font-size:12px;color:var(--dsw-alias-state-business-primary,#2b6de8)}' +
      '.btw-card-a{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#a0a4ad);white-space:pre-wrap;word-break:break-word}' +
      '.btw-card-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#e5484d)}' +
      '.btw-card-cx{font-size:12px;color:var(--dsw-alias-label-caption,#7c818c)}' +
      '.btw-card-cancel{align-self:flex-start;border:none;background:none;color:var(--dsw-alias-label-caption,#7c818c);font-size:11px;cursor:pointer;padding:0;text-decoration:underline}'
    );

    // Command card: question + live status + answer, polling the Host registry.
    // The card is LIVE-ONLY: once the registry no longer has the entry (the ask
    // is replayed from an earlier process, so the answer is gone), the card
    // renders nothing instead of a dead card with a fake outcome. Polling stops
    // once the outcome is known (registry miss or terminal status).
    function BtwCard(props) {
      const node = props.node;
      const [state, setState] = React.useState(null);
      const [checked, setChecked] = React.useState(false);
      React.useEffect(() => {
        let disposed = false;
        let interval = null;
        const stop = () => { if (interval) { interval(); interval = null; } };
        const poll = () => {
          host.call('btw/status', { commandId: node.commandId }).then((value) => {
            if (disposed) return;
            setChecked(true);
            if (value === null || value === undefined) {
              setState(null);
              stop();
            } else {
              setState(value);
              if (value.status !== 'running') stop();
            }
          }, () => {});
        };
        interval = ctx.interval(poll, 700);
        poll();
        return () => { disposed = true; if (interval) interval(); };
      }, [node.commandId]);

      // First poll still in flight: the ask was just submitted; show a brief
      // placeholder until the registry answers.
      if (!checked) {
        return React.createElement('div', { className: 'btw-card' },
          React.createElement('div', { className: 'btw-card-q' }, 'BTW \u00b7 ' + String(node.args || '').replace(/^\s+/, '')),
          React.createElement('div', { className: 'btw-card-run' }, 'checking\u2026'),
        );
      }
      // Registry miss on replay: the answer is gone, so the card renders nothing.
      if (state === null) return null;

      const question = state.question || String(node.args || '').replace(/^\s+/, '');
      const cells = [React.createElement('div', { className: 'btw-card-q', key: 'q' }, 'BTW \u00b7 ' + question)];
      if (state.status === 'running') {
        cells.push(React.createElement('div', { className: 'btw-card-run', key: 'r' }, 'answering\u2026'));
        cells.push(React.createElement('button', {
          className: 'btw-card-cancel',
          key: 'c',
          onClick: () => host.call('btw/cancel', { commandId: node.commandId }).then(() => {}, () => {}),
        }, 'cancel'));
      } else if (state.status === 'done') {
        cells.push(React.createElement('div', { className: 'btw-card-a', key: 'a' }, state.answer || ''));
      } else if (state.status === 'cancelled') {
        cells.push(React.createElement('div', { className: 'btw-card-cx', key: 'c' }, 'cancelled'));
      } else {
        cells.push(React.createElement('div', { className: 'btw-card-err', key: 'e' }, state.error || 'side ask failed'));
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
