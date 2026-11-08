// Local development entry point. Production on Vercel uses api/[...path].ts,
// where the platform serves public/ as static files and routes the five API
// paths to the same Hono app via vercel.json rewrites.
import 'dotenv/config'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import app from './app'

// Registered last so the API routes always win over the catch-all.
app.get('/*', serveStatic({ root: './public', index: 'index.html' }))

const port = Number(process.env.PORT) || 8788

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`NSCHA widget service → http://localhost:${info.port}`)
  console.log(`  embed:  <script src="http://localhost:${info.port}/widget.js" defer></script>`)
  console.log(`  demo:   http://localhost:${info.port}/`)
})
