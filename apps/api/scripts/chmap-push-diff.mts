/**
 * CHMAP M4 — the difference list, offline (study §11.3, option A). For every product family with a connected Amazon or
 * eBay listing in a market, build the payload the studio publication would send, in five states, and compare:
 *   BASE   the two builders as committed before M4 (read from git, loaded beside the real modules)
 *   S0     the M4 builders on the database as it is (no ACTIVE mapping version: production today)
 *   S1     every DRAFT version of that channel and market activated as the rules made it (no decision of the Owner)
 *   S2     per family, a new version of each form that covers it, with planted Owner decisions: one whole field ignored,
 *          ONE part of a multi-part Amazon field ignored, one eBay item specific ignored. A built Amazon family whose product
 *          type has no version gets a rules-only one from its cached schema first (S1 then proves the rules change nothing).
 *   S2off  S2 with NEXUS_PUSH_FOLLOWS_MAPPING=0
 * Expected: S0 = S1 = S2off = BASE. S2 differs from BASE only by the planted whole field (Amazon) or specific (eBay).
 *
 * Every family runs in its own database transaction that is THROWN AWAY (the helper allows 60 s). Nothing is sent:
 * every socket except the local database is refused, `fetch` is refused, schemas are read from the cache only.
 * Local database whose name contains "test" only. Prints SKUs and roots, never seller, item or policy IDs.
 *   cd apps/api && npx tsx scripts/chmap-push-diff.mts [--channel AMAZON|EBAY] [--market IT] [--limit 20] [--fulfillment FBM] [--no-gallery] [--json out.json]
 */
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1'])
const network: string[] = []
const connect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const options = (typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' }) as { host?: string; port?: unknown; path?: string }
  if (!options.path && !LOCAL.has(options.host ?? 'localhost')) {
    network.push(`${options.host}:${String(options.port)}`)
    throw new Error(`chmap-push-diff: network refused (${options.host})`)
  }
  return connect.apply(this, args)
} as typeof net.Socket.prototype.connect
globalThis.fetch = (async (input: unknown) => { network.push(String(input)); throw new Error('chmap-push-diff: network refused') }) as typeof fetch
process.env.REDIS_URL = 'redis://127.0.0.1:1'
process.env.NEXUS_DISABLE_BACKGROUND_JOBS = '1'
process.env.ENABLE_QUEUE_WORKERS = '0'
// The eBay builder refuses to prepare unless publication is live; nothing can leave this process (above).
Object.assign(process.env, { NEXUS_ENABLE_EBAY_PUBLISH: 'true', EBAY_PUBLISH_MODE: 'live', NEXUS_EBAY_REAL_API: 'true' })
delete process.env.EBAY_SANDBOX

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const LIMIT = Number(arg('limit') ?? 1e9), JSON_OUT = arg('json'), FULFILLMENT = arg('fulfillment'), NO_GALLERY = process.argv.includes('--no-gallery')
const TARGETS = [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['AMAZON', 'FR'], ['AMAZON', 'ES'], ['EBAY', 'IT'], ['EBAY', 'DE']]
  .filter(([c, m]) => (!arg('channel') || arg('channel')!.toUpperCase() === c) && (!arg('market') || arg('market')!.toUpperCase() === m))

await import('../src/env.js')
const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid/none')
if (!LOCAL.has(url.hostname) || !/test/i.test(url.pathname)) throw new Error('refusing: a local database whose name contains "test" only')

// BASE: the builders before M4, placed beside the real ones so their imports resolve to the same modules.
const PIM = fileURLToPath(new URL('../src/services/pim/', import.meta.url))
const git = (...args: string[]) => execFileSync('git', args, { cwd: PIM, encoding: 'utf8' }).trim()
const introduced = git('log', '-1', '--format=%H', '-S', 'pushExclusionsCache', '--', 'studio-publication-amazon.ts')
const BASE = introduced ? `${introduced}~1` : 'HEAD'
const baseFiles = { amazon: `${PIM}.chmap-base-amazon.ts`, ebay: `${PIM}.chmap-base-ebay.ts` }
const cleanup = () => { for (const f of Object.values(baseFiles)) if (existsSync(f)) rmSync(f) }
process.on('exit', cleanup)
writeFileSync(baseFiles.amazon, git('show', `${BASE}:./studio-publication-amazon.ts`))
writeFileSync(baseFiles.ebay, git('show', `${BASE}:./studio-publication-ebay.ts`))
for (const f of Object.values(baseFiles)) if (/pushExclusions/.test(readFileSync(f, 'utf8'))) throw new Error('The base builder already follows the mapping versions')

