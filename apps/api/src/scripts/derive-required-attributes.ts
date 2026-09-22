/**
 * PLAN Step 2.1 (b) / decision D-A — WHICH attributes are required.
 *
 * D-A's recommendation: *"Start with what a channel refuses a publish for. That set is already
 * knowable from the schemas."* Its default: *"I derive the list from the channel schemas and bring
 * it back for approval before applying."*
 *
 * 🔴 THIS SCRIPT WRITES NOTHING. It reads, and prints a proposal.
 *
 *   DATABASE_URL=… npx tsx apps/api/src/scripts/derive-required-attributes.ts            # summary
 *   … --markdown docs/product-cheat/D-A-PROPOSAL.md                                      # the table
 *   … --apply                                                                            # WRITE
 *   … --revert                                                                           # undo
 *
 * 🔴 `--apply` is the MIRROR ruled in A-16 (option a). It writes `required = true` and
 * `channels = ['<the channel that asks>']` onto `FamilyAttribute` rows. It adds NO requirement a
 * channel did not already state — on that channel the field is required today either way. What it
 * changes is that **Shared** can now say *"also required by Amazon · DE"*.
 *
 * 🔴 THE MATCH IS PER FAMILY, NOT PER ATTRIBUTE. A channel requires a field for particular PRODUCT
 * TYPES. A family is marked only when it actually holds a product of one of those types —
 * otherwise a family that never sells outerwear would inherit outerwear's requirements. Without
 * that check the mirror is a blunt instrument wearing a derivation's clothes.
 *
 * 🟢 IT DOES NOT RE-DERIVE "REQUIRED". `getSheetColumns` already merges the cached channel schemas
 * onto master keys and marks each column's `requiredBy` per coordinate — the same path the sheet,
 * readiness and the studio all read. Parsing `CategorySchema.schemaDefinition` here would be a
 * second answer to "does this channel require this field", and the two would disagree the first
 * time either changed. The channel's own derivation lives in `channel-specs/`; this asks it.
 *
 * 🔴 WHAT IT CANNOT SEE. Only coordinates with a CACHED schema. A channel·market·product-type with
 * no `CategorySchema` row contributes nothing, and its absence is reported rather than rounded to
 * "nothing required there".
 */
import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { clearSheetColumnCache, getSheetColumns } from '../services/pim/sheet-columns.service.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
const WORKSPACE = flag('workspace') ?? LEGACY_WORKSPACE_ID
const MARKDOWN = flag('markdown')
const LIMIT = Number(flag('limit') ?? 0)
const APPLY = argv.includes('--apply')
const REVERT = argv.includes('--revert')

type Hit = { channel: string; market: string; productType: string }

