/**
 * CX.1 — connect routes (docs/2026-08-29-cx1-connection-core.md §5).
 *
 *   POST /api/cx/connect/:channel/start   (channelsConnect)  → { authorizeUrl, state }
 *   GET  /api/cx/callback/:channel        (PUBLIC)           → HTML page that reports to the opener and closes
 *
 * The callback lives on the API host: the session cookie set by /start is
 * verified by the same host, the OAuthSession is consumed in one statement, and
 * the catalogue holds one allow-listed redirect URI per channel. The rendered
 * page posts `nexus:channel-connected` to `window.opener` (explicit origin) and
 * on a BroadcastChannel, waits for an ACK, then closes — the popup never
 * navigates Nexus inside itself.
 */

import type { FastifyInstance } from 'fastify'
import { logger } from '../utils/logger.js'
import { tryGetChannelSpec, type ChannelKey } from '../services/cx/catalog.js'
import { complete, OAuthFlowError, start, type Intent } from '../services/cx/oauth.service.js'
import { recordConnectionEvent } from '../services/cx/events.service.js'

const WEB_ORIGIN = (process.env.NEXUS_WEB_URL ?? 'https://nexus-commerce-three.vercel.app').replace(/\/$/, '')

function channelKeyFromParam(p: string): ChannelKey | null {
  const key = p.toUpperCase().replace(/-/g, '_')
  return tryGetChannelSpec(key) ? (key as ChannelKey) : null
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** Design-system-toned page (tokens inlined: the popup has no app shell). */
function callbackPage(input: {
  ok: boolean
  title: string
  body: string
  payload?: Record<string, unknown>
}): string {
  const message = input.payload ? JSON.stringify({ type: 'nexus:channel-connected', ...input.payload }) : 'null'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)} · Nexus</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#111827;--muted:#4b5563;--ok:#15803d;--err:#b91c1c;--border:#e5e7eb}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#161a22;--text:#e5e7eb;--muted:#9ca3af;--ok:#4ade80;--err:#f87171;--border:#2a2f3a}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;min-height:100vh}
