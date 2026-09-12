/** Rebuild the inventory from the recorded store schema and production registry. No network or writes to a store. */
import { readFile, writeFile } from 'node:fs/promises'
import { informationRegistry, shopifyMappingFieldKey } from '../../../packages/shared/shopify-information.js'
import { shopifyTypeReason, shopifyMeasurementUnits } from '../../../packages/shared/shopify-field-codecs.js'
import { shopifyProductSpec } from '../../../apps/api/src/services/pim/channel-specs/store.js'
const evidence = JSON.parse(await readFile(new URL('./live-capabilities-1.json', import.meta.url), 'utf8'))
const definitionsEvidence = JSON.parse(await readFile(new URL('./live-definition-capabilities-1.json', import.meta.url), 'utf8'))
const schema = definitionsEvidence.schema, fields = informationRegistry(schema), spec = shopifyProductSpec(schema, 'SELECTED_ACCOUNT')
const item = (v: unknown) => String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
const row = (values: unknown[]) => '| ' + values.map(item).join(' | ') + ' |'
const product = new Set(['title','descriptionHtml','tags','status','category','productType','vendor','templateSuffix','seo.title','seo.description','handle'])
const inventory = new Set(['sku','cost','tracked','requiresShipping','harmonizedSystemCode','countryCodeOfOrigin','weight'])
function operation(f: typeof fields[number]) {
  if(f.definition) return 'metafieldsSet (compareDigest); metafieldsDelete for clear + readback'
  if(f.id==='inventory') return 'inventorySetQuantities (changeFromQuantity + @idempotent)'
  if(f.id==='salesChannels') return 'publishablePublish / publishableUnpublish + readback'
  if(f.id==='media') return 'Reviewed common-sheet sync: fileCreate, fileUpdate associations, productReorderMedia; exact variant append/detach; image-alt translations + readback'
  if(f.reason) return '—'
  return product.has(f.id) ? 'productUpdate + readback' : 'productVariantsBulkUpdate (one exact variant; nested inventoryItem where applicable) + readback'
}
function editor(f: typeof fields[number]) {
  if(f.reason) return 'Details with specific reason'
  if(f.id==='media') return 'Common ProductMediaDialog (all channels)'
  if(f.id==='inventory') return 'ShopifyNativeEditor: exact location quantities'
  if(f.id==='salesChannels') return 'ShopifyNativeEditor: publication choices and UTC schedule'
  if(!f.definition) return 'ShopifyNativeEditor: ' + (['category','status','countryCodeOfOrigin','inventoryPolicy'].includes(f.id)?'schema choices/reference':f.id==='unitPriceMeasurement'||f.id==='weight'?'typed measurement':f.type)
  const base=f.type.replace(/^list\./,'')
  return (f.type.startsWith('list.')?'OrderedList → ':'')+(base.endsWith('_reference')?'ReferencePicker':shopifyMeasurementUnits[base]||['money','rating','link'].includes(base)?'ShopifyCompoundEditor':base==='rich_text_field'?'ShopifyRichText':base==='json'?'Nexus JSON Textarea':'LinkedFieldEditor: '+base)
}
function read(f: typeof fields[number]) {
 if(f.definition) return 'readLinkedOwners / readInformation owner metafields (batched)'
 if(f.id==='media') return 'readProductMedia / resolveMediaCollection; exact Nexus product/listing collection'
 if(f.id==='inventory') return 'readInformationInventory: inventoryItem.inventoryLevels (paginated)'
 if(f.id==='publishDate') return 'Product.publishedAt (Online Store)'
 if(['salesChannels','scheduled'].includes(f.id)) return 'resourcePublicationsV2 (paginated)'
 if(f.id==='cost')return 'ProductVariant.inventoryItem.unitCost.amount'
 if(f.id==='weight')return 'ProductVariant.inventoryItem.measurement.weight'
 if(f.id==='package')return 'Unavailable in pinned schema; no synthetic value'
 return 'readInformation: '+(product.has(f.id)?'Product.':inventory.has(f.id)?'ProductVariant.inventoryItem.':'ProductVariant.')+f.id
}
const lines=[`# Shopify Information field coverage`, '', `Generated from production registry and the read-only definition schema observed ${definitionsEvidence.observedAt}; native reader evidence ${evidence.observedAt}. Pinned API: **2026-07**.`, '',
`There are **${fields.length} logical fields / ${fields.reduce((n,f)=>n+(f.id==='inventory'?2:1),0)} chooser columns**: 30 native logical fields and ${schema.definitions.length} discovered product/variant definitions. **${fields.filter(f=>!f.reason).length} logical fields have editors and synchronization adapters** for applicable, authorized rows. No live Shopify mutation was made.`, '',
'Every channel uses the common ChannelSheet and the existing Nexus rows. Product/variant owner IDs are resolved from exact listings or the persisted publication map. Native values below belong to the exact Shopify product/variant. Unlinked values belong to the selected Nexus listing, resolved account + GLOBAL + alias + locale; saving does not mutate the shared Product. Product fields apply to the parent/single product, variant fields to sellable variant rows. Inventory becomes applicable after Shopify inventory IDs and stocking locations exist.', '',
'**Evidence key:** R = production read adapter exercised against the real store/pinned schema; C = automated codec/schema/routing/writer contracts; B = historical browser fixture on production components, before the common-sheet consolidation. See COMMON-CHANNEL-SHEET.md for current browser evidence. C is shared adapter coverage, not a mutation of each live definition. **No field has a live write round-trip claim.**', '',
'**Persistence key:** linked fields use the listing’s versioned `_nexusLinkedProducts` document (`sheetValues` keeps content overrides after sync; `nativeEdits` or `edits` retains pending intent; legacy `mediaEdits` remains reviewable) with baseline/digest. The API workspace exposes this document as `draft`; table paths use that API prefix. Unlinked fields use the exact listing column or `platformAttributes` path shown. Translations use `_shopifyInformationLocales[locale][fieldId]`, then verified `translationsRegister` / `translationsRemove`, only when Shopify exposes a translatable resource/key. Shared fields have no independent locale value. This editor exposes GLOBAL base values; it does not create Shopify Markets money overrides.', '',
row(['Column / stable ID','Owner; type','Applicability / restriction','Read adapter','Editor','Nexus persistence (linked; unlinked)','Shopify operation','Verification']),row(Array(8).fill('---'))]
for(const f of fields) for(const physical of f.id==='inventory'?[['availableQuantity','Available quantity'],['onHandQuantity','On hand quantity']]:[[f.id,f.label]]) {
 const c=spec.fields.find(c=>c.key===(f.id==='inventory'?physical[0]:shopifyMappingFieldKey(f,'SELECTED_ACCOUNT')))
 const path=c?.channelStore?.kind==='listingColumn'?`listing.${c.channelStore.column}`:c?.channelStore?.kind==='platformAttributes'?`platformAttributes.${c.channelStore.path.join('.')}`:'separate media workspace'
 const linked=f.reason?'—':f.definition?'draft.sheetValues + draft.edits':f.id==='media'?'_productMediaLocales (common media writer)':f.id==='inventory'?'draft.nativeEdits until verified; then live location stock':'draft.sheetValues + draft.nativeEdits'
 const applicable=f.reason??(f.owner==='PRODUCT'?'Product row':'Variant row')+(f.id==='inventory'?'; unlinked draft: requires Shopify inventory item and location first':'')+(f.definition?.constraints?.key?`; Shopify ${f.definition.constraints.key} constraint: ${f.definition.constraints.values.length} exact allowed subtypes; fresh applicability checked before writes`:'')
 const browser=['title','media'].includes(f.id)?'; B representative workflow':f.definition&&['page_reference','single_line_text_field','rich_text_field'].includes(f.type)?'; B representative type (synthetic/Size Chart)':''
 lines.push(row([`${physical[1]} — \`${physical[0]}\``,`${f.owner}; ${f.type}`,applicable,read(f),editor(f),`${linked}; ${f.id==='media'?'_productMediaLocales → reviewed gallery operation / unlinked content publication':f.id==='inventory'?'Not applicable before publication':f.reason?'—':path}`,operation(f),f.reason?'R schema/restriction':`R; C${browser}`]))
}
lines.push('', '## Dynamically advertised type coverage', '', 'This table includes the pinned API type catalog. Availability of a definition still depends on owner/access/store constraints. New definitions of supported types use the same editor/validator/writer; no merchant key or label is used for routing. Units are the official type contract, enum/reference constraints come from the store schema. Unknown future types retain their raw value and explicitly request a Nexus adapter update.', '', row(['API type','Capability / editor family','Nexus / Shopify persistence','Verification']),row(Array(4).fill('---')))
for(const t of schema.types) {
 const reason=shopifyTypeReason(t.name), base=t.name.replace(/^list\./,'')
 lines.push(row([t.name,reason??((t.name.startsWith('list.')?'Ordered typed list; ':'')+(shopifyMeasurementUnits[base]?'measurement + unit':base.endsWith('_reference')?'exact-store reference picker':base)),reason?'Existing data preserved':'Versioned listing draft → metafieldsSet / metafieldsDelete',reason?'Pinned schema availability checked':'Type-family contract tests; only representative types browser-tested; no live write']))
}
await writeFile(new URL('./FIELD-COVERAGE.md', import.meta.url),lines.join('\n')+'\n')
console.log(`${fields.length} fields; ${schema.types.length} types inventoried`)
const nested = ['', '## Referenced reusable-entry definitions', '', 'These fields are reached through the reference editor, rather than added as grid columns. Selecting a reference saves a Nexus draft. Editing an existing shared entry has a separate, explicit Shopify save and usage review; the operation is `metaobjectUpdate` (or `metaobjectCreate` for a new entry), with exact store/id, revision checks and readback. Unknown and read-only entry fields retain their current data.', '', row(['Definition / type','Field key / name','Owner; value type','Editor capability','Verification']),row(Array(5).fill('---'))]
for(const definition of schema.metaobjectDefinitions) for(const f of definition.fields) nested.push(row([`${definition.name} / ${definition.type}`,`${f.key} / ${f.name}`,`METAOBJECT; ${f.type}`,f.readOnlyReason??shopifyTypeReason(f.type)??'Shared typed editor', 'R definition schema; C generic entry adapter; no live write']))
await writeFile(new URL('./FIELD-COVERAGE.md', import.meta.url),lines.concat(nested).join('\n')+'\n')