const { default: prisma } = await import('../src/db.js')
const { inDatabaseTransaction } = await import('../src/lib/database-context.js')
const { withWorkspace } = await import('../src/lib/workspace-context.js')
const { withCachedSchemas } = await import('../src/services/pim/cached-schema-context.js')
const { readPublicationFacts } = await import('../src/services/pim/studio-publication-plan.js')
const m4 = { amazon: await import('../src/services/pim/studio-publication-amazon.js'), ebay: await import('../src/services/pim/studio-publication-ebay.js') }
const base = { amazon: await import(baseFiles.amazon), ebay: await import(baseFiles.ebay) }
const { activateSet, newVersionFrom, decideField, getSet, ensureSetForForm } = await import('../src/services/channel-mapping/store.js')
const { loadAmazonSpec } = await import('../src/services/pim/channel-specs/index.js')
const { pushImpact, amazonRootOf } = await import('../src/services/channel-mapping/push.js')
const { parseEbayItemContent } = await import('../src/services/channel-drift/ebay-content-compare.js')
cleanup()

class Rollback extends Error { constructor() { super('rollback') } }
const WS = { workspaceId: 'nexus_legacy_workspace', actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x)
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 160)

/** One payload as comparable parts: Amazon = message × root; eBay = item specific names and the rest of the request. */
type Built = { error: string } | { parts: Map<string, string> }
function amazonParts(plan: any): Map<string, string> {
  const parts = new Map<string, string>()
  for (const m of plan.feed.messages) {
    parts.set(`${m.sku}|op`, String(m.operationType))
    parts.set(`${m.sku}|type`, String(m.productType))
    for (const [root, value] of Object.entries(m.attributes ?? {})) parts.set(`${m.sku}|${root}`, canonical(value))
    for (const p of m.patches ?? []) parts.set(`${m.sku}|${String(p.path).replace('/attributes/', '')}|${p.op}`, canonical(p.value))
  }
  return parts
}
function ebayParts(plan: any): Map<string, string> {
  const parts = new Map<string, string>()
  const content = parseEbayItemContent(plan.xml) as { itemSpecifics: Record<string, unknown> }
  for (const [name, value] of Object.entries(content.itemSpecifics ?? {})) parts.set(`specific|${name}`, canonical(value))
  // The rest of the request, without the item specifics block (compared above).
  parts.set('request-without-specifics', String(plan.xml).replace(/<ItemSpecifics>[\s\S]*?<\/ItemSpecifics>/g, ''))
  return parts
}
async function build(channel: string, builder: 'base' | 'm4', rootId: string, scope: any, followsMapping = true): Promise<Built> {
  const previous = process.env.NEXUS_PUSH_FOLLOWS_MAPPING
  if (!followsMapping) process.env.NEXUS_PUSH_FOLLOWS_MAPPING = '0'
  try {
    const facts = await readPublicationFacts(rootId, scope)
    // --no-gallery: the saved gallery is left out of every state, in memory (M4 does not touch images; this copy has galleries
    // over Amazon's nine). An existing listing then carries no image slots; a new listing still needs its images.
    if (NO_GALLERY) for (const l of facts.listings as any[]) {
      if (l.platformAttributes && typeof l.platformAttributes === 'object') { const { _productMediaLocales: _a, _amazonMediaWorkspace: _b, ...rest } = l.platformAttributes; l.platformAttributes = rest }
    }
    const mod = (builder === 'base' ? base : m4)[channel === 'AMAZON' ? 'amazon' : 'ebay']
    const plan = await withCachedSchemas(() => channel === 'AMAZON' ? mod.prepareAmazonPublication(facts) : mod.prepareEbayPublication(facts))
    return { parts: channel === 'AMAZON' ? amazonParts(plan) : ebayParts(plan) }
  } catch (error) {
    return { error: firstLine(error) }
  } finally {
    if (previous === undefined) delete process.env.NEXUS_PUSH_FOLLOWS_MAPPING; else process.env.NEXUS_PUSH_FOLLOWS_MAPPING = previous
  }
}
/** The parts that differ: `-key` only in a, `+key` only in b, `~key` changed. A refusal compares by its sentence. */
function diff(a: Built, b: Built): string[] {
  if ('error' in a || 'error' in b) return 'error' in a && 'error' in b && a.error === b.error ? [] : [`refusal: ${'error' in a ? a.error : 'built'} → ${'error' in b ? b.error : 'built'}`]
  const out: string[] = []
  for (const [k, v] of a.parts) if (!b.parts.has(k)) out.push(`-${k}`); else if (b.parts.get(k) !== v) out.push(`~${k}`)
  for (const k of b.parts.keys()) if (!a.parts.has(k)) out.push(`+${k}`)
  return out
}