main{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px 32px;max-width:440px;width:calc(100% - 48px)}
h1{font-size:18px;margin:0 0 8px}p{margin:0 0 12px;color:var(--muted)}.ok h1{color:var(--ok)}.err h1{color:var(--err)}
a{color:inherit}.small{font-size:12px}
</style></head><body><main class="${input.ok ? 'ok' : 'err'}"><h1>${esc(input.title)}</h1><p>${esc(input.body)}</p>
<p class="small" id="hint">${input.ok ? 'Returning you to Nexus…' : ''}</p>
${input.ok ? '' : `<p class="small"><a href="${esc(WEB_ORIGIN)}/settings/channels">Back to Channels</a></p>`}
</main>
<script>
(function(){
  var msg=${message}; var origin=${JSON.stringify(WEB_ORIGIN)}; var acked=false;
  function done(){ try{window.close()}catch(e){} setTimeout(function(){ if(!window.closed){ var h=document.getElementById('hint'); if(h) h.innerHTML='You can close this window. <a href="'+origin+'/settings/channels">Back to Channels</a>'; } },600); }
  if(!msg){ return; }
  var bc=null; try{ bc=new BroadcastChannel('nexus-oauth'); bc.onmessage=function(e){ if(e.data&&e.data.type==='nexus:ack'){acked=true;done();} }; }catch(e){}
  window.addEventListener('message',function(e){ if(e.origin===origin&&e.data&&e.data.type==='nexus:ack'){acked=true;done();} });
  var notified=false;
  try{ if(window.opener&&!window.opener.closed){ window.opener.postMessage(msg,origin); notified=true; } }catch(e){}
  try{ if(bc){ bc.postMessage(msg); notified=true; } }catch(e){}
  if(!notified){ window.location.replace(origin+'/settings/channels'); return; }
  setTimeout(function(){ if(!acked) done(); },1500);
})();
</script></body></html>`
}

export default async function cxConnectRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { channel: string }; Body: { intent?: Intent; targetConnectionId?: string; region?: string } }>(
    '/cx/connect/:channel/start',
    async (request, reply) => {
      const key = channelKeyFromParam(request.params.channel)
      if (!key) return reply.code(404).send({ error: `Unknown channel ${request.params.channel}` })
      const userId = (request as { authUser?: { id?: string } }).authUser?.id ?? null
      const body = request.body ?? {}
      const intent: Intent = body.intent ?? (body.targetConnectionId ? 'adopt' : 'connect')
      try {
        const r = await start({
          channelKey: key,
          intent,
          targetConnectionId: body.targetConnectionId ?? null,
          region: body.region ?? null,
          actor: { kind: 'operator', userId },
        })
        reply.setCookie(r.cookie.name, r.cookie.value, {
          path: '/api/cx/callback',
          httpOnly: true,
          secure: true,
          sameSite: 'none',
          maxAge: r.cookie.maxAgeSec,
        })
        return reply.send({ success: true, authUrl: r.authorizeUrl, authorizeUrl: r.authorizeUrl, state: r.state, expiresIn: r.expiresInSec })
      } catch (err) {
        if (err instanceof OAuthFlowError) return reply.code(err.status).send({ success: false, error: err.message, code: err.code })
        const message = err instanceof Error ? err.message : String(err)
        logger.error('[cx-connect] start failed', { channel: key, error: message })
        return reply.code(500).send({ success: false, error: message })
      }
    },
  )

  app.get<{ Params: { channel: string }; Querystring: Record<string, string | undefined> }>(
    '/cx/callback/:channel',
    async (request, reply) => {
      const key = channelKeyFromParam(request.params.channel)
      reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Cache-Control', 'no-store')
      if (!key) {
        return reply.code(404).type('text/html').send(callbackPage({ ok: false, title: 'Unknown channel', body: `No connector is registered for "${request.params.channel}".` }))
      }
      const spec = tryGetChannelSpec(key)!
      try {
        const result = await complete({
          channelKey: key,
          query: request.query,
          cookies: (request as { cookies?: Record<string, string | undefined> }).cookies ?? {},
          actorUserId: (request as { authUser?: { id?: string } }).authUser?.id ?? null,
        })
        // The cookie has done its job.
        reply.clearCookie(`nexus_oauth_${request.query.state ?? ''}`, { path: '/api/cx/callback' })
        const who = result.identity?.username ?? result.identity?.userId ?? null
        const drift = result.scopeDrift.length
        return reply.type('text/html').send(
          callbackPage({
            ok: true,
            title: `${spec.displayName} connected`,
            body: `${who ? `Account: ${who}. ` : ''}${result.placement === 'new' ? 'A new account was added.' : result.placement === 'adopt' ? 'The grant was attached to the account you chose.' : 'The existing account was re-authorised.'}${drift ? ` ${drift} permission${drift === 1 ? '' : 's'} could not be granted — see the account card.` : ''}`,
            payload: { channel: spec.channelType, channelKey: key, connectionId: result.connectionId, sellerName: who, placement: result.placement, scopeDrift: result.scopeDrift },
          }),
        )
      } catch (err) {
        if (err instanceof OAuthFlowError) {
          logger.warn('[cx-connect] callback refused', { channel: key, code: err.code })
          return reply.code(err.status).type('text/html').send(callbackPage({ ok: false, title: `${spec.displayName} was not connected`, body: err.message }))
        }
        const message = err instanceof Error ? err.message : String(err)
        logger.error('[cx-connect] callback failed', { channel: key, error: message })
        await recordConnectionEvent({ channelKey: key, type: 'status_change', detail: { oauth: 'callback_failed', error: message } })
        return reply.code(500).type('text/html').send(callbackPage({ ok: false, title: `${spec.displayName} was not connected`, body: 'Something went wrong while finishing the sign-in. The details are in the connection ledger; start the connection again.' }))
      }
    },
  )
}
