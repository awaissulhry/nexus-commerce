/** One post-switch production shadow, Railway production, read-only snapshot and ROLLBACK. */
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { compareSwitchedReaders, extractLocaleTitle, productResolvedContent, sheetValueForColumn } from './shadow-runtime.mjs'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const write = (name, value) => writeFile(new URL(name, import.meta.url), JSON.stringify(value, null, 2)+'\n')
const build = JSON.parse(await readFile(new URL('shadow-build.json', import.meta.url)))
for (const file of build.files) assert.equal(sha(await readFile(file.file)), file.sha256, `Reader changed after build: ${file.file}`)
assert.equal(sha(await readFile(new URL('shadow-runtime.mjs', import.meta.url))), build.bundleSha256)
const readers = { extractLocaleTitle, productResolvedContent, sheetValueForColumn }
function controls() {
  const parent = { id: 'p', sku: 'P', parentId: null, name: 'Fonte', description: 'Fonte descrizione', bulletPoints: [], keywords: [], categoryAttributes: { material: ['Parent'] }, localizedContent: { de: { title: 'RETIRED' } } }
  const child = { ...parent, id: 'c', parentId: 'p', sku: 'C', name: 'Child source', categoryAttributes: { material: null } }
  const data = { products: [parent, child], translations: [{ productId: 'p', language: 'fr-FR', name: 'Français' }],
    listings: [
      { id: 'be', productId: 'p', channel: 'AMAZON', marketplace: 'BE', title: 'Dutch snapshot', followMasterTitle: true, channelConnectionId: 'a' },
      { id: 'be2', productId: 'p', channel: 'AMAZON', marketplace: 'BE', title: 'Dutch operator', followMasterTitle: false, channelConnectionId: 'b' },
      ...['ETSY','SHOPIFY'].map(channel => ({ id: channel, productId: 'p', channel, marketplace: 'GLOBAL', title: 'Store snapshot', followMasterTitle: true, channelConnectionId: 'store', platformAttributes: { _etsyInformationLocales: { fr: { title: 'RETIRED' } }, _shopifyInformationLocales: { fr: { title: 'RETIRED' } } } })),
    ], marketplaces: [
      { channel: 'AMAZON', code: 'BE', languages: ['nl', 'fr'], schemaMapping: { fields: { title: { source: 'localizedContent.{locale}.title' }, material: { source: 'localizedContent.{locale}.material' } } } },
      ...['ETSY','SHOPIFY'].map(channel => ({ channel, code: 'GLOBAL', languages: ['fr'] })),
    ], localizableKeysByProduct: { '[null,"p"]': ['material'], '[null,"c"]': ['material'] }, ...readers }
  const before = JSON.stringify(data)
  const result = compareSwitchedReaders(data)
  assert.equal(JSON.stringify(data), before)
  assert.deepEqual(result.diffs, [], 'Reader controls must match accepted next values')
  assert.equal(result.coveredListings, 4)
  assert.equal(result.coordinates, 4)
  for (const reader of ['attribute-coordinate','attribute-shared','sheet-wire','sourceContent','mapping-source','global-content','product-content','etsyContentState','shopify-information-native','syndication-title']) assert.ok(result.counts.some(row => row.reader === reader && row.compared > 0), `Vacuous reader: ${reader}`)
  const injected = compareSwitchedReaders({ ...data, sheetValueForColumn: () => 'INJECTED DEFECT' })
  assert.ok(injected.diffs.length > 0 && injected.diffs.every(row => row.reader === 'sheet-wire'))
  return { passed: 15, total: 15, compared: result.counts.reduce((n,row) => n+row.compared,0), injectedDefectRejected: true, belgiumBothLanguages: true, stores: ['ETSY','SHOPIFY'], dataUnchanged: true }
}
const positiveControls = controls()
if (process.argv.includes('--self-test')) { console.log(JSON.stringify(positiveControls)); process.exit(0) }
const acceptedDiffs = JSON.parse(gunzipSync(await readFile(new URL('accepted-production-diffs.json.gz', import.meta.url)))).diffs
const acceptedReport = JSON.parse(await readFile(new URL('accepted-production-shadow.json', import.meta.url)))
assert.equal(process.env.RAILWAY_ENVIRONMENT_NAME, 'production', 'Use Railway production --no-local.')
assert.equal(process.env.RAILWAY_SERVICE_NAME, '@nexus/api', 'Use the production API service.')
assert.ok(process.env.DATABASE_URL, 'Railway DATABASE_URL missing.')
const target = new URL(process.env.DATABASE_URL)
assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Shadow refuses local development databases.')
const db = new Client({ connectionString: target.href, application_name: 'nexus-lx3-switched-readers-readonly', connectionTimeoutMillis: 15000, statement_timeout: 60000 })
const report = { startedAt: new Date().toISOString(), target: { environment: process.env.RAILWAY_ENVIRONMENT_NAME, service: process.env.RAILWAY_SERVICE_NAME, host: target.hostname, database: target.pathname.slice(1) }, build, positiveControls, scriptSha256: sha(await readFile(new URL('./shadow.mjs', import.meta.url))), coverage: [], flag: 'v2 default in source; no deployment/environment write', reference: 'Owner-accepted 2026-09-12T06:39:05.637Z next values' }
try {
  await db.connect()
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  report.transaction = (await db.query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, current_database() AS database, current_user AS role, transaction_timestamp() AS snapshot_at")).rows[0]
  assert.equal(report.transaction.read_only, 'on'); assert.equal(report.transaction.isolation, 'repeatable read')
  const schema = (await db.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'")).rows
  const columns = new Map()
  for (const row of schema) { if (!columns.has(row.table_name)) columns.set(row.table_name, new Set()); columns.get(row.table_name).add(row.column_name) }
  const quote = value => '"' + value.replaceAll('"', '""') + '"'
  async function read(table, required, optional = [], requiredTable = true) {
    const names = columns.get(table)
    if (!names) { assert.ok(!requiredTable, `Missing required table: ${table}`); report.coverage.push({ table, missing: true, rows: null }); return [] }
    for (const name of required) assert.ok(names.has(name), `Missing column ${table}.${name}`)
    const selected = [...new Set([...required, ...optional.filter(name => names.has(name))])]
    const rows = (await db.query(`SELECT ${selected.map(quote).join(',')} FROM ${quote(table)} ORDER BY id`)).rows
    report.coverage.push({ table, rows: rows.length, columns: selected, sha256: sha(JSON.stringify(rows)) })
    return rows
  }
  const marketplaces = await read('Marketplace', ['id', 'channel', 'code', 'languages', 'language', 'isActive'], ['workspaceId', 'schemaMapping'])
  const products = await read('Product', ['id', 'sku', 'parentId', 'name', 'description', 'bulletPoints', 'keywords', 'localizedContent', 'categoryAttributes', 'variantAttributes'], ['workspaceId', 'deletedAt', 'familyId', 'brand', 'productType'])
  const listings = await read('ChannelListing', ['id', 'productId', 'channel', 'marketplace', 'region', 'title', 'description', 'titleOverride', 'descriptionOverride', 'bulletPointsOverride', 'overrideData', 'platformAttributes', 'followMasterTitle', 'followMasterDescription', 'followMasterBulletPoints'], ['workspaceId', 'channelConnectionId', 'aliasId', 'aliasKey'])
  const translations = await read('ProductTranslation', ['id', 'productId', 'language', 'name', 'description', 'bulletPoints', 'keywords', 'attributes', 'sourceHash', 'source', 'reviewedAt'], ['workspaceId'])
  const families = await read('ProductFamily', ['id', 'parentFamilyId'], ['workspaceId'])
  const attributes = await read('CustomAttribute', ['id', 'code', 'localizable'], ['workspaceId'])
  const links = await read('FamilyAttribute', ['id', 'familyId', 'attributeId'], ['workspaceId'])
  const workspace = row => row.workspaceId ?? null
  const key = (row, value = row.id) => JSON.stringify([workspace(row), value])
  const familyMap = new Map(families.map(row => [key(row), row])), attributeMap = new Map(attributes.map(row => [key(row), row])), productMap = new Map(products.map(row => [key(row), row]))
  const localizableKeysByProduct = {}
  for (const product of products) {
    const fields = new Set(), visited = new Set()
    let familyId = product.familyId ?? productMap.get(key(product, product.parentId))?.familyId
    while (familyId) {
      assert.ok(!visited.has(familyId), 'Family hierarchy cycle'); visited.add(familyId)
      for (const link of links.filter(row => key(row, row.familyId) === key(product, familyId))) {
        const attribute = attributeMap.get(key(link, link.attributeId))
        assert.ok(attribute, `Missing linked attribute ${link.attributeId}`)
        if (attribute.localizable) fields.add(attribute.code)
      }
      const family = familyMap.get(key(product, familyId)); assert.ok(family, `Missing family ${familyId}`)
      familyId = family.parentFamilyId
    }
    localizableKeysByProduct[key(product)] = [...fields].sort()
  }
  report.rls = (await db.query("SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname = ANY($1)", [report.coverage.map(row => row.table)])).rows
  report.databaseRole = (await db.query('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
  assert.ok(report.rls.every(row => !row.enabled || report.databaseRole.rolsuper || report.databaseRole.rolbypassrls || row.owner === report.transaction.role && !row.forced), 'RLS may hide catalogue rows.')
  assert.ok(products.length && listings.length && marketplaces.length, 'Empty catalogue cannot pass.')
  const root = products.find(row => row.sku === 'GALE-JACKET')
  assert.ok(root, 'XAVIA GALE-JACKET positive control missing.')
  report.family = { rootId: root.id, sku: root.sku, rows: products.filter(row => key(row) === key(root) || key(row, row.parentId) === key(root)).length }
  report.population = { products: products.length, roots: products.filter(p => !p.parentId).length, activeProducts: products.filter(p => !p.deletedAt).length, listings: listings.length, marketplaces: marketplaces.length, translations: translations.length, customLocalizableFields: [...new Set(Object.values(localizableKeysByProduct).flat())], includesSoftDeleted: true, includesInactiveMarkets: true }
  report.storeInventory = {}
  for (const table of ['ProductSeo', 'APlusContent', 'BrandStory', 'ProductAiDraft', 'CellFormula', 'AssetLocaleOverlay']) {
    const rows = await read(table, ['id'], ['workspaceId', 'locale', 'language'], false)
    report.storeInventory[table] = { rows: rows.length, tags: [...new Set(rows.flatMap(row => [row.locale, row.language].filter(Boolean)))].sort() }
  }
  const comparison = compareSwitchedReaders({ products, listings, marketplaces, translations, localizableKeysByProduct, acceptedDiffs, ...readers })
  const { diffs, ...summary } = comparison
  Object.assign(report, summary)
  report.totalCompared = summary.counts.reduce((n, row) => n + row.compared, 0)
  report.totalDiffs = diffs.length
  report.receiptDiffs = summary.acceptedReceipt.diffs.length
  report.acceptedSnapshotTables = report.coverage.map(row => ({ table: row.table, before: acceptedReport.coverage.find(prior => prior.table === row.table)?.sha256, after: row.sha256, unchanged: acceptedReport.coverage.find(prior => prior.table === row.table)?.sha256 === row.sha256 }))
  report.gate = !diffs.length && !report.receiptDiffs && !summary.acceptedReceipt.missing.length ? 'PASS — zero diffs against accepted next values' : 'HOLD — switched reader or catalogue differences require review'
  await db.query('ROLLBACK'); report.rolledBack = true; report.finishedAt = new Date().toISOString()
  const detail = gzipSync(JSON.stringify({ diffs, receiptDiffs: summary.acceptedReceipt.diffs }))
  await writeFile(new URL('production-diffs.json.gz', import.meta.url), detail)
  report.details = { path: 'production-diffs.json.gz', sha256: sha(detail), diffCount: diffs.length }
  await write('production-shadow.json', report)
  await writeFile(new URL('counts-by-field-language.json', import.meta.url), JSON.stringify(summary.counts, null, 2)+'\n')
  console.log(JSON.stringify({ target: report.target, transaction: report.transaction, rolledBack: report.rolledBack, family: report.family, population: report.population, totalCompared: report.totalCompared, totalDiffs: report.totalDiffs, acceptedReceipt: summary.acceptedReceipt, gate: report.gate }, null, 2))
  process.exitCode = report.gate.startsWith('PASS') ? 0 : 2
} catch (error) {
  report.error = String(error)
  report.rolledBack = await db.query('ROLLBACK').then(() => !!report.transaction, () => false)
  await write('shadow-error.json', report)
  throw error
} finally { await db.end() }
