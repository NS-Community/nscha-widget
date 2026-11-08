/**
 * NSCHA HTTP surface.
 *
 *   POST /challenge   mint a signed proof-of-work challenge
 *   POST /redeem      exchange solutions for a short-lived token
 *   POST /verify      server-side token check for the customer's backend
 *   GET  /config      public knobs for the widget
 *
 * CORS is hand-rolled rather than delegated to a middleware so that the
 * ALLOWED_ORIGIN allowlist and the no-store policy are applied to *every*
 * response, including 4xx/5xx. The widget lives on a different origin from
 * the site embedding it, and its custom scope header triggers a preflight.
 */

import { Hono, type Context } from 'hono'
import {
  createChallenge,
  isConfigured,
  normalizeScope,
  originAllowed,
  publicConfig,
  readConfig,
  redeemChallenge,
  verifyToken,
} from './protocol'

const app = new Hono()

function replyHeaders(c: Context): Record<string, string> {
  const origin = c.req.header('origin') || ''
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
  if (origin && originAllowed(readConfig(), origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers['Vary'] = 'Origin'
  }
  return headers
}

function json(c: Context, data: unknown, status: number = 200) {
  return c.json(data, status as 200, replyHeaders(c))
}

/** Every request from an unregistered origin is refused before any work. */
app.use('*', async (c, next) => {
  const cfg = readConfig()
  const origin = c.req.header('origin') || ''

  if (!originAllowed(cfg, origin)) {
    return json(c, { error: '来源未被允许' }, 403)
  }

  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      ...replyHeaders(c),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-captcha-scope',
      'Access-Control-Max-Age': '600',
    }
    return c.body(null, 204, headers)
  }
  await next()
})

function requireScope(c: Context): string | null {
  const raw = c.req.header('x-captcha-scope') || ''
  return normalizeScope(readConfig(), raw)
}

app.post('/challenge', async (c) => {
  const cfg = readConfig()
  if (!isConfigured(cfg)) return json(c, { error: '验证服务未配置' }, 503)
  const scope = requireScope(c)
  if (!scope) return json(c, { error: '未登记的用途' }, 400)
  try {
    const challenge = await createChallenge(cfg, scope)
    return json(c, challenge)
  } catch {
    return json(c, { error: '挑战签发失败' }, 500)
  }
})

app.post('/redeem', async (c) => {
  const cfg = readConfig()
  if (!isConfigured(cfg)) return json(c, { error: '验证服务未配置' }, 503)
  const scope = requireScope(c)
  if (!scope) return json(c, { error: '未登记的用途' }, 400)

  let body: Record<string, unknown>
  try {
    body = await c.req.json()
  } catch {
    return json(c, { success: false, error: '请求体无效' }, 400)
  }

  const result = await redeemChallenge(cfg, body as never, scope)
  if (!result.ok) {
    // The reason is logged for operators but never leaked to the caller.
    console.warn(`[nscha] redeem rejected reason=${result.reason} scope=${scope}`)
    return json(c, { success: false, error: '验证未通过' }, 400)
  }
  return json(c, { success: true, token: result.token, expires: result.expires })
})

/**
 * The one endpoint the customer's own backend calls. Put it before you touch
 * a database or send mail — a failed check should cost the server nothing.
 */
app.post('/verify', async (c) => {
  const cfg = readConfig()
  if (!isConfigured(cfg)) return json(c, { ok: false }, 503)

  let body: { token?: string; scope?: string }
  try {
    body = await c.req.json()
  } catch {
    return json(c, { ok: false }, 400)
  }
  const scope = normalizeScope(cfg, body.scope || '') || ''
  if (!scope) return json(c, { ok: false }, 403)

  const verdict = await verifyToken(cfg, body.token || '', scope)
  if (!verdict.ok) {
    console.warn(`[nscha] verify rejected reason=${verdict.reason} scope=${scope}`)
    // Uniform 403: never tell the caller whether the signature, scope or TTL
    // was the reason. Fine-grained errors help probe the implementation.
    return json(c, { ok: false }, 403)
  }
  return json(c, { ok: true })
})

app.get('/config', (c) => json(c, publicConfig(readConfig())))

app.get('/health', (c) => json(c, { ok: true, configured: isConfigured(readConfig()) }))

export default app
