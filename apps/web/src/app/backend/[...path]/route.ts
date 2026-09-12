import { proxyBackend } from '@/lib/workspaces/api-proxy'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (process.env.NEXT_PUBLIC_WORKSPACES_ENABLED !== '1') return new Response(null, { status: 404 })
  const { path } = await context.params
  if (path[0] !== 'api') return new Response(null, { status: 404 })
  return proxyBackend(request, path)
}
export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE, handle as OPTIONS }
