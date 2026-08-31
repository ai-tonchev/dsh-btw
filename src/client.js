/**
 * dsh-btw — Client half (browser bundle entry).
 *
 * Mounted on the Web profile (`dsh.client.platform: web`). Contributes:
 *  - `conversation.input.left` id `btw-toggle` — a small "BTW" button in the
 *    composer tool row, visible ONLY while the session agent is busy (the main
 *    send button becomes Stop). Clicking it prefills the composer draft with
 *    "/btw " so the user types the question and hits Enter.
 *  - `conversation.chat.commandview` keyed `btw` — the resumable command card:
 *    Q&A transcript, token stats (input / cache hit / output), a cancel action
 *    while answering, and a follow-up input that continues the same child
 *    session. The card is live-only: on replay (registry miss from an earlier
 *    process) it renders nothing, because the transcript is not part of the
 *    durable main log.
 *
 * The `btwPanel` remote namespace is mounted client-side via
 * `ctx.remote.$mount(BTW_REMOTE)` (strict zod codecs, mirroring the host's
 * src-json descriptors on the same wire contract), then injected as
 * `remote.btwPanel`; every call unwraps the `{ok, value}` RPC envelope and
 * re-reads the namespace lazily. Styles are injected as a scoped
 * `<style data-dsh-btw>` element and removed with the plugin's lifetime.
 *
 * This file is bundled to lib/client.js by scripts/build-client.mjs (esbuild +
 * the Web shell's ModuleLoader handshake); the committed bundle is what the
 * profile installs.
 */
import * as React from 'react';
import pkg from '../package.json' with { type: 'json' };
import { ZERO_USAGE, commandIdParam, textParam, statusSchema, okSchema, descriptor, BTW_REMOTE, unwrap, formatStats } from './client-helpers.js';

export const name = pkg.name;
export const inject = ['slots', 'remote', 'timer'];

export function apply(ctx) {
  const slots = ctx.get('slots');
  if (slots === undefined) return;

  ctx.effect(() => installPanelStyles(), 'dsh-btw: stylesheet');

  // apply must stay synchronous: the $mount runs inside this effect factory,
  // completes asynchronously, and failures land in console.error; the
  // ctx.inject below waits for the namespace before registering UI.
  ctx.effect(() => {
    let mounted = null;
    let pending = true;
    let unloaded = false;
    void (async () => {
      try {
        mounted = await ctx.remote.$mount(BTW_REMOTE);
      } catch (error) {
        console.error('dsh-btw: btwPanel mount failed:', error);
      }
      pending = false;
      if (unloaded) void mounted?.();
    })();
    return () => {
      unloaded = true;
      if (!pending) void mounted?.();
    };
  }, 'dsh-btw: remote contribution');

  ctx.inject(['remote.btwPanel'], (scope) => {
    // Lazy namespace accessor: re-read every call (the namespace is mounted
    // by the contribution above; never capture it once at render time).
    const ns = () => scope.remote.btwPanel;

    // Command card: a resumable side thread. Polls the btwPanel remote;
    // pauses once the outcome is terminal (a follow-up restarts it), stops on
    // a registry miss (replayed ask -> renders nothing), and surfaces an error
    // after repeated failures instead of hanging on "checking…".
    function BtwCard(props) {
      const node = props.node;
      const [state, setState] = React.useState(null);
      const [checked, setChecked] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const intervalRef = React.useRef(null);
      const pollRef = React.useRef(() => {});

      React.useEffect(() => {
        let disposed = false;
        let failures = 0;
        const stop = () => { if (intervalRef.current) { intervalRef.current(); intervalRef.current = null; } };
        const fail = (error) => {
          if (disposed) return;
          failures += 1;
          if (failures >= 10) {
            setChecked(true);
            setState({ status: 'error', question: '', exchanges: [], usage: ZERO_USAGE, error: 'side thread unavailable: ' + String(error && error.message ? error.message : error) });
            stop();
          }
        };
        const poll = () => {
          let namespace;
          try { namespace = ns(); } catch (error) { return fail(error); }
          if (!namespace) return fail(new Error('btwPanel namespace not mounted'));
          namespace.status(node.commandId).then((env) => {
            if (disposed) return;
            let value;
            try { value = unwrap(env); } catch (error) { return fail(error); }
            failures = 0;
            setChecked(true);
            if (value === null) {
              setState(null);
              stop();
            } else {
              setState(value);
              if (value.status !== 'running') stop();
            }
          }, (error) => fail(error));
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
        try {
          ns().followup(node.commandId, text, new AbortController().signal).then((env) => {
            try { unwrap(env); } catch (error) { /* surfaced by the next poll */ }
            if (!intervalRef.current) {
              intervalRef.current = ctx.interval(pollRef.current, 700);
              pollRef.current();
            }
          }, () => {});
        } catch (error) { /* surfaced by the next poll */ }
      };

      const cancelAsk = () => {
        try { ns().cancel(node.commandId, new AbortController().signal).then(() => {}, () => {}); } catch (error) { /* ignore */ }
      };

      // First poll still in flight: the ask was just submitted.
      if (!checked) {
        return React.createElement('div', { className: 'btw-card', 'data-dsh-btw': '' },
          React.createElement('div', { className: 'btw-card-head' }, 'BTW'),
          React.createElement('div', { className: 'btw-card-run' }, 'checking\u2026'),
        );
      }
      // Registry miss on replay: the thread is gone, so the card renders nothing.
      if (state === null) return null;

      const usage = state.usage || ZERO_USAGE;
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
        cells.push(React.createElement('button', { className: 'btw-card-cancel', key: 'c', onClick: cancelAsk }, 'cancel'));
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
      return React.createElement('div', { className: 'btw-card', 'data-dsh-btw': '' }, cells);
    }

    // Composer tool-row toggle: visible only while the session agent is busy
    // (the send button becomes Stop). Clicking prefills the draft with "/btw ".
    function BtwTool(props) {
      if (!props.session || !props.session.running) return null;
      return React.createElement('button', {
        className: 'btw-tool',
        'data-dsh-btw': '',
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
  });
}
