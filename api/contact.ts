/*
  Contact endpoint: POST /api/contact -> one email through Resend.

  A Vercel Node.js function using the Web Request/Response signature. The
  Resend key is read here, server-side, from RESEND_API_KEY and is never
  logged or echoed. Configuration comes from the environment only:

    RESEND_API_KEY      required   Resend secret
    CONTACT_TO_EMAIL    required   where messages are delivered
    CONTACT_FROM_EMAIL  optional   sender, default "Cuozarsif <contact@cuozarsif.com>"
                                   (the domain must be verified in Resend)
    CONTACT_ORIGINS     optional   comma-separated allowed page origins,
                                   default https://www.cuozarsif.com,https://cuozarsif.com

  Protections, in order: method, origin, body size and shape, honeypot,
  per-address rate limit, field lengths and email syntax, header-safe
  strings. Replies from the inbox go to the visitor (reply_to).
*/

declare const process: { env: Record<string, string | undefined> };

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 4000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;
const DEFAULT_FROM = 'Cuozarsif <contact@cuozarsif.com>';
const DEFAULT_ORIGINS = 'https://www.cuozarsif.com,https://cuozarsif.com';

// Same address, same warm instance: a modest brake on a script hammering
// the endpoint. Not a substitute for an edge rate limit; enough for a
// contact form.
const hits = new Map<string, number[]>();

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function clean(value: unknown, max: number): string {
  // One line, no control characters, trimmed, bounded.
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '';
}

function cleanMultiline(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '').trim().slice(0, max)
    : '';
}

// Strict enough to keep header-breaking input out, loose enough for real
// addresses: one @, no spaces or control characters, a dotted domain.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > RATE_MAX;
}

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }

  const origins = (process.env.CONTACT_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('origin') ?? '';
  if (!origins.includes(origin)) return json(403, { error: 'forbidden' });

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return json(415, { error: 'unsupported_media_type' });
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return json(413, { error: 'too_large' });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: 'too_large' });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  // Honeypot: a field no visitor can see. Anything in it is a bot; answer
  // as if it worked so the bot learns nothing.
  if (typeof body.company === 'string' && body.company.trim() !== '') return json(200, { ok: true });

  const ip = (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return json(429, { error: 'rate_limited' });

  const name = clean(body.name, MAX_NAME);
  const email = clean(body.email, MAX_EMAIL);
  const message = cleanMultiline(body.message, MAX_MESSAGE);
  const problems: string[] = [];
  if (!name) problems.push('name');
  if (!email || !EMAIL.test(email)) problems.push('email');
  if (!message) problems.push('message');
  if (problems.length) return json(422, { error: 'invalid_fields', fields: problems });

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.CONTACT_TO_EMAIL;
  if (!apiKey || !to) {
    console.error('[contact] not configured:', !apiKey ? 'RESEND_API_KEY' : 'CONTACT_TO_EMAIL', 'is missing');
    return json(500, { error: 'not_configured' });
  }
  const from = process.env.CONTACT_FROM_EMAIL || DEFAULT_FROM;

  const text =
    `Name: ${name}\n` +
    `Email: ${email}\n` +
    `\n` +
    `${message}\n` +
    `\n` +
    `--\n` +
    `Sent from the contact form at ${origin}\n`;

  let upstream: Response;
  try {
    upstream = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [to],
        reply_to: email,
        subject: `New message from ${name}`,
        text,
      }),
    });
  } catch (error) {
    console.error('[contact] resend unreachable:', error instanceof Error ? error.message : 'error');
    return json(502, { error: 'delivery_failed' });
  }

  if (!upstream.ok) {
    // Status only. The upstream body may describe our own configuration.
    console.error('[contact] resend responded', upstream.status);
    return json(502, { error: 'delivery_failed' });
  }

  return json(200, { ok: true });
}
