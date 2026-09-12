/** Disposable local browser fixture. Never uses the configured catalog database. */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { formulaDatabase } from '../../../apps/api/src/test-support/formula-database.js'
import { withWorkspace } from '@nexus/database/workspace-context'
const database = await formulaDatabase({ maxConnections: 10, port: 4127 })
process.env.DATABASE_URL = database.connectionString
process.env.REDIS_URL = 'redis://127.0.0.1:1'
process.env.NEXUS_KMS_KEY_ID = ''
process.env.NEXUS_AUTH_SESSION_CACHE = '0'
process.env.NEXUS_WORKSPACES_ENABLED = '1'
process.env.COOKIE_SECURE = 'false'
process.env.COOKIE_SAMESITE = 'lax'
process.env.NEXUS_SESSION_CACHE_ENABLED = '0'
process.env.NEXUS_CREDENTIAL_ENC_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.NEXUS_WEB_URL = 'http://127.0.0.1:4126'
process.env.NEXUS_PUBLIC_API_URL = 'http://127.0.0.1:4125'
;(globalThis as any).workspacePrisma = database.client
const { default: Fastify } = await import('fastify')
const { default: cookie } = await import('@fastify/cookie')
const { hashPassword } = await import('../../../apps/api/src/lib/auth/password.js')
const { createWorkspaceService } = await import('../../../apps/api/src/services/workspace.service.js')
const { workspaceHook } = await import('../../../apps/api/src/lib/workspace-hook.js')
const { rbacHook } = await import('../../../apps/api/src/lib/auth/rbac-hook.js')
const { default: authRoutes } = await import('../../../apps/api/src/routes/auth.routes.js')
const { default: workspacesRoutes } = await import('../../../apps/api/src/routes/workspaces.routes.js')
const { default: invitationsRoutes } = await import('../../../apps/api/src/routes/workspace-invitations.routes.js')
const { default: profileRoutes } = await import('../../../apps/api/src/routes/profile.routes.js')
const { default: connectionsRoutes } = await import('../../../apps/api/src/routes/connections.routes.js')
const { default: cxConnectionsRoutes } = await import('../../../apps/api/src/routes/cx-connections.routes.js')
const { default: accountsRoutes } = await import('../../../apps/api/src/routes/accounts.routes.js')
const db = database.client
const ownerRole = await db.role.create({ data: { key: 'OWNER', name: 'Owner', permissions: [], isSystem: true } })
await db.role.create({ data: { key: 'VIEWER', name: 'Viewer', permissions: ['pages.dashboard', 'pages.products', 'products.view'], isSystem: true } })
const owner = await db.userProfile.create({ data: { displayName: 'Profile Test Owner', email: 'profiles@example.test', passwordHash: await hashPassword('River-lantern-fig-orbit-927!'), status: 'active', roleAssignments: { create: { roleId: ownerRole.id } } } })
const service = createWorkspaceService(db)
const profiles = []
for (const name of ['Xavia Racing', 'Second Business']) {
 const profile = await service.create(owner.id, { name, country: 'IT', currency: name === 'Xavia Racing' ? 'EUR' : 'GBP', timezone: 'Europe/Rome', creationKey: `fixture-${name.replaceAll(' ', '-')}-creation` })
 const access = await service.membership(owner.id, profile.id)
 await withWorkspace(access.context, async () => {
  await db.product.create({ data: { sku: 'SHARED-SKU', name: `${name} product`, basePrice: 10 } })
  await db.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: `${name} eBay`, externalAccountId: `fixture-${name}-ebay`, isActive: true, authStatus: 'connected', managedBy: 'oauth' } })
  if (name === 'Xavia Racing') await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: `${name} Amazon`, externalAccountId: 'FIXTUREAMAZON', isActive: true, authStatus: 'connected', managedBy: 'oauth', region: 'EU' } })
  if (name === 'Xavia Racing') await db.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Xavia spare eBay', externalAccountId: 'FIXTURESPARE', isActive: false, authStatus: 'disconnected', managedBy: 'oauth' } })
 })
 profiles.push(profile)
}
// More than one directory page proves switching does not depend on preloading all memberships.
for (let index = 1; index <= 25; index++) {
  await service.create(owner.id, { name: `Fixture business ${String(index).padStart(2, '0')}`, country: 'IT', currency: 'EUR', timezone: 'Europe/Rome', creationKey: `fixture-directory-profile-${index}` })
}
const app = Fastify({ logger: false })
await app.register(cookie)
app.addHook('preHandler', workspaceHook)
app.addHook('preHandler', rbacHook)
await app.register(authRoutes)
await app.register(invitationsRoutes)
await app.register(workspacesRoutes, { prefix: '/api' })
await app.register(profileRoutes, { prefix: '/api' })
await app.register(connectionsRoutes, { prefix: '/api' })
await app.register(cxConnectionsRoutes, { prefix: '/api' })
await app.register(accountsRoutes, { prefix: '/api' })
app.get('/api/products', async () => ({ products: await db.product.findMany() }))
app.get('/api/health', async () => ({ ok: true }))
await app.listen({ host: '127.0.0.1', port: 4125 })
await writeFile('/tmp/nexus-business-profiles-fixture.json', JSON.stringify({ databaseUrl: database.connectionString, profiles, webPort: 4126, apiPort: 4125 }))
console.log('Disposable business profile fixture ready on 4125', profiles)
process.on('SIGTERM', async () => { await app.close(); await database.close(); process.exit(0) })
