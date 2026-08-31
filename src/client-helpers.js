/**
 * Pure client helpers for dsh-btw (remote descriptors, zod schemas, envelope
 * unwrapping, stats formatting), extracted so they can be unit-tested without
 * a browser. The Client half (src/client.js) imports these; tests import them
 * directly. Only depends on zod.
 */
import { z } from 'zod';

export const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const commandIdParam = Object.freeze({
  name: 'commandId',
  wire: 'commandId',
  source: 'json',
  codec: Object.freeze({ mode: 'strict', typeSymbol: 'dsh-btw/types#commandId', schema: z.string() }),
  acceptsUndefined: true,
});
export const textParam = Object.freeze({
  name: 'text',
  wire: 'text',
  source: 'json',
  codec: Object.freeze({ mode: 'strict', typeSymbol: 'dsh-btw/types#text', schema: z.string() }),
  acceptsUndefined: true,
});

export const statusSchema = z.object({
  status: z.string(),
  question: z.string(),
  exchanges: z.array(z.object({ role: z.string(), text: z.string() })),
  // Optional so an older host (without streaming) still validates; the card falls back to ''.
  streamingText: z.string().optional(),
  streamingReasoning: z.string().optional(),
  resident: z.boolean().optional(),
  usage: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
  error: z.string(),
}).nullable();

export const okSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

/** One strict-codec remote descriptor (same wire contract as the host's src-json PANEL_INVOCATIONS). */
export function descriptor(method, parameters, schema, cancellation) {
  return Object.freeze({
    id: `dsh-btw#btwPanel/${method}`,
    service: 'btwPanel',
    namespace: 'btwPanel',
    method,
    invocation: Object.freeze({ kind: 'direct' }),
    parameters: Object.freeze(parameters.map((p) => Object.freeze({ ...p, codec: Object.freeze(p.codec) }))),
    ...(cancellation ? { cancellation: Object.freeze({ parameter: 'signal' }) } : {}),
    result: Object.freeze({ mode: 'strict', typeSymbol: `dsh-btw/types#${method}Result`, schema }),
  });
}

/** The client-side btwPanel remote contribution handed to `ctx.remote.$mount`. */
export const BTW_REMOTE = Object.freeze({
  package: 'dsh-btw',
  descriptors: Object.freeze([
    descriptor('status', [commandIdParam], statusSchema, false),
    descriptor('followup', [commandIdParam, textParam], okSchema, true),
    descriptor('cancel', [commandIdParam], okSchema, true),
  ]),
});

/** Unwrap the `{ok, value}` RPC envelope; throws on `ok: false`. */
export function unwrap(env) {
  if (!env || env.ok === false) {
    throw new Error(env && env.error ? String(env.error) : 'btwPanel call failed');
  }
  return env.value;
}

/** Compact token-stats line; non-zero components only, joined by ' · '. */
export function formatStats(usage) {
  const parts = [];
  if (usage.input > 0) parts.push('in ' + usage.input);
  if (usage.cacheRead > 0) parts.push('cache hit ' + usage.cacheRead);
  if (usage.output > 0) parts.push('out ' + usage.output);
  if (usage.cacheWrite > 0) parts.push('write ' + usage.cacheWrite);
  return parts.join(' \u00b7 ');
}