type Plant = { form: string; whole?: string; part?: string; specific?: string }
const report: any = { base: BASE, network: [] as string[], database: `${url.hostname}${url.pathname}`, fulfillment: FULFILLMENT ?? null, noGallery: NO_GALLERY, markets: [] as any[] }

await withWorkspace(WS, async () => {
  for (const [channel, market] of TARGETS) {
    const listings = await prisma.channelListing.findMany({ where: { channel, marketplace: market, channelConnectionId: { not: null }, aliasKey: '', product: { deletedAt: null } },
      select: { channelConnectionId: true, product: { select: { id: true, parentId: true } } } })
    const families = [...new Map(listings.map(l => [`${l.product.parentId ?? l.product.id}|${l.channelConnectionId}`, { rootId: l.product.parentId ?? l.product.id, accountId: l.channelConnectionId! }])).values()]
      .sort((a, b) => a.rootId.localeCompare(b.rootId)).slice(0, LIMIT)
    const drafts = await prisma.channelMappingSet.findMany({ where: { channel, marketplace: market, status: { in: ['DRAFT', 'ACTIVE'] } }, orderBy: { version: 'asc' }, select: { id: true, formKey: true, version: true, status: true } })
    const entry: any = { channel, market, families: families.length, versions: drafts.map(d => `${d.formKey} v${d.version} ${d.status}`), activation: {}, impact: {},
      built: 0, refused: {} as Record<string, number>, detail: [] as any[], differ: { S0: [] as any[], S1: [] as any[], S2off: [] as any[], S2: [] as any[] }, s2Planted: {} as Record<string, number>, s2Unexpected: [] as any[], synthetic: {} as Record<string, number> }
    report.markets.push(entry)
    for (const family of families) {
      const scope = { channel, marketplace: market, accountId: family.accountId }
      try {
        await inDatabaseTransaction(prisma, async () => {
          // Preconditions (thrown away): the local account row reads as connected; the cached schemas read as fresh.
          await prisma.channelConnection.updateMany({ where: { id: family.accountId, authStatus: { not: 'connected' } }, data: { authStatus: 'connected' } })
          await prisma.categorySchema.updateMany({ where: { channel, marketplace: market, isActive: true }, data: { expiresAt: new Date(Date.now() + 86_400_000) } })
          // --fulfillment FBM (as payload-diff.mts): products of the family with no method get one, so the builder gets past that refusal.
          if (FULFILLMENT) await prisma.product.updateMany({ where: { OR: [{ id: family.rootId }, { parentId: family.rootId }], deletedAt: null, fulfillmentMethod: null }, data: { fulfillmentMethod: FULFILLMENT as never } })
          // An env-managed Amazon account must match the process's seller ID; this copy's .env has none. In memory only, never printed.
          if (channel === 'AMAZON' && !process.env.AMAZON_SELLER_ID) {
            const account = await prisma.channelConnection.findUnique({ where: { id: family.accountId }, select: { externalAccountId: true, managedBy: true } })
            if (account?.managedBy === 'env' && account.externalAccountId) process.env.AMAZON_SELLER_ID = account.externalAccountId
          }
          const B = await build(channel, 'base', family.rootId, scope)
          const S0 = await build(channel, 'm4', family.rootId, scope)
          // S1: every draft activated as the rules made it (the latest version of a form wins).
          const active: { id: string; formKey: string }[] = []
          for (const d of drafts) {
            try { await activateSet(d.id); active.push(d); entry.activation[`${d.formKey} v${d.version}`] = 'activated' }
            catch (error) { entry.activation[`${d.formKey} v${d.version}`] = `refused: ${firstLine(error)}` }
          }
          // A built Amazon family whose product type has no version gets a rules-only one from its own cached schema.
          if (channel === 'AMAZON' && !('error' in S0)) for (const type of amazonTypes(S0)) {
            if (active.some(a => a.formKey.split('+').includes(type))) continue
            active.push(await syntheticAmazonSet(market, type, family.accountId))
            entry.synthetic[type] = (entry.synthetic[type] ?? 0) + 1
          }
          const S1 = await build(channel, 'm4', family.rootId, scope)
          // S2: per family, a new version of each covering form with planted Owner decisions, activated.
          const covering = channel === 'AMAZON' && !('error' in S1) ? active.filter(a => a.formKey.split('+').some(t => amazonTypes(S1).includes(t))) : active
          const plants = 'error' in S1 ? [] : await choosePlants(channel, covering, S1)
          for (const plant of plants) {
            const current = active.filter(a => a.formKey === plant.form).at(-1)!
            const next = await newVersionFrom(current.id, null)
            const ignore = async (pick: (f: any) => boolean) => { for (const f of next.fields.filter(pick)) await decideField(next.id, f.channelKey, { state: 'ignored', reason: 'CHMAP M4 planted decision (thrown away)' } as any) }
            if (plant.whole) await ignore(f => f.targetKind === 'channelField' && f.targetKey && amazonRootOf(f.targetKey) === plant.whole)
            if (plant.part) await ignore(f => f.targetKind === 'channelField' && f.targetKey === plant.part)
            if (plant.specific) await ignore(f => f.channelKey === plant.specific)
            const impact = await pushImpact(next.id)
            if (!entry.impact[plant.form]) entry.impact[plant.form] = impact
            await activateSet(next.id)
          }
          const S2 = await build(channel, 'm4', family.rootId, scope)
          const S2off = await build(channel, 'm4', family.rootId, scope, false)
          const label = (await prisma.product.findUnique({ where: { id: family.rootId }, select: { sku: true } }))?.sku ?? family.rootId
          if ('error' in B) entry.refused[B.error] = (entry.refused[B.error] ?? 0) + 1; else entry.built++
          entry.detail.push({ family: label, channelTypes: 'error' in S1 ? [] : amazonTypes(S1), messages: 'error' in B ? 0 : [...B.parts.keys()].filter(k => k.endsWith('|op')).length,
            result: 'error' in B ? B.error : 'built', plants })
          for (const [name, state] of [['S0', S0], ['S1', S1], ['S2off', S2off], ['S2', S2]] as const) {
            const d = diff(B, state)
            if (d.length) entry.differ[name].push({ family: label, parts: d.slice(0, 12), count: d.length })
            if (name !== 'S2') continue
            // Planted = a whole Amazon field removed from a message, or an eBay specific removed. Anything else is unexpected.
            const planted = (p: string) => plants.some(pl => (pl.whole && p.startsWith('-') && p.split('|')[1] === pl.whole)
              || (pl.specific && p.toLowerCase() === `-specific|${pl.specific.split(':').slice(1).join(':').toLowerCase()}`))
            for (const p of d) {
              const key = p.replace(/^([-+~])[^|]*\|/, '$1')
              if (planted(p)) entry.s2Planted[key] = (entry.s2Planted[key] ?? 0) + 1
              else entry.s2Unexpected.push({ family: label, part: p })
            }
          }
          throw new Rollback()
        })
      } catch (error) {
        if (!(error instanceof Rollback)) entry.refused[`transaction: ${firstLine(error)}`] = (entry.refused[`transaction: ${firstLine(error)}`] ?? 0) + 1
      }
    }
    console.log(`${channel} ${market}: families ${entry.families}, built ${entry.built}, refused ${Object.values(entry.refused).reduce((n: number, v: any) => n + v, 0)} · differ S0 ${entry.differ.S0.length} S1 ${entry.differ.S1.length} S2off ${entry.differ.S2off.length} · S2 planted ${JSON.stringify(entry.s2Planted)} unexpected ${entry.s2Unexpected.length}`)
  }
})

