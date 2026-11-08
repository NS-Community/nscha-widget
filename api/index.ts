// Vercel Serverless Function entry point. One function serves all five API
// paths; public/ is served by the platform as static assets. The Node.js
// runtime is auto-detected from the .ts file in api/ — no runtime override.
import { handle } from '@hono/node-server/vercel'
import app from '../src/app'

export default handle(app)
