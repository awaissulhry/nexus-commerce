/** railway run --no-local -e production -s @nexus/api -- node docs/audits/2026-09-12-language-axis/step3/shadow.mjs
 * Only SELECT/BEGIN READ ONLY/ROLLBACK. No application, Prisma, jobs, providers, or writer bootstrap.
 * Rebuild with build-shadow.mjs first; source hashes are checked before connecting.
 */
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { compareProductionContent, classifyContentDiff, reclassifications, extractLocaleTitle, productResolvedContent } from './shadow-runtime.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const write = (name, value) => writeFile(new URL(name, import.meta.url), JSON.stringify(value, null, 2) + '\n')
const build = JSON.parse(await readFile(new URL('./shadow-build.json', import.meta.url)))
for (const file of build.files) assert.equal(sha(await readFile(file.file)), file.sha256, `Shadow input changed: ${file.file}; rebuild before running.`)
assert.equal(sha(await readFile(new URL('./shadow-runtime.mjs', import.meta.url))), build.bundleSha256)

function controls() {
  const product = { id: 'control', parentId: null, sku: 'LX3-CONTROL', name: 'Italian source', localizedContent: {}, categoryAttributes: {}, variantAttributes: {}, translations: [] }
  const listing = { id: 'control-listing', productId: product.id, channel: 'AMAZON', marketplace: 'BE', title: 'Dutch pin', followMasterTitle: true }
  const comparison = compareProductionContent({ products: [product], listings: [listing], translations: [], marketplaces: [{ channel: 'AMAZON', code: 'BE', languages: ['nl', 'fr'] }], extractLocaleTitle })
  assert.equal(comparison.coveredListings, 1)
  assert.equal(comparison.counts.find(c => c.reader === 'attribute-coordinate' && c.field === 'title' && c.language === 'nl').compared, 1)
  assert.ok(comparison.diffs.some(d => d.language === 'nl' && d.classification === 'R2-default-language-listing-pin' && d.next.value === 'Dutch pin'))
  assert.ok(comparison.diffs.some(d => d.language === 'fr' && d.next.value === 'Italian source'))
  const next = { value: 'INJECTED DEFECT', tier: 'source', language: 'it', requested: 'fr', provenance: { member: 'inherited', from: null } }
  assert.equal(classifyContentDiff({ old: { value: 'Italian source' }, next, product, field: 'title', reader: 'attribute-coordinate' }), 'UNCLASSIFIED')
  return { passed: 5, total: 5, injectedDefectRejected: true, belgiumBothLanguages: true }
}
const positiveControls = controls()
if (process.argv.includes('--self-test')) { console.log(JSON.stringify(positiveControls)); process.exit(0) }
assert.equal(process.env.RAILWAY_ENVIRONMENT_NAME, 'production', 'Use Railway production --no-local.')
assert.equal(process.env.RAILWAY_SERVICE_NAME, '@nexus/api', 'Use the production API service.')
assert.ok(process.env.DATABASE_URL, 'Railway DATABASE_URL missing.')
const target = new URL(process.env.DATABASE_URL)
assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Shadow refuses local development databases.')
const db = new Client({ connectionString: target.href, application_name: 'nexus-lx3-readonly-shadow', connectionTimeoutMillis: 15000, statement_timeout: 60000 })
const report = { startedAt: new Date().toISOString(), target: { environment: process.env.RAILWAY_ENVIRONMENT_NAME, service: process.env.RAILWAY_SERVICE_NAME, host: target.hostname, database: target.pathname.slice(1) }, build, positiveControls, scriptSha256: sha(await readFile(new URL('./shadow.mjs', import.meta.url))), coverage: [], flag: 'unchanged; no consumer imports v2', classifications: reclassifications }
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
  const comparison = compareProductionContent({ products, listings, marketplaces, translations, localizableKeysByProduct, extractLocaleTitle, productResolvedContent })
  const { diffs, ...summary } = comparison
  Object.assign(report, summary)
  report.totalCompared = summary.counts.reduce((n, row) => n + row.compared, 0)
  report.totalDiffs = diffs.length
  report.valueDiffs = diffs.filter(row => row.valueChanged).length
  report.unclassified = diffs.filter(row => row.classification === 'UNCLASSIFIED').length
  report.gate = diffs.length ? 'HOLD — no reader or flag switch until Owner reviews the written list; unclassified differences are defects' : 'PASS — zero diffs'
  await db.query('ROLLBACK'); report.rolledBack = true; report.finishedAt = new Date().toISOString()
  const detail = gzipSync(JSON.stringify({ diffs }))
  await writeFile(new URL('./production-diffs.json.gz', import.meta.url), detail)
  report.details = { path: 'production-diffs.json.gz', sha256: sha(detail), diffCount: diffs.length }
  await write('./production-shadow.json', report)
  // Every diff is printed to a file (including full values); terminal output stays bounded.
  await writeFile(new URL('./production-diffs.jsonl', import.meta.url), diffs.map(row => JSON.stringify(row)).join('\n') + '\n')
  console.log(JSON.stringify({ target: report.target, transaction: report.transaction, rolledBack: report.rolledBack, family: report.family, population: report.population, totalCompared: report.totalCompared, totalDiffs: report.totalDiffs, valueDiffs: report.valueDiffs, unclassified: report.unclassified, classificationCounts: summary.classificationCounts, gate: report.gate }, null, 2))
  process.exitCode = diffs.length ? 2 : 0
} catch (error) {
  report.error = String(error)
  report.rolledBack = await db.query('ROLLBACK').then(() => !!report.transaction, () => false)
  await write('./shadow-error.json', report)
  throw error
} finally { await db.end() }