/** The Amazon product types of a built payload's messages. */
function amazonTypes(built: { parts: Map<string, string> }): string[] {
  return [...new Set([...built.parts].filter(([k]) => k.endsWith('|type')).map(([, v]) => v.toUpperCase()))]
}

/** A rules-only version for a product type with none: one column per field of the cached schema, as the rules decide. */
async function syntheticAmazonSet(market: string, type: string, accountId: string): Promise<{ id: string; formKey: string }> {
  const spec = await withCachedSchemas(() => loadAmazonSpec(market, type, accountId))
  const rows = spec.fields.map((f: any, i: number) => ({ channelKey: f.key, columnKey: f.key, label: null, aliases: [], productTypes: [type], requirement: f.requirement ?? null, templateRequirement: null,
    targetKind: 'channelField' as const, targetKey: f.key, transform: [], direction: 'both' as const, state: 'mapped' as const, reason: null, decidedBy: 'rule' as const, sortOrder: i }))
  const { set } = await ensureSetForForm({ channel: 'AMAZON', marketplace: market, formKind: 'AMAZON_TEMPLATE', formKey: type, templateIdentifier: null, templateVersion: null, language: null,
    layout: { sheet: 'chmap-push-diff', labelRow: null, keyRow: 1, dataRow: 2 }, keyFingerprint: `chmap-push-diff:${type}` } as any, () => rows as any)
  await activateSet(set.id)
  return { id: set.id, formKey: type }
}