async function main() {
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const [{ d: database }] = (await prisma.$queryRawUnsafe(`select current_database()::text as d`)) as Array<{ d: string }>

    // ── what the dictionary holds, and what the families already use ──
    const attributes = await prisma.customAttribute.findMany({ select: { id: true, code: true, label: true } })
    const byCode = new Map(attributes.map(a => [a.code, a]))
    const familyAttributes = await prisma.familyAttribute.findMany({ select: { id: true, attributeId: true, familyId: true, required: true, channels: true } })
    const attachedTo = new Map<string, Set<string>>()
    for (const fa of familyAttributes) {
      if (!attachedTo.has(fa.attributeId)) attachedTo.set(fa.attributeId, new Set())
      attachedTo.get(fa.attributeId)!.add(fa.familyId)
    }
    const alreadyRequired = familyAttributes.filter(fa => fa.required).length

    // ── the coordinates that HAVE a cached schema ──
    const cached = await prisma.categorySchema.findMany({
      where: { isActive: true },
      select: { channel: true, marketplace: true, productType: true, fetchedAt: true },
      orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { productType: 'asc' }],
    })
    const coordinates = [...new Map(cached.map(r => [`${r.channel}|${r.marketplace}|${r.productType}`, r])).values()]
      .filter(r => r.marketplace && !r.marketplace.includes('_'))
    const work = LIMIT > 0 ? coordinates.slice(0, LIMIT) : coordinates

    console.log(`database ${database} · ${attributes.length} dictionary attributes · ${familyAttributes.length} family rows (${alreadyRequired} already required)`)
    console.log(`cached schemas: ${cached.length} rows → ${coordinates.length} usable coordinates${LIMIT ? `, reading ${work.length}` : ''}`)

    // ── ask the column builder, per coordinate ──
    const required = new Map<string, Hit[]>()   // attribute code → where it is required
    /**
     * 🔴 THE DENOMINATOR. Channels require far more than the dictionary knows about. Reporting only
     * the matched ones reads as "channels require 5 things", which is false and would decide D-A on
     * a number that is not the number.
     */
    const outsideDictionary = new Map<string, Set<string>>()
    const unreadable: string[] = []
    let read = 0
    for (const c of work) {
      const market = String(c.marketplace)
      try {
        clearSheetColumnCache()
        const set = await getSheetColumns({
          market, onlyChannels: [c.channel], scopeKind: 'channel',
          productTypes: [c.productType], allowUnknownMarket: true,
        } as never)
        const label = set.coordinates[0]?.label
        if (!label) { unreadable.push(`${c.channel}·${market}·${c.productType}: no coordinate`); continue }
        for (const column of set.columns) {
          if (!column.requiredBy.includes(label)) continue
          const code = column.key.replace(/^attr_/, '')
          if (!byCode.has(code)) {
            if (!outsideDictionary.has(code)) outsideDictionary.set(code, new Set())
            outsideDictionary.get(code)!.add(c.channel)
            continue                            // no dictionary twin — no FamilyAttribute row to mark
          }
          if (!required.has(code)) required.set(code, [])
          required.get(code)!.push({ channel: c.channel, market, productType: c.productType })
        }
        read++
      } catch (error) {
        unreadable.push(`${c.channel}·${market}·${c.productType}: ${(error as Error).message}`)
      }
      if (read % 20 === 0) process.stdout.write(`\r  read ${read}/${work.length} coordinates   `)
    }
    process.stdout.write('\n')

    // ── the proposal ──
    const rows = [...required.entries()].map(([code, hits]) => {
      const channels = [...new Set(hits.map(h => h.channel))].sort()
      const attribute = byCode.get(code)!
      const families = attachedTo.get(attribute.id)?.size ?? 0
      return {
        code, label: attribute.label, channels, families,
        markets: [...new Set(hits.map(h => h.market))].sort(),
        productTypes: [...new Set(hits.map(h => h.productType))].sort(),
        hits: hits.length,
      }
    }).sort((a, b) => b.hits - a.hits || a.code.localeCompare(b.code))

    const everywhere = rows.filter(r => r.channels.length > 1)
    const scoped = rows.filter(r => r.channels.length === 1)
    const attached = rows.filter(r => r.families > 0)

    console.log('')
    console.log(`CHANNELS REQUIRE ${rows.length + outsideDictionary.size} distinct fields across the coordinates read.`)
    console.log(`  · ${rows.length} have a dictionary attribute — a FamilyAttribute row can be written`)
    console.log(`  · ${outsideDictionary.size} do NOT — no dictionary twin, so D-A cannot mark them at all`)
    console.log('')
    console.log(`PROPOSAL — ${rows.length} dictionary attributes a channel refuses a publish for`)
    console.log(`  · required on MORE THAN ONE channel  : ${everywhere.length}`)
    console.log(`  · required on exactly one channel    : ${scoped.length}`)
    console.log(`  🔴 of those, attached to a family today: ${attached.length}  ← the only ones a FamilyAttribute row can be written for`)
    if (unreadable.length) {
      console.log(`  ⬜ coordinates that could not be read : ${unreadable.length}`)
      for (const u of unreadable.slice(0, 5)) console.log(`      ${u}`)
      if (unreadable.length > 5) console.log(`      … and ${unreadable.length - 5} more`)
    }

    // ── the mirror (A-16 option a) ────────────────────────────────
    if (REVERT) {
      // Undoes exactly what --apply writes and nothing else: rows carrying a channel list. The
      // 486 rows all started `required = false, channels = []`, so this is the same state back.
      const target = await prisma.familyAttribute.findMany({ where: { required: true, NOT: { channels: { isEmpty: true } } }, select: { id: true } })
      if (!target.length) { console.log('\nnothing to revert — no FamilyAttribute row carries a channel list'); return }
      const undone = await prisma.familyAttribute.updateMany({ where: { id: { in: target.map(t => t.id) } }, data: { required: false, channels: [] } })
      console.log(`\nreverted ${undone.count} of ${target.length} rows to required = false, channels = []`)
      return
    }

    // Which product types each family actually holds — the precision the mirror turns on.
    const familyTypes = new Map<string, Set<string>>()
    for (const row of await prisma.product.groupBy({ by: ['familyId', 'productType'], where: { deletedAt: null, familyId: { not: null } } })) {
      const id = String(row.familyId)
      if (!familyTypes.has(id)) familyTypes.set(id, new Set())
      if (row.productType) familyTypes.get(id)!.add(String(row.productType).toUpperCase())
    }

    type Write = { id: string; family: string; code: string; channels: string[]; types: string[] }
    const writes: Write[] = []
    const skipped: string[] = []
    for (const [code, hits] of required) {
      const attribute = byCode.get(code)!
      const rows = familyAttributes.filter(fa => fa.attributeId === attribute.id)
      for (const fa of rows) {
        const held = familyTypes.get(fa.familyId) ?? new Set<string>()
        const matching = hits.filter(h => held.has(h.productType.toUpperCase()))
        if (!matching.length) { skipped.push(`${code} on family ${fa.familyId}: the family holds none of the product types the channel asks for`); continue }
        const channels = [...new Set(matching.map(h => h.channel))].sort()
        const already = fa.required && [...fa.channels].sort().join(',') === channels.join(',')
        if (already) { skipped.push(`${code} on family ${fa.familyId}: already ${channels.join(', ')}`); continue }
        if (fa.required) { skipped.push(`🔴 ${code} on family ${fa.familyId}: already required as ${JSON.stringify(fa.channels)} — NOT overwritten`); continue }
        writes.push({ id: fa.id, family: fa.familyId, code, channels, types: [...new Set(matching.map(h => h.productType))].sort() })
      }
    }

    console.log('')
    console.log(`MIRROR — ${writes.length} FamilyAttribute rows would be marked required`)
    for (const w of writes) console.log(`   ${w.code.padEnd(38)} channels=${JSON.stringify(w.channels).padEnd(12)} family=${w.family}  types=${w.types.join(', ')}`)
    if (skipped.length) {
      console.log(`   ⬜ ${skipped.length} skipped`)
      for (const sk of skipped.slice(0, 8)) console.log(`      ${sk}`)
      if (skipped.length > 8) console.log(`      … and ${skipped.length - 8} more`)
    }

    if (APPLY) {
      if (!writes.length) { console.log('\nnothing to write'); return }
      let written = 0
      for (const w of writes) {
        await prisma.familyAttribute.update({ where: { id: w.id }, data: { required: true, channels: w.channels } })
        written++
      }
      // 🔴 Assert the count. A loop of writes is a claim until it is counted back.
      const now = await prisma.familyAttribute.count({ where: { required: true, NOT: { channels: { isEmpty: true } } } })
      console.log(`\nWROTE ${written} rows. FamilyAttribute rows now required with a channel list: ${now}`)
      if (written !== writes.length) { console.error('🔴 wrote fewer rows than planned'); process.exit(1) }
      return
    }
    if (!REVERT) console.log('\n(dry run — pass --apply to write, --revert to undo)')

    if (MARKDOWN) {
      const { writeFileSync } = await import('node:fs')
      const line = (r: typeof rows[number]) =>
        `| \`${r.code}\` | ${r.label} | ${r.channels.join(', ')} | ${r.markets.length} | ${r.productTypes.length} | ${r.families || '🔴 0'} |`
      const md = [
        '# D-A — which attributes are required. DERIVED, NOT APPLIED.',
        '',
        `**Generated ${new Date().toISOString().slice(0, 10)} by \`apps/api/src/scripts/derive-required-attributes.ts\` against \`${database}\`. Nothing was written.**`,
        '',
        `Derived exactly as [D-A](PLAN.md#part-9--the-decisions-i-need) recommends — *"what a channel`,
        `refuses a publish for"* — by asking \`getSheetColumns\` per coordinate, which is the same`,
        'derivation the sheet, readiness and the studio read. No schema JSON was parsed here.',
        '',
        `Read **${read}** cached coordinates of **${coordinates.length}**. ${unreadable.length} could not be read.`,
        '',
        '## 🔴 The denominator, before the proposal',
        '',
        `Across those coordinates the channels require **${rows.length + outsideDictionary.size}** distinct fields.`,
        '',
        `| | |`,
        `|---|---|`,
        `| have a dictionary attribute → a \`FamilyAttribute\` row can be written | **${rows.length}** |`,
        `| have **no** dictionary twin → D-A cannot mark them at all | **${outsideDictionary.size}** |`,
        '',
        `🔴 **"${rows.length} attributes" is not "channels only require ${rows.length} things".** The`,
        `${outsideDictionary.size} without a twin are required by a channel and invisible to the family`,
        'model. They are a different decision — whether the dictionary should carry them — and they are',
        'listed at the bottom so the gap is a number rather than a surprise.',
        '',
        '🔴 **A "0" in the last column means no family declares this attribute today**, so there is no',
        '`FamilyAttribute` row to mark. Those need a family decision first, not a requirement decision.',
        '',
        `## Required on more than one channel — candidates for \`channels: []\` (required everywhere) — ${everywhere.length}`,
        '',
        '| code | label | channels | markets | product types | families |',
        '|---|---|---|---|---|---|',
        ...everywhere.map(line),
        '',
        `## Required on exactly one channel — candidates for \`channels: ['<that one>']\` — ${scoped.length}`,
        '',
        '| code | label | channel | markets | product types | families |',
        '|---|---|---|---|---|---|',
        ...scoped.map(line),
        '',
        `## 🔴 Channel-required fields with NO dictionary attribute — ${outsideDictionary.size}`,
        '',
        'D-A cannot mark these: there is no `CustomAttribute`, so no `FamilyAttribute` row exists to',
        'carry a requirement. Listed because leaving them out would make the proposal above look',
        'complete when it is a fraction.',
        '',
        '| key | required by |',
        '|---|---|',
        ...[...outsideDictionary.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, channels]) => `| \`${code}\` | ${[...channels].sort().join(', ')} |`),
        '',
        '## ⬜ Coordinates that could not be read',
        '',
        unreadable.length ? unreadable.map(u => `- ${u}`).join('\n') : '_none_',
        '',
      ].join('\n')
      writeFileSync(MARKDOWN, md)
      console.log(`\nwrote ${MARKDOWN}`)
    }
  })
  process.exit(0)
}

main().catch((error) => { console.error(error); process.exit(1) })
