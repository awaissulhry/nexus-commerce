/**
 * Meta ads step 30 — activeChannelRoutes reads every route of a channel, page by page (a business is never left out
 * because many are connected): the routing index is a double that honours the cursor, the order and the page size.
 */
import { describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, rows: [] as Array<{ workspaceId: string; connectionId: string; externalAccountId: string | null; channelType: string }> }))
vi.mock('../db.js', () => ({
  default: {
    channelAccountRoute: {
      findMany: async (args: { where: { channelType: string; connectionId?: { gt: string } }; take: number }) => {
        h.calls.push(args as never)
        return h.rows
          .filter((r) => r.channelType === args.where.channelType && (!args.where.connectionId || r.connectionId > args.where.connectionId.gt))
          .sort((a, b) => a.connectionId.localeCompare(b.connectionId))
          .slice(0, args.take)
          .map(({ workspaceId, connectionId, externalAccountId }) => ({ workspaceId, connectionId, externalAccountId }))
      },
    },
  },
}))

const { activeChannelRoutes } = await import('./workspace-ingress.js')

describe('activeChannelRoutes', () => {
  it('reads past the first page: 250 Meta routes in two pages, none of another channel', async () => {
    h.rows = [
      ...Array.from({ length: 250 }, (_, i) => ({ workspaceId: `ws-${i}`, connectionId: `conn-${String(i).padStart(3, '0')}`, externalAccountId: null, channelType: 'META' })),
      { workspaceId: 'ws-x', connectionId: 'conn-etsy', externalAccountId: null, channelType: 'ETSY' },
    ]
    const routes = await activeChannelRoutes('META')
    expect(routes).toHaveLength(250)
    expect(new Set(routes.map((r) => r.connectionId)).size).toBe(250)
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]).toMatchObject({ where: { channelType: 'META', workspace: { status: 'active' }, connectionId: { gt: 'conn-199' } }, take: 200 })
  })
})