/** Pick, from a built family, a whole Amazon field and one part of a multi-part field that the payload carries, or an eBay specific. */
async function choosePlants(channel: string, active: { id: string; formKey: string }[], S1: { parts: Map<string, string> }): Promise<Plant[]> {
  const plants: Plant[] = []
  for (const set of [...new Map(active.map(a => [a.formKey, a])).values()]) {
    const detail = await getSet(set.id)
    const optional = (f: any) => f.requirement !== 'required' && f.state === 'mapped' && f.direction !== 'in'
    if (channel === 'AMAZON') {
      const sent = new Set([...S1.parts.keys()].map(k => k.split('|')[1]))
      const byRoot = new Map<string, any[]>()
      for (const f of detail.fields.filter((f: any) => f.targetKind === 'channelField' && f.targetKey)) byRoot.set(amazonRootOf(f.targetKey), [...(byRoot.get(amazonRootOf(f.targetKey)) ?? []), f])
      const roots = [...byRoot].filter(([root, rows]) => sent.has(root) && rows.every(optional)).sort(([a], [b]) => a.localeCompare(b))
      const whole = roots.find(([, rows]) => new Set(rows.map(r => r.targetKey)).size === 1)?.[0]
      const multi = roots.find(([root, rows]) => root !== whole && new Set(rows.map(r => r.targetKey)).size >= 2)
      plants.push({ form: set.formKey, whole, part: multi ? [...new Set(multi[1].map((r: any) => r.targetKey))].sort()[0] as string : undefined })
    } else {
      const names = new Set([...S1.parts.keys()].filter(k => k.startsWith('specific|')).map(k => k.slice('specific|'.length).toLowerCase()))
      const specific = detail.fields.filter((f: any) => optional(f) && /^(aspect|specific):/.test(f.channelKey) && names.has(f.channelKey.split(':')[1].toLowerCase()))
        .map((f: any) => f.channelKey).sort()[0]
      plants.push({ form: set.formKey, specific })
    }
  }
  return plants
}

report.network = network
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2))
console.log(`REPORT ${JSON.stringify({ base: report.base, network: network.length, markets: report.markets.map((m: any) => ({ ...m, differ: Object.fromEntries(Object.entries(m.differ).map(([k, v]: any) => [k, v.length])) })) })}`)
process.exit(0)
