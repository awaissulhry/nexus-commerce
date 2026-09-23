/**
 * Step 2.6d (A-27, R-26) — fill the one variation store from the live eBay·IT listing, and drop a legacy value that
 * contradicts the store. See `services/pim/variation-store-fill.ts` for what is planned and why.
 *
 * 🔴 DRY RUN by default: it reads and prints. Run through the guarded launcher (Neon only, Redis on a dead port):
 *
 *   node docs/product-cheat/tools/prod-run.mjs fill-axes                                   # dry run
 *   node docs/product-cheat/tools/prod-run.mjs fill-axes --apply                           # WRITE, saves a record
 *   node docs/product-cheat/tools/prod-run.mjs fill-axes --revert <record.json>            # undo exactly that run
 *   … --workspace <id>                                                                     # another business
 *
 * `--apply` writes the before-state of every product it changes to a record file FIRST, then writes through
 * `writeVariationValues` (the one writer), then re-plans and must find nothing left to do.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { planVariationStoreFill, type FillChild } from '../services/pim/variation-store-fill.js'
import { writeVariationValues } from '../services/pim/category-attributes-write.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const WORKSPACE = flag('workspace') ?? LEGACY_WORKSPACE_ID
const APPLY = argv.includes('--apply')
const REVERT = flag('revert')

type RecordEntry = { id: string; sku: string; variations: unknown; variantAttributes: unknown }

async function load() {
  const children = await prisma.product.findMany({
    where: { deletedAt: null, parentId: { not: null } },
    select: { id: true, sku: true, parentId: true, categoryAttributes: true, variantAttributes: true,
      channelListings: { where: { channel: 'EBAY', marketplace: 'IT' }, select: { platformAttributes: true }, orderBy: { id: 'asc' } } },
    orderBy: { sku: 'asc' },
  })
  const parents = await prisma.product.findMany({ where: { id: { in: [...new Set(children.map((c) => c.parentId!))] } }, select: { id: true, variationAxes: true } })
  const rows: FillChild[] = children.map((c) => {
    const specifics = c.channelListings.map((l) => (l.platformAttributes as { itemSpecifics?: unknown } | null)?.itemSpecifics)
      .find((s) => s && typeof s === 'object' && !Array.isArray(s)) as Record<string, unknown> | undefined
    return { id: c.id, sku: c.sku, parentId: c.parentId!, categoryAttributes: c.categoryAttributes, variantAttributes: c.variantAttributes, ebaySpecifics: specifics ?? null }
  })
  return { rows, declared: new Map(parents.map((p) => [p.id, p.variationAxes])) }
}

async function main() {
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const [{ d: database }] = (await prisma.$queryRawUnsafe(`select current_database()::text as d`)) as Array<{ d: string }>

    if (REVERT) {
      // The launcher runs from apps/api: accept the absolute path --apply printed, or one relative to the repo root.
      const recordPath = [resolve(REVERT), resolve(process.cwd(), '../..', REVERT)].find((p) => existsSync(p)) ?? resolve(REVERT)
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { workspace: string; entries: RecordEntry[] }
      if (record.workspace !== WORKSPACE) throw new Error(`The record is for business ${record.workspace}; pass --workspace ${record.workspace}.`)
      for (const entry of record.entries) {
        await prisma.$transaction(async (tx) => {
          // The one writer restores the store; the legacy bag gets back exactly what the record holds.
          await writeVariationValues(tx, entry.id, { set: (entry.variations ?? {}) as Record<string, unknown>, unset: [], legacyDrop: [] }, { replaceStore: true })
          await tx.product.update({ where: { id: entry.id }, data: { variantAttributes: entry.variantAttributes === null ? Prisma.DbNull : entry.variantAttributes as Prisma.InputJsonValue } })
        })
      }
      console.log(`database ${database} · reverted ${record.entries.length} products from ${recordPath}`)
      return
    }

    const { rows, declared } = await load()
    const actions = planVariationStoreFill(rows, declared)
    const fills = actions.flatMap((a) => a.fills.map((f) => ({ sku: a.sku, ...f })))
    const drops = actions.flatMap((a) => a.drops.map((d) => ({ sku: a.sku, ...d })))
    console.log(`database ${database} · business ${WORKSPACE} · ${rows.length} live children · ${rows.filter((r) => r.ebaySpecifics).length} with an eBay·IT listing`)
    console.log(`PLAN — ${actions.length} products: ${fills.filter((f) => f.axis === 'size').length} sizes and ${fills.filter((f) => f.axis === 'color').length} colours filled from eBay·IT (${fills.filter((f) => f.from === 'siblings').length} in the family's own words), ${drops.length} contradicting legacy values dropped`)
    for (const f of fills) console.log(`   FILL  ${f.sku.padEnd(40)} ${f.axis.padEnd(5)} ${f.key} = ${JSON.stringify(f.value)}${f.from === 'siblings' ? '   (the family\'s name for eBay\'s value)' : ''}`)
    for (const d of drops) console.log(`   DROP  ${d.sku.padEnd(40)} legacy ${d.key} = ${JSON.stringify(d.legacy)} (the store says ${JSON.stringify(d.store)})`)

    if (!APPLY) { console.log('\n(dry run — pass --apply to write; it saves a record for --revert first)'); return }
    if (!actions.length) { console.log('\nnothing to write'); return }

    const before = await prisma.product.findMany({ where: { id: { in: actions.map((a) => a.id) } }, select: { id: true, sku: true, categoryAttributes: true, variantAttributes: true } })
    const recordPath = resolve(process.cwd(), '../../docs/product-cheat/records', `fill-variation-store-${WORKSPACE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    mkdirSync(dirname(recordPath), { recursive: true })
    writeFileSync(recordPath, JSON.stringify({ workspace: WORKSPACE, database, entries: before.map((p) => ({ id: p.id, sku: p.sku,
      variations: (p.categoryAttributes as { variations?: unknown } | null)?.variations ?? null, variantAttributes: p.variantAttributes ?? null })) }, null, 1))
    console.log(`\nrecord saved FIRST: ${recordPath}`)

    for (const action of actions) await writeVariationValues(prisma, action.id, action.plan)
    // 🔴 A loop of writes is a claim until it is counted back: re-plan; nothing may be left.
    const left = planVariationStoreFill((await load()).rows, declared)
    console.log(`WROTE ${actions.length} products. Left to do after the write: ${left.length}`)
    if (left.length) { console.error('🔴 the re-plan still finds work — inspect before anything else'); process.exit(1) }
  })
  process.exit(0)
}

main().catch((error) => { console.error(error); process.exit(1) })
