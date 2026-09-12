/** Complete cached, in-use channel schemas. Plan first; apply uses the normal durable impact
 * review and serializable activation service. No product values or listings are written. */
import { readFile, writeFile, rename } from 'node:fs/promises'
import prisma from '../src/db.js'
import { loadAmazonSpec, loadEbaySpec } from '../src/services/pim/channel-specs/index.js'
import { planProductSource, adaptSourceShape, sourceOwner } from '../src/services/pim/mapping/source-definition-plan.js'
import { ALLOWED_MASTER_FIELDS } from '../src/services/pim/master-field-gate.js'
import { getMappingForMarketplace, getRulesFor } from '../src/services/pim/schema-mapping.service.js'
import { mappingToken } from '../src/services/pim/mapping/revision-token.js'
import { languageForMarketplace } from '../src/services/products/translation-resolver.service.js'
import { getFieldCatalogue } from '../src/services/pim/mapping/field-catalogue.service.js'
import { createMappingImpact, readMappingImpact, runMappingImpact, activateMappingImpact } from '../src/services/pim/mapping/impact.service.js'

const [mode, path = '/tmp/nexus-complete-channel-mapping.json'] = process.argv.slice(2)
if (!['--plan', '--apply'].includes(mode)) throw new Error('Use --plan [file] or --apply <reviewed-plan-file>')
let saving = Promise.resolve()
const save = (file: string, value: unknown) => {
  const body = JSON.stringify(value, null, 2)
  saving = saving.then(async () => { await writeFile(`${file}.writing`, body); await rename(`${file}.writing`, file) })
  return saving
}
const equal = (a: unknown, b: unknown) => mappingToken(a) === mappingToken(b)

async function plan() {
  const [attributes, products, schemas, families, listings, markets] = await Promise.all([
    prisma.customAttribute.findMany({ include: { familyAttributes: true } }),
    prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, parentId: true, familyId: true, productType: true, categoryAttributes: true, variantAttributes: true } }),
    prisma.categorySchema.findMany({ where: { channel: { in: ['AMAZON', 'EBAY'] }, isActive: true }, select: { channel: true, marketplace: true, productType: true } }),
    prisma.productFamily.findMany({ select: { id: true, code: true, parentFamilyId: true } }),
    prisma.channelListing.findMany({ where: { channel: 'EBAY', product: { deletedAt: null } }, select: { productId: true, marketplace: true, platformAttributes: true } }),
    prisma.marketplace.findMany({ where: { channel: { in: ['AMAZON', 'EBAY'] } }, select: { channel: true, code: true } }),
  ])
  const types = new Set(products.map(p => p.productType))
  const byId = new Map(products.map(p => [p.id, p]))
  const familyFor = (id: string): string | null => {
    const seen = new Set<string>(); let product = byId.get(id)
    while (product && !seen.has(product.id)) { seen.add(product.id); if (product.familyId) return product.familyId; product = product.parentId ? byId.get(product.parentId) : undefined }
    return null
  }
  const known = new Set([...ALLOWED_MASTER_FIELDS, 'title', 'sku', ...attributes.map(a => a.code),
    ...products.flatMap(p => [...Object.keys(p.categoryAttributes ?? {}), ...Object.keys(p.variantAttributes ?? {})])])
  const definitions = new Map<string, any>(), scopes: any[] = []
  const coords = [...new Map(schemas.filter(s => s.channel === 'EBAY' || types.has(s.productType))
    .map(s => [`${s.channel}/${s.marketplace.replace('EBAY_', '')}/${s.productType}`, s])).values()]
  for (const c of coords) {
    const market = c.marketplace.replace('EBAY_', '')
    if (!markets.some(m => m.channel === c.channel && m.code === market)) continue
    const spec = c.channel === 'AMAZON' ? await loadAmazonSpec(market, c.productType) : await loadEbaySpec(market, [c.productType])
    if (spec.absent || spec.unrecognised.length) throw new Error(`Schema unavailable or unsupported: ${c.channel}/${market}/${c.productType}`)
    const productIds = c.channel === 'AMAZON' ? products.filter(p => p.productType === c.productType).map(p => p.id)
      : listings.filter(l => l.marketplace === market && String((l.platformAttributes as any)?.categoryId) === c.productType).map(l => l.productId)
    const familyIds = [...new Set(productIds.map(familyFor).filter(Boolean))] as string[]
    const mapping = await getMappingForMarketplace(c.channel, market)
    const existing = getRulesFor(mapping, c.productType)
    const changes: any[] = [], owners: any[] = [], retained: string[] = []
    for (const field of spec.fields) {
      const source = planProductSource(field, spec.channel, languageForMarketplace(market))
      if (source) for (const d of source.definitions) {
        const previous = definitions.get(d.code)
        if (previous && previous.type !== d.type && !['text', 'textarea'].every(t => [previous.type, d.type].includes(t))) throw new Error(`Conflicting source types for ${d.code}: ${previous.type}/${d.type}`)
        definitions.set(d.code, { ...d, shape: previous?.shape === 'list' ? 'list' : d.shape,
          localizable: previous?.localizable || d.localizable, scope: previous?.scope === 'per_variant' ? 'per_variant' : d.scope,
          familyIds: [...new Set([...(previous?.familyIds ?? []), ...familyIds])] })
      }
      const rule = existing[field.key]
      const unknown = rule && !known.has(rule.source.replace(/^categoryAttributes\./, ''))
      if (rule && !unknown) { retained.push(field.key); continue }
      if (rule && unknown && rule.transforms?.length) { retained.push(field.key); continue }
      if (source) changes.push({ fieldKey: field.key, rule: source.rule, field })
      else {
        owners.push({ fieldKey: field.key, ...sourceOwner(field) })
        if (rule && unknown) changes.push({ fieldKey: field.key, rule: null })
      }
    }
    // Remove only exact-category obsolete keys; never delete market defaults used elsewhere.
    for (const key of Object.keys(mapping.byProductType?.[c.productType] ?? {})) if (!spec.fields.some(f => f.key === key)) changes.push({ fieldKey: key, rule: null })
    scopes.push({ channel: c.channel, market, category: c.productType, schemaToken: mappingToken(spec), initialMappingToken: mappingToken(mapping),
      fields: spec.fields.length, productIds, familyIds, changes, owners, retained })
  }
  const listSources = new Set([...definitions.values()].filter(d => d.shape === 'list' && !attributes.some(a => a.code === d.code && a.type !== 'multiselect' && (a.validation as any)?.shape !== 'list')).map(d => d.code))
  for (const scope of scopes) for (const change of scope.changes) { if (change.rule) change.rule = adaptSourceShape(change.rule, change.field, listSources); delete change.field }
  return { createdAt: new Date().toISOString(), productCount: products.length, definitions: [...definitions.values()].sort((a, b) => a.code.localeCompare(b.code)),
    existingDefinitions: attributes.map(a => a.code), scopes,
    unverifiedMarkets: markets.filter(m => !scopes.some(s => s.channel === m.channel && s.market === m.code)), families }
}

