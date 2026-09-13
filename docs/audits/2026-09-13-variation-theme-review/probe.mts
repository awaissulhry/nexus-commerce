/** Read-only audit: real resolver, and real write function bodies with in-memory I/O. No DB or provider imports. */
import fs from 'node:fs'
import ts from 'typescript'
import { resolveVariationProjection, foldAvailability } from '../../../apps/api/src/services/pim/variation-rules.service.js'
import { canonicalVariantAxis } from '../../../apps/api/src/services/pim/variant-attribute-keys.js'
import { parseThemeAxes } from '../../../apps/api/src/services/ebay-theme-axes.js'
import { orderedVariationMapping } from '../../../packages/shared/variation-mapping.js'

const report: Record<string, unknown> = {}
const base: any = {
  coordinate: { channel: 'SHOPIFY', market: 'GLOBAL', accountId: 'account', aliasKey: '', label: 'Shopify · GLOBAL' },
  family: { familyAxes: ['Color', 'Size'], axisLabels: { color: 'Color', size: 'Size' }, productVersion: 1, productTheme: null, childIds: ['a', 'b'] },
  listing: { version: 1, variationTheme: null, variationMapping: null, platformAttributes: {}, externalListingId: null, listingStatus: 'DRAFT' },
  schema: {}, rule: null, limits: { axes: 3 }, vocabulary: { axisNoun: 'option', axisNounPlural: 'options', sectionTitle: 'Variation theme' },
}
const named = resolveVariationProjection({ ...base, listing: { ...base.listing, variationMapping: { axes: [{ axisKey: 'Color', target: 'Finish', order: 0 }] } } })
report.namedAxisRemoval = { storedMapping: ['Color → Finish'], renderedAxes: named.axes.map(a => ({ key: a.axisKey, target: a.target, included: a.included })), dropped: named.dropped }
const ebay: any = { ...base, coordinate: { ...base.coordinate, channel: 'EBAY', market: 'IT', label: 'eBay · IT' }, schema: { ebay: { categoryId: 'test', aspects: [{ name: 'Colore', englishName: 'Color', variantEligible: true }, { name: 'Taglia', englishName: 'Size', variantEligible: true }] } } }
const ebayRule = resolveVariationProjection({ ...ebay, rule: { label: 'Only size', category: 'test', theme: null, mapping: [{ axisKey: 'Size', target: 'Taglia', order: 0 }] } })
report.ebayRule = { source: ebayRule.source, delivered: ebayRule.axes.filter(a => a.included).map(a => a.channelName) }
const ebayOverride = resolveVariationProjection({ ...ebay, listing: { ...ebay.listing, platformAttributes: { _variationAxes: ['Color', 'Size'], _axisNameLabels: { Color: 'Taglia', Size: 'Colore' } } } })
report.ebayExplicitNames = { stored: { Color: 'Taglia', Size: 'Colore' }, rendered: ebayOverride.axes.map(a => ({ axis: a.familyKey, target: a.target })) }
const limited = resolveVariationProjection({ ...base, family: { ...base.family, familyAxes: ['Color', 'Size', 'Material', 'Style'] } })
report.limitAddList = { dropped: limited.dropped, addable: limited.addableAxes }

// Compile these declarations verbatim from the source AST. Dependencies are supplied in memory;
// this tests the production decision/write bodies without loading a service graph or touching a database.
const sourcePath = new URL('../../../apps/api/src/services/pim/family-projection.service.ts', import.meta.url)
const source = ts.createSourceFile(String(sourcePath), fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true)
const names = new Set(['writeProjectionMapping', 'resetProjectionOverride', 'collisionReportFor', 'ProjectionConflictError', 'ProjectionRequestError', 'ProjectionCollisionError'])
const declarations = source.statements.filter(n => 'name' in n && n.name && names.has(n.name.getText(source))).map(n => n.getText(source)).join('\n')
if (names.size !== source.statements.filter(n => 'name' in n && n.name && names.has(n.name.getText(source))).length) throw new Error('Audit declaration selection drifted')
const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText

