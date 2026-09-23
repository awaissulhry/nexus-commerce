/** Bounded operational probes. Default only describes the action; execution needs Owner approval. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parse } from 'dotenv'

const action = process.argv[2]
if (action !== 'ebay-catalogue' && action !== 'amazon-finances') throw new Error('Choose ebay-catalogue or amazon-finances.')
const workspaceId = 'nexus_legacy_workspace'
const accountId = 'cmothu9bo0000nz01asw6wx8j'
const plan = {
  action, workspaceId,
  ...(action === 'amazon-finances' ? {
    accountId, marketplaceId: 'APJ6JRA9NG5V4', limitation: 'Four legacy rows in this window have no account attribution and are excluded; this cannot establish full money reconciliation.',
    windowStart: '2026-09-20T00:00:00Z', windowEnd: '2026-09-21T00:00:00Z', dryRun: true,
    calls: ['GET finances/2024-06-19/transactions; at most 50 pages, same window/account on each'],
  } : {
    calls: ['GET commerce/notification/v1/topic', 'GET commerce/notification/v1/destination', 'GET commerce/notification/v1/subscription'],
    maxPagesPerCollection: 20, maximumCollectionPages: 60, oauthAndRetries: 'Canonical app-token requests and bounded gateway retries also apply', subscriptionCoverage: 'APPLICATION token only; USER subscriptions need a separate account-scoped read',
  }),
  sideEffects: 'Normal OAuth refresh, credential-health, gateway audit, rate-limit bookkeeping and in-app health/deprecation alerts only; no financial, listing, stock, subscription or destination writes.',
}
console.log(JSON.stringify(plan, null, 2))
if (!process.argv.includes('--execute-approved')) process.exit(0)

// Existing configured credentials are used only by canonical clients; never print them.
let phase = 'load-configuration'
let prisma: { $disconnect: () => Promise<void> } | undefined
const deadline = setTimeout(() => { console.error('Probe stopped at its 120-second execution bound; no complete result claimed.'); process.exit(1) }, 120_000)
deadline.unref()
try {
  const env = parse(readFileSync('/Users/awais/nexus-commerce/.env', 'utf8'))
  phase = 'verify-target'
  const target = new URL(env.DATABASE_URL)
  if (target.hostname !== 'ep-purple-river-altf6t3y-pooler.c-3.eu-central-1.aws.neon.tech' || target.pathname !== '/neondb') throw new Error('Unexpected production database target.')
  console.log(JSON.stringify({targetHost:target.hostname,database:target.pathname}))
  for (const [key,value] of Object.entries(env)) {
    if (/^(DATABASE_URL$|DIRECT_URL$|NEXUS_|AMAZON_|EBAY_|AWS_|REDIS_)/.test(key)) process.env[key]=value
  }
  process.env.NEXUS_WORKSPACES_ENABLED='1'
  process.env.NEXUS_DATABASE_POOL_MAX='2'
  phase = 'load-clients'
  prisma = (await import('../apps/api/src/db.js')).default
  const { withWorkspace } = await import('../apps/api/src/lib/workspace-context.js')
  phase = 'run-approved-probe'
  const result = await withWorkspace({workspaceId,actorUserId:null,membershipId:null,roleKeys:[]},async () => {
    if (action === 'amazon-finances') {
      const { syncFinancialTransactions } = await import('../apps/api/src/services/amazon-financial-events.service.js')
      return syncFinancialTransactions(new Date(plan.windowStart!),new Date(plan.windowEnd!),plan.marketplaceId,{dryRun:true,accountId})
    }
    const {getEbayTopics,getEbayDestinations,getEbaySubscriptions}=await import('../apps/api/src/services/cx/connectors/ebay/notifications.js')
    const topics=await getEbayTopics('production')
    const destinations=await getEbayDestinations('production')
    const subscriptions=await getEbaySubscriptions('production')
    return {
      topics:topics.map(t=>({topicId:t.topicId,status:t.status,scope:t.scope,authorizationScopes:t.authorizationScopes,supportedPayloads:t.supportedPayloads})),
      destinations,
      subscriptions:subscriptions.map(s=>({subscriptionId:s.subscriptionId,topicId:s.topicId,destinationId:s.destinationId,status:s.status,payload:s.payload})),
    }
  })
  phase = 'save-evidence'
  const evidence={measuredAt:new Date().toISOString(),plan,result}
  const path=fileURLToPath(new URL(`../docs/channel-connections/build/${action}-approved-probe.json`,import.meta.url))
  writeFileSync(path,JSON.stringify(evidence,null,2),{mode:0o600})
  console.log(JSON.stringify({measuredAt:evidence.measuredAt,action,evidencePath:path,result:action==='amazon-finances'?result:'Catalogue, destinations and subscriptions saved without secrets'},null,2))
} catch (error) {
  // Never emit Error.message/stack/input: URL and provider errors can contain credentials.
  const code=(error as {code?:unknown})?.code
  console.error(JSON.stringify({error:'probe_failed',phase,code:typeof code==='string' && ['ENOTFOUND','ECONNREFUSED','ETIMEDOUT','P1001','P1002'].includes(code)?code:undefined}))
  process.exitCode=1
} finally {
  try { await prisma?.$disconnect() } catch { console.error(JSON.stringify({error:'probe_cleanup_failed'})); process.exitCode=1 }
  clearTimeout(deadline)
}
// No server/worker is started; close any SDK/Redis handles owned only by this probe.
process.exit(process.exitCode ?? 0)