async function apply(input: any) {
  const reportPath = `${path}.applied.json`
  let report: any
  try { report = JSON.parse(await readFile(reportPath, 'utf8')) } catch { report = { planToken: mappingToken(input), definitionsAdded: [], familiesAttached: 0, scopes: [] } }
  if (report.planToken !== mappingToken(input)) throw new Error('The plan changed after activation started')
  // Verify every cached contract before installing any dictionary definitions.
  for (const s of input.scopes) {
    const spec = s.channel === 'AMAZON' ? await loadAmazonSpec(s.market, s.category) : await loadEbaySpec(s.market, [s.category])
    if (mappingToken(spec) !== s.schemaToken) throw new Error(`Schema changed: ${s.channel}/${s.market}/${s.category}; create a new plan`)
    if (!report.scopes.some((r: any) => r.channel === s.channel && r.market === s.market) && mappingToken(await getMappingForMarketplace(s.channel, s.market)) !== s.initialMappingToken) throw new Error(`Mapping changed: ${s.channel}/${s.market}; create a new plan`)
  }
  const installed = await prisma.$transaction(async tx => {
    const currentFamilies = await tx.productFamily.findMany({ select: { id: true, code: true, parentFamilyId: true } })
    const sorted = (rows: any[]) => rows.slice().sort((a, b) => a.id.localeCompare(b.id))
    if (!equal(sorted(currentFamilies), sorted(input.families))) throw new Error('Family definitions changed; create a new plan')
    const groups = [...new Set(input.definitions.map((d: any) => d.group))] as string[]
    await tx.attributeGroup.createMany({ data: groups.map(code => ({ code, label: code === 'compliance' ? 'Compliance' : 'Specifications' })), skipDuplicates: true })
    const groupRows = await tx.attributeGroup.findMany({ where: { code: { in: groups } } })
    const existing = await tx.customAttribute.findMany({ select: { id: true, code: true } })
    const added = input.definitions.filter((d: any) => !existing.some(a => a.code === d.code))
    await tx.customAttribute.createMany({ data: added.map((d: any) => ({ code: d.code, label: d.label,
      groupId: groupRows.find(g => g.code === d.group)!.id, type: d.type, validation: { shape: d.shape },
      localizable: d.localizable, scope: d.scope,
      description: 'Shared product fact used by channel mappings. Supply only verified product data; channel requirements are validated separately.' })), skipDuplicates: true })
    const attributes = await tx.customAttribute.findMany({ select: { id: true, code: true } })
    const links = await tx.familyAttribute.findMany({ select: { familyId: true, attributeId: true } })
    const present = new Set(links.map(l => `${l.familyId}/${l.attributeId}`)), attachments: any[] = []
    for (const d of input.definitions) {
      const attributeId = attributes.find(a => a.code === d.code)!.id
      for (const familyId of d.familyIds) {
        let current = familyId; let inherited = false; const seen = new Set<string>()
        while (current && !seen.has(current)) {
          seen.add(current)
          if (present.has(`${current}/${attributeId}`)) { inherited = true; break }
          current = currentFamilies.find(f => f.id === current)?.parentFamilyId
        }
        if (!inherited) { attachments.push({ familyId, attributeId, required: false, channels: [], sortOrder: 1000 }); present.add(`${familyId}/${attributeId}`) }
      }
    }
    await tx.familyAttribute.createMany({ data: attachments, skipDuplicates: true })
    return { added: added.map((d: any) => d.code), attached: attachments.length }
  }, { isolationLevel: 'Serializable', timeout: 60_000 })
  report.definitionsAdded = [...new Set([...report.definitionsAdded, ...installed.added])]
  report.familiesAttached += installed.attached
  await save(reportPath, report)
  const applyScope = async (s: any) => {
    let result = report.scopes.find((r: any) => r.channel === s.channel && r.market === s.market && r.category === s.category)
    if (result?.applied) return
    const mapping = await getMappingForMarketplace(s.channel, s.market)
    const changes = s.changes.filter((c: any) => !equal(mapping.byProductType?.[s.category]?.[c.fieldKey] ?? null, c.rule))
    if (!changes.length) {
      // Activation can commit before an interrupted CLI writes its local receipt.
      if (result?.jobId && (await readMappingImpact(result.jobId, null))?.state === 'MAPPING_APPLIED') {
        result.applied = true; result.state = 'MAPPING_APPLIED'
        result.catalogue = (await getFieldCatalogue({ channel: s.channel, marketplace: s.market, productType: s.category })).counts
        await save(reportPath, report)
      }
      return
    }
    if (!result) { result = { channel: s.channel, market: s.market, category: s.category, rules: changes.length }; report.scopes.push(result) }
    if (result.state === 'MAPPING_STALE' || result.state === 'MAPPING_FAILED') {
      result.previousReviews = [...(result.previousReviews ?? []), result.jobId].filter(Boolean)
      if (result.activationError) {
        result.previousReviewErrors = [...(result.previousReviewErrors ?? []), { jobId: result.jobId, message: result.activationError }]
        delete result.activationError
      }
      if (result.previousReviews.length > 2) throw new Error('Inputs keep changing during review; inspect the concurrent writer before retrying')
      delete result.jobId; delete result.state
    }
    if (!result.jobId) {
      const review = await createMappingImpact({ channel: s.channel, market: s.market, category: s.category, changes, expectedToken: mappingToken(mapping), userId: null })
      result.jobId = review.jobId; await save(reportPath, report)
    }
    for (let attempt = 0; attempt < 600; attempt++) {
      const review = await readMappingImpact(result.jobId, null)
      if (!review) throw new Error('Review disappeared')
      if (review.state !== 'MAPPING_SCANNING') {
        result.state = review.state; result.counts = review.counts; result.errors = review.errors; await save(reportPath, report)
        if (review.state !== 'MAPPING_REVIEW') throw new Error(`Review ${result.jobId}: ${review.state} ${JSON.stringify(review.errors)}`)
        if (review.counts.introducedInvalid) throw new Error(`Review ${result.jobId} introduces ${review.counts.introducedInvalid} invalid outputs; correct the plan`)
        try { await activateMappingImpact(result.jobId, null) }
        catch (error) {
          result.activationError = error instanceof Error ? error.message : String(error)
          if (/Resolution inputs changed/.test(result.activationError)) result.state = 'MAPPING_STALE'
          await save(reportPath, report); throw error
        }
        result.applied = true; result.state = 'MAPPING_APPLIED'
        result.catalogue = (await getFieldCatalogue({ channel: s.channel, marketplace: s.market, productType: s.category })).counts
        await save(reportPath, report); console.log(JSON.stringify(result)); break
      }
      if (attempt % 10 === 0) void runMappingImpact(result.jobId)
      await new Promise(resolve => setTimeout(resolve, 500))
      if (attempt === 599) throw new Error('Review is still running; resume the same plan')
    }
  }
  // A marketplace owns one mapping document: its categories must stay sequential.
  // Separate marketplaces have independent revision tokens. Bound their review work
  // to three queues, and serialize atomic receipt writes across those queues.
  const markets = new Map<string, any[]>()
  for (const s of input.scopes) {
    const key = `${s.channel}/${s.market}`
    markets.set(key, [...(markets.get(key) ?? []), s])
  }
  const pending = [...markets.values()], errors: unknown[] = []
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (pending.length) {
      const scopes = pending.shift()!
      try { for (const scope of scopes) await applyScope(scope) }
      catch (error) { errors.push(error); console.error(error) }
    }
  }))
  if (errors.length) throw new AggregateError(errors, 'Some markets need a corrected or fresh review; completed markets were retained')
  return report
}

try {
  if (mode === '--plan') { const result = await plan(); await save(path, result); console.log(JSON.stringify({ path, products: result.productCount, definitions: result.definitions.length, scopes: result.scopes.length, changes: result.scopes.reduce((n, s) => n + s.changes.length, 0), unverifiedMarkets: result.unverifiedMarkets })) }
  else await apply(JSON.parse(await readFile(path, 'utf8')))
} catch (error) { console.error(error); process.exitCode = 1 }
finally { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) }
