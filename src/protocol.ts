/**
 * NSCHA protocol core — stateless proof-of-work.
 *
 * Three legs, no database, no shared state, no third-party call:
 *
 *   1. POST /challenge → a short-lived signed challenge { c, s, d }
 *   2. the browser grinds SHA-256 locally in a Worker, then
 *      POST /redeem { token, solutions } → a short-lived redeem token
 *   3. POST /verify { token, scope } → { ok: true } / 403
 *
 * The challenge is a signed JWT minted by this process, so verification is
 * pure cryptography and runs inside a serverless function. The only piece of
 * state is the in-process nonce set, which bounds a single challenge to a
 * single redemption *per instance*; the short TTL and the signed scope do the
 * real work across instances. That boundary is intentional and documented.
 */

import { generateChallenge, validateChallenge } from 'capjs-core'
import { sign, verify } from 'hono/jwt'

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name])
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function listEnv(name: string, fallback: string): string[] {
  const raw = process.env[name] || fallback
  return raw
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
}

export interface NschaConfig {
  secret: string
  tokenSecret: string
  count: number
  size: number
  difficulty: number
  expiresSeconds: number
  tokenTtlSeconds: number
  scopes: string[]
  allowedOrigins: string[]
  label: string
  link: string
}

/**
 * Read env on every call rather than at module evaluation. Serverless
 * platforms inject env at cold start, and ESM hoisting means a top-level read
 * can otherwise capture an empty string forever.
 */
export function readConfig(): NschaConfig {
  const secret = (process.env.CAP_SECRET || '').trim()
  return {
    secret,
    tokenSecret: (process.env.CAP_TOKEN_SECRET || '').trim() || secret,
    count: intEnv('CAP_CHALLENGE_COUNT', 20, 4, 200),
    size: intEnv('CAP_CHALLENGE_SIZE', 32, 16, 64),
    difficulty: intEnv('CAP_CHALLENGE_DIFFICULTY', 3, 1, 6),
    expiresSeconds: intEnv('CAP_EXPIRES_SECONDS', 600, 60, 3600),
    tokenTtlSeconds: intEnv('CAP_TOKEN_TTL_SECONDS', 1200, 120, 7200),
    scopes: listEnv('CAP_SCOPES', 'login,register,reset'),
    allowedOrigins: listEnv('ALLOWED_ORIGIN', '*'),
    label: process.env.NSCHA_LABEL || 'NSCHA',
    link: process.env.NSCHA_LINK || 'https://nscha.nsbbs.eu.cc',
  }
}

export function isConfigured(cfg: NschaConfig): boolean {
  return Boolean(cfg.secret)
}

/** Only registered scopes may be minted or verified. Anything else is rejected. */
export function normalizeScope(cfg: NschaConfig, raw: string): string | null {
  const s = (raw || '').trim().toLowerCase()
  return cfg.scopes.includes(s) ? s : null
}

export function originAllowed(cfg: NschaConfig, origin: string): boolean {
  if (cfg.allowedOrigins.includes('*')) return true
  if (!origin) return true // server-to-server calls carry no Origin header
  return cfg.allowedOrigins.includes(origin.toLowerCase())
}

/**
 * One challenge → one redemption, per process. Capped so a busy instance
 * cannot grow without bound; expired entries are swept opportunistically.
 */
const usedNonces = new Map<string, number>()

function consumeNonce(key: string, ttlMs: number): boolean {
  const now = Date.now()
  if (usedNonces.size > 5_000) {
    for (const [k, until] of usedNonces) if (until < now) usedNonces.delete(k)
  }
  if (usedNonces.has(key)) return false
  usedNonces.set(key, now + ttlMs)
  return true
}

export async function createChallenge(cfg: NschaConfig, scope: string) {
  if (!isConfigured(cfg)) throw new Error('not_configured')
  // capjs-core only goes async for its instrumentation path, which we never
  // enable. Awaiting keeps the call site honest about the library contract.
  return await generateChallenge(cfg.secret, {
    challengeCount: cfg.count,
    challengeSize: cfg.size,
    challengeDifficulty: cfg.difficulty,
    expiresMs: cfg.expiresSeconds * 1000,
    scope,
  })
}

export type RedeemOutcome =
  | { ok: true; token: string; expires: number }
  | { ok: false; reason: string }

export async function redeemChallenge(
  cfg: NschaConfig,
  body: {
    token?: string
    solutions?: unknown
    instr?: unknown
    instr_blocked?: boolean
    instr_timeout?: boolean
  },
  scope: string
): Promise<RedeemOutcome> {
  if (!isConfigured(cfg)) return { ok: false, reason: 'not_configured' }

  const result = await validateChallenge(
    cfg.secret,
    {
      token: String(body?.token || ''),
      // The solver returns [{ i, n }, ...]; capjs-core types this as number[].
      solutions: body?.solutions as never,
      instr: body?.instr as never,
      instr_blocked: body?.instr_blocked,
      instr_timeout: body?.instr_timeout,
    },
    {
      scope,
      tokenTtlMs: cfg.tokenTtlSeconds * 1000,
      consumeNonce: (sigHex: string) =>
        consumeNonce(`${scope}:${sigHex}`, cfg.expiresSeconds * 1000),
      // A compact HS256 token carrying only { nscha: true, scope, exp }.
      // The dedicated claim stops an ordinary session JWT from being reused.
      signToken: async ({ scope: s, expires }) =>
        sign(
          { nscha: true, scope: s ?? null, exp: Math.floor(expires / 1000) },
          cfg.tokenSecret,
          'HS256'
        ),
    }
  )

  if (!result.success) {
    return { ok: false, reason: String(result.reason || 'invalid') }
  }
  return { ok: true, token: result.token, expires: result.expires }
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: string }

export async function verifyToken(
  cfg: NschaConfig,
  token: string,
  scope: string
): Promise<VerifyOutcome> {
  const raw = (token || '').trim()
  if (!raw) return { ok: false, reason: 'missing_token' }
  if (!isConfigured(cfg)) return { ok: false, reason: 'not_configured' }

  let payload: Record<string, unknown>
  try {
    payload = (await verify(raw, cfg.tokenSecret, 'HS256')) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'invalid_token' }
  }

  if (payload.nscha !== true) return { ok: false, reason: 'wrong_token_kind' }

  const exp = Number(payload.exp || 0)
  if (!exp || exp * 1000 < Date.now()) return { ok: false, reason: 'expired' }

  if (scope && payload.scope !== scope) {
    return { ok: false, reason: `scope_mismatch:${String(payload.scope)}` }
  }
  return { ok: true }
}

/** Public knobs — never includes either secret. */
export function publicConfig(cfg: NschaConfig) {
  return {
    label: cfg.label,
    link: cfg.link,
    scopes: cfg.scopes,
    challenge: { c: cfg.count, s: cfg.size, d: cfg.difficulty },
    expiresSeconds: cfg.expiresSeconds,
    tokenTtlSeconds: cfg.tokenTtlSeconds,
    configured: isConfigured(cfg),
  }
}
