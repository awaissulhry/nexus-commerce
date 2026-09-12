/**
 * PES.6 — a MINIMAL API for UI verification.
 *
 * Deliberately NOT `npm run dev`: that boots every cron against the production Neon DB and makes
 * a second cron runner competing with Railway (reference_local_api_duplicates_prod_crons). This
 * registers ONLY the PES.6 plugin plus the two existing rule-write routes the drawer uses, so
 * nothing scheduled starts. Reads are real prod data; the only writes possible are the ones the
 * page itself makes, and those are the ones under test.
 */
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config as loadEnv } from 'dotenv'
loadEnv({ path: new URL('../../.env', import.meta.url).pathname })

const app = Fastify({ logger: false })
await app.register(cors, {
  origin: (origin, cb) => cb(null, true),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
})

const { default: channelMapping } = await import('../src/routes/channel-mapping.routes.js')
const { default: pimMapping } = await import('../src/routes/pim-mapping.routes.js')
await app.register(channelMapping, { prefix: '/api' })
await app.register(pimMapping, { prefix: '/api' })

// 🔴 PORTS ARE SHARED STATE ON THIS MACHINE. :8080 and :8090 are BOTH taken — :8090 is the
// hub's designated shared local API. Binding 127.0.0.1 on a port another process holds on *
// lets BOTH binds succeed and silently steals every localhost request, 404-ing their routes;
// that is exactly what this script did on :8080 and it cost PES.3 a false-negative
// investigation. So: this lane owns :8095, and you `lsof -ti :<port>` BEFORE you bind.
const port = Number(process.env.PES6_PORT ?? 8095)
const held = await import('node:child_process').then((cp) =>
  // The arbitration's standard form: LISTENERS only, numeric ports. `lsof -ti :<port>` also
  // matches client sockets, so it can refuse to start over a connection that is merely open.
  cp.execSync(`lsof -iTCP:${port} -sTCP:LISTEN -Pn -t || true`, { encoding: 'utf8' }).trim(),
)
if (held) {
  console.error(`[pes6] refusing to start: port ${port} is already held by pid ${held}.`)
  process.exit(1)
}
await app.listen({ port, host: '127.0.0.1' })
console.log(`[pes6] verification API listening on http://127.0.0.1:${port} — NO crons registered`)
