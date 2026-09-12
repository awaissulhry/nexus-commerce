import { getBackendUrl } from '../backend-url'

const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']
export async function proxyBackend(request: Request, path: string[]): Promise<Response> {
  if (path[0] !== 'api' || path.some(segment => segment === '.' || segment === '..' || /[\\/\u0000-\u001f]/.test(segment))) return Response.json({ error: 'Invalid API path.' }, { status: 400 })
  const incoming = new URL(request.url)
  const targetBase = process.env.NEXUS_API_PROXY_TARGET ?? getBackendUrl()
  const target = new URL(`/${path.map(encodeURIComponent).join('/')}${incoming.search}`, targetBase)
  if (target.origin === incoming.origin) return Response.json({ error: 'API proxy is not configured.' }, { status: 503 })
  const headers = new Headers(request.headers)
  for (const name of HOP) headers.delete(name)
  for (const name of [...headers.keys()]) if (name.startsWith('x-nexus-page-') || name.startsWith('x-forwarded-')) headers.delete(name)
  const response = await fetch(target, {
    method: request.method, headers, cache: 'no-store', redirect: 'manual', signal: request.signal,
    ...(!['GET', 'HEAD'].includes(request.method) ? { body: request.body, duplex: 'half' } : {}),
  } as RequestInit)
  const outgoing = new Headers(response.headers)
  for (const name of [...HOP, 'content-encoding', 'set-cookie']) outgoing.delete(name)
  for (const cookie of response.headers.getSetCookie()) outgoing.append('set-cookie', cookie.replace(/Path=\/api\/cx\/callback(?=;|$)/i, 'Path=/backend/api/cx/callback'))
  outgoing.set('Cache-Control', 'private, no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
}
