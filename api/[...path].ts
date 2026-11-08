/**
 * Vercel Serverless Function entry (catch-all for /api/*).
 *
 * vercel.json rewrites the five short public paths (/challenge, /redeem,
 * /verify, /config, /health) to /api/<same-name> so that one function owns
 * them all. Depending on the platform's routing internals the function may
 * observe either the original path or the rewrite destination; the Hono app
 * is authored against the short paths, so normalise both shapes here rather
 * than duplicating every route under two prefixes.
 */
import { handle } from '@hono/node-server/vercel'
import app from '../src/app'

type VercelArgs = Parameters<ReturnType<typeof handle>>

const handler = handle(app)

export default function (incoming: VercelArgs[0], outgoing: VercelArgs[1]) {
  const url = incoming.url
  if (url && url.startsWith('/api/')) {
    incoming.url = url.slice(4) || '/'
  }
  return handler(incoming, outgoing)
}