async function runWrite(channel: string, input: object, opts: { live?: boolean; ownAxes?: string[]; emptyTargets?: boolean; concurrentVersion?: number } = {}) {
  const writes: any[] = []
  const root: any = { id: 'parent', version: 1, variationTheme: 'Color,Size' }
  const listing: any = { id: 'listing', version: 1, variationTheme: 'COLOR/SIZE', platformAttributes: opts.ownAxes ? { _variationAxes: [...opts.ownAxes] } : {}, variationMapping: null }
  const current: any = {
    version: 1, coordinate: { channel, market: 'IT', accountId: 'account', aliasKey: '', channelLabel: channel, label: `${channel} · IT` },
    mapping: [{ axisKey: 'Color', target: 'color', order: 0 }, { axisKey: 'Size', target: 'size', order: 1 }],
    axes: [{ key: 'Color', label: 'Color' }, { key: 'Size', label: 'Size' }],
    children: [{ id: 'a', sku: 'A', included: true, sharedAxisValues: { Color: 'red', Size: 'S' } }, { id: 'b', sku: 'B', included: true, sharedAxisValues: { Color: 'blue', Size: 'M' } }],
    limits: { axes: 5, source: { axes: 'fixture' } }, vocabulary: base.vocabulary,
    targetOptions: opts.emptyTargets ? [] : [{ code: 'color' }, { code: 'size' }], freeform: false,
    theme: { value: 'COLOR/SIZE', options: ['COLOR/SIZE', 'SIZE/COLOR'] },
    split: { creatable: false, heldReason: 'held' },
    locked: opts.live ? { reason: 'live coordinate', orderChangeAllowed: false } : null,
  }
  const tx: any = {
    channelListing: {
      findUnique: async () => ({ ...listing }),
      update: async (arg: any) => {
        if (opts.concurrentVersion) listing.version = opts.concurrentVersion
        if (arg.where.version !== undefined && listing.version !== arg.where.version) throw new Error('CAS refused')
        writes.push({ store: 'listing', ...arg }); Object.assign(listing, arg.data); return listing
      },
    },
    product: { update: async (arg: any) => { writes.push({ store: 'product', ...arg }); Object.assign(root, arg.data); return root } },
  }
  const deps: Record<string, any> = {
    prisma: { ...tx, channelListing: { ...tx.channelListing, findFirst: async () => listing }, $transaction: async (fn: any) => fn(tx) },
    getProjectionRead: async () => current,
    resolveFamilyRoot: async () => root,
    canonicalVariantAxis, parseThemeAxes, orderedVariationMapping, foldAvailability, ALIAS_HELD_REASON: 'held',
  }
  const api: any = {}
  new Function('exports', ...Object.keys(deps), compiled)(api, ...Object.values(deps))
  try {
    await api.writeProjectionMapping({ productId: 'parent', channel, market: 'IT', expectedVersion: 1, ...input })
    return { outcome: 'accepted', writes, finalProductTheme: root.variationTheme, finalOwnAxes: listing.platformAttributes._variationAxes ?? null }
  } catch (error: any) { return { outcome: 'refused', code: error.code, message: error.message, writes } }
}
report.ebayScopedRemoval = await runWrite('EBAY', { mapping: [{ axisKey: 'Color', target: 'color' }] }, { ownAxes: ['Color', 'Size'] })
report.liveReset = await runWrite('AMAZON', { reset: true }, { live: true })
report.liveThemeChange = await runWrite('AMAZON', { theme: 'SIZE/COLOR' }, { live: true })
report.invalidTheme = await runWrite('AMAZON', { theme: 'NOT_A_THEME' })
report.unavailableSchemaTarget = await runWrite('AMAZON', { mapping: [{ axisKey: 'Color', target: 'invented_attribute' }, { axisKey: 'Size', target: 'size' }] }, { emptyTargets: true })
report.concurrentSave = await runWrite('AMAZON', { theme: 'SIZE/COLOR' }, { concurrentVersion: 2 })
report.positiveControls = {
  invalidTargetWithKnownSchema: await runWrite('AMAZON', { mapping: [{ axisKey: 'Color', target: 'invented_attribute' }, { axisKey: 'Size', target: 'size' }] }),
  ordinaryLiveSetChange: await runWrite('AMAZON', { mapping: [{ axisKey: 'Color', target: 'color' }] }, { live: true }),
  ebayAtomicVersionGuard: await runWrite('EBAY', { mapping: [{ axisKey: 'Color', target: 'color' }] }, { concurrentVersion: 2 }),
}
const ruleSource = ts.createSourceFile('variation-rule-view.service.ts', fs.readFileSync(new URL('../../../apps/api/src/services/pim/variation-rule-view.service.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const ruleNames = new Set(['hasOwnOverride', 'simulateVariationRule'])
const ruleCode = ruleSource.statements.filter(n => 'name' in n && n.name && ruleNames.has(n.name.getText(ruleSource))).map(n => n.getText(ruleSource)).join('\n')
const ruleApi: any = {}
new Function('exports', 'canonicalVariantAxis', 'familiesFor', ts.transpileModule(ruleCode, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(ruleApi, canonicalVariantAxis, async () => [{ variationAxes: ['Color', 'Size'], channelListings: [], children: [{ Color: 'red', Size: 'S' }, { Color: 'blue', Size: 'M' }] }])
report.ruleCollisionEstimate = {
  variants: [{ Color: 'red', Size: 'S' }, { Color: 'blue', Size: 'M' }],
  proposedAxes: ['Color'], actualCollisionGroups: 0,
  simulated: await ruleApi.simulateVariationRule({ channel: 'AMAZON', market: 'IT', rule: { axes: [{ axisKey: 'Color', target: 'color', included: true, order: 0 }] } }),
}
fs.writeFileSync(new URL('./probe-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
