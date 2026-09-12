/** Read-only mapping inventory for a real preview product across configured Amazon/eBay markets.
 * Reports every field, source, override-only value, unresolved output and obsolete authored rule.
 * Does not activate mappings, create product values or publish listings. */
import { writeFile } from 'node:fs/promises'
const base = process.env.MAPPING_AUDIT_API ?? 'http://localhost:8091'
const productId = process.env.MAPPING_AUDIT_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const output = process.env.MAPPING_AUDIT_OUTPUT ?? '/tmp/nexus-mapping-workspace-audit.json'
async function read(path: string, body?: unknown) {
  const response = await fetch(`${base}/api/pim/${path}`, {
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  })
  const result = await response.json() as any
  if (!response.ok) throw new Error(`${response.status}: ${result.message ?? result.error}`)
  return result
}
const { templates } = await read('channel-mapping/templates')
const markets: any[] = []
for (const template of templates.filter((t: any) => ['AMAZON', 'EBAY'].includes(t.channel))) {
  const coordinate = `${template.channel}/${template.code}`
  try {
    const result = await read(`channel-mapping/${coordinate}/resolve`, { productIds: [productId] })
    const catalogue = result.catalogue
    const product = result.products[0]
    if (!catalogue || !product) throw new Error('Preview product or field catalogue unavailable')
    const sourceCatalogue = await read(`channel-mapping/${coordinate}/sources?productId=${encodeURIComponent(productId)}`)
    const available = new Set(sourceCatalogue.sources.map((s: any) => s.path))
    const suggestions = await read(`mappings/${coordinate}/suggest?${new URLSearchParams({ productId, ...(catalogue.productType ? { productType: catalogue.productType } : {}) })}`)
    const fields = catalogue.fields.map((field: any) => {
      const cell = product.cells[field.fieldKey]
      const rule = cell?.rule ?? field.rule
      return {
        field: field.fieldKey, label: field.label, priority: field.priority, schemaKnown: field.schemaKnown,
        sharedOrigin: field.ruleOrigin ?? null, effectiveRuleOrigin: cell?.ruleOrigin ?? null,
        source: rule?.source || null, sourceKnown: rule?.source ? available.has(rule.source) : null,
        provenance: cell?.provenance ?? null, hasValue: cell?.value != null && cell.value !== '' && (!Array.isArray(cell.value) || cell.value.length > 0),
        errors: cell?.errors ?? [], warnings: cell?.warnings ?? [],
      }
    })
    const report = { channel: template.channel, market: template.code, category: catalogue.productType,
      schema: catalogue.schema, sharedCounts: catalogue.counts, resolvedCounts: product.counts,
      sourceDefinitions: available.size, suggestions: suggestions.suggestions,
      knownRules: fields.filter((f: any) => f.source).length,
      overrideOnly: fields.filter((f: any) => !f.source && f.provenance === 'override').length,
      withoutRuleOrValue: fields.filter((f: any) => !f.source && !f.hasValue).length,
      unknownAuthoredSources: fields.filter((f: any) => f.sharedOrigin && f.sharedOrigin !== 'master' && f.sourceKnown === false),
      fields }
    markets.push(report)
    console.log(JSON.stringify({ ...report, fields: undefined, suggestions: report.suggestions.length, unknownAuthoredSources: report.unknownAuthoredSources.map((f: any) => `${f.field} ← ${f.source}`) }))
  } catch (error) {
    const failure = { channel: template.channel, market: template.code, error: String(error) }
    markets.push(failure); console.log(JSON.stringify(failure))
  }
}
await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), productId,
  scope: 'One preview product across configured markets; this is not a full-catalog content audit.',
  productValuesChanged: 0, mappingsActivated: 0, markets }, null, 2))
if (markets.some(m => m.error)) process.exitCode = 1
