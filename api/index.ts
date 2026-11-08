// Vercel Serverless Function entry point. One function serves all four API
// paths; public/ is served by the platform as static assets.
import { handle } from '@hono/node-server/vercel'
import app from '../src/app'

export const config = { runtime: 'nodejs' }

export default handle(app)
