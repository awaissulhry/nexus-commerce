/** LX.0: run with Railway production variables, never an application/Prisma bootstrap.
 * railway run --no-local -e production -s @nexus/api -- node docs/audits/2026-09-12-language-axis/measure.mjs
 * node docs/audits/2026-09-12-language-axis/measure.mjs --self-test
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { Client } from 'pg'

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const hasText = value => typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.some(hasText) : false
const language = tag => typeof tag === 'string' && /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(tag) ? tag.split(/[-_]/)[0].toLowerCase() : null
const regional = tag => typeof tag === 'string' && /^[a-z]{2,3}[-_](?:[a-z]{2}|[0-9]{3})$/i.test(tag)
const localeBags = new Set(['localizedContent', '_etsyInformationLocales', '_shopifyInformationLocales', '_productMediaLocales', 'translations'])
const hash = value => createHash('sha256').update(value).digest('hex')
const key = parts => JSON.stringify(parts)
const coreFields = { name: 'title', title: 'title', item_name: 'title', description: 'description', product_description: 'description', body_html: 'description', bulletPoints: 'bulletPoints', bullet_point: 'bulletPoints', keywords: 'keywords', generic_keyword: 'keywords', searchTerms: 'keywords' }
const canonicalField = field => coreFields[field] ?? field

// Exact string bytes; arrays retain order and element boundaries. No trim, HTML or case normalization.
function fingerprint(value) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value)
  return { sha256: hash(bytes), bytes: Buffer.byteLength(bytes), kind: Array.isArray(value) ? 'array' : typeof value }
}

function compare(observations) {
  const groups = new Map()
  for (const row of observations) {
    const id = key([row.workspaceId, row.productId, row.field, row.language])
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(row)
  }
  return [...groups.values()].map(rows => {
    const { workspaceId, productId, field, language: locale } = rows[0]
    const channels = [...new Set(rows.map(row => row.channel))].sort()
    const distinct = new Set(rows.map(row => key([row.kind, row.sha256])))
    const classification = channels.length < 2 ? 'single-channel-only' : distinct.size === 1 ? 'byte-identical-across-channels' : 'different-bytes-across-channels'
    return { workspaceId, productId, field, language: locale, channels, classification, distinctValues: distinct.size, observations: rows }
  })
}

function scanTags(value, path, found, parentName = '') {
  if (Array.isArray(value)) return value.forEach((item, index) => scanTags(item, `${path}[${index}]`, found, parentName))
  for (const [name, child] of Object.entries(object(value))) {
    const childPath = `${path}.${name}`
    if (localeBags.has(parentName) && regional(name)) found.push({ path: childPath, tag: name, kind: 'key' })
    if (['locale', 'language', 'language_tag', 'languageTag', 'sourceLocale', 'sourceLanguage'].includes(name) && regional(child)) found.push({ path: childPath, tag: child, kind: 'value' })
    // Flat-file snapshots encode the locale in both language_tag columns and attribute header selectors.
    if (/language_tag/.test(name) && regional(child)) found.push({ path: childPath, tag: child, kind: 'flat-file-value' })
    for (const match of name.matchAll(/(?:language_tag|locale|language)=([a-z]{2,3}[-_](?:[a-z]{2}|[0-9]{3}))(?=\]|$)/gi)) found.push({ path: childPath, tag: match[1], kind: 'header-selector' })
    scanTags(child, childPath, found, name)
  }
}

function selfTest() {
  let checks = 0
  const check = fn => { fn(); checks++ }
  const row = (channel, value, extra = {}) => ({ workspaceId: 'w', productId: 'p', field: 'title', language: 'de', channel, ...fingerprint(value), ...extra })
  check(() => assert.equal(compare([row('AMAZON', 'Hallo'), row('EBAY', 'Hallo')])[0].classification, 'byte-identical-across-channels'))
  check(() => assert.equal(compare([row('AMAZON', 'Hallo'), row('EBAY', 'hallo')])[0].classification, 'different-bytes-across-channels'))
  check(() => assert.equal(compare([row('AMAZON', 'Hallo'), row('AMAZON', 'Anders')])[0].classification, 'single-channel-only'))
  check(() => assert.equal(compare([row('AMAZON', 'Hallo'), row('EBAY', 'Hallo', { workspaceId: 'other' })]).length, 2))
  check(() => assert.equal(compare([row('AMAZON', 'Hallo'), row('EBAY', 'Hallo', { language: 'nl' })]).length, 2))
  check(() => assert.notEqual(fingerprint(' Hallo').sha256, fingerprint('Hallo').sha256))
  check(() => assert.notEqual(fingerprint(['a', 'b']).sha256, fingerprint(['b', 'a']).sha256))
  check(() => assert.notEqual(fingerprint('\u00e9').sha256, fingerprint('e\u0301').sha256))
  check(() => assert.deepEqual(['DE-de', 'nl_BE', 'und', 'default', '', null].map(language), ['de', 'nl', 'und', null, null, null]))
  check(() => assert.deepEqual(['', [''], [], null, 'x', ['x']].map(hasText), [false, false, false, false, true, true]))
  check(() => { const found = []; scanTags({ localizedContent: { 'de-DE': { sourceLocale: 'it_IT' } }, attributes: [{ language_tag: 'nl_BE' }], 'item_name[language_tag=en_GB]': 'x' }, 'fixture', found); assert.deepEqual([...new Set(found.map(item => item.tag))].sort(), ['de-DE', 'en_GB', 'it_IT', 'nl_BE']) })
  check(() => { const found = []; scanTags({ fit_type: 'regular', de_qty: 1, end_at: null, vat_rate: 22, row_action: 'edit' }, 'fixture', found); assert.equal(found.length, 0) })
  check(() => { const found = []; scanTags({ _productMediaLocales: { de_de: {}, es_419: {} }, locale: 'it-IT' }, 'fixture', found); assert.equal(found.length, 3) })
  return { checks, passed: checks }
}

const controls = selfTest()
if (process.argv.includes('--self-test')) {
  console.log(JSON.stringify({ controls }))
} else {
  await measure()
}

async function measure() {
  assert.equal(process.env.RAILWAY_ENVIRONMENT_NAME, 'production', 'Run via Railway production, with --no-local.')
  assert.ok(process.env.DATABASE_URL, 'Railway did not supply DATABASE_URL.')
  const target = new URL(process.env.DATABASE_URL)
  assert.ok(!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname), 'Production probe refuses a local database.')
  const db = new Client({ connectionString: target.href, connectionTimeoutMillis: 15_000, statement_timeout: 60_000, application_name: 'nexus-lx0-readonly' })
  const startedAt = new Date().toISOString()
  const report = {
    startedAt, scriptSha256: hash(await readFile(new URL('./measure.mjs', import.meta.url))), controls,
    target: { environment: process.env.RAILWAY_ENVIRONMENT_NAME, service: process.env.RAILWAY_SERVICE_NAME, databaseHost: target.hostname, database: target.pathname.slice(1) },
    method: {
      population: 'All rows, including soft-deleted products, all workspaces visible to the Railway database role. Workspace participates in every join.',
      comparison: 'Stored text observations, grouped by workspace/product/field/language. Different bytes do not prove intentional channel customization. Strings retain whitespace, HTML, case and Unicode; arrays retain order. No application fallback is synthesized.',
      language: 'Explicit locale/tag wins. Untagged listing columns and core overrideData fields use the unique Marketplace(workspace,channel,code).language, with region fallback only for DEFAULT/empty marketplace. Missing or ambiguous authority is reported, never guessed.',
      fields: 'Core listing text plus every text field in explicitly localized Etsy/Shopify bags, linked sheet values, and Amazon language_tag arrays. Channel-native field names remain distinct unless mapped in coreFields.',
      json: 'JSON is decoded by PostgreSQL: byte comparison concerns stored text values, not original JSON formatting. Media and flat-file snapshots are scanned for tags, never treated as editable text stores.',
    },
    coverage: [], marketplaces: [], slotsByLanguage: {}, translationRowsByLanguage: {}, slotDetails: [], slotTableOverlaps: [], slotSourceComparisons: [], regionalTags: [], unknownLanguages: [], reviewMetadata: [], localeBagCounts: {},
  }
  let connected = false
  try {
    await db.connect(); connected = true
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    report.transaction = (await db.query("SELECT current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation, current_database() AS database, current_user AS role, transaction_timestamp() AS snapshot_at")).rows[0]
    assert.equal(report.transaction.read_only, 'on')
    assert.equal(report.transaction.isolation, 'repeatable read')
    const schema = (await db.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'")).rows
    const columns = new Map()
    for (const row of schema) { if (!columns.has(row.table_name)) columns.set(row.table_name, new Set()); columns.get(row.table_name).add(row.column_name) }
    if (columns.has('_prisma_migrations')) {
      const history = (await db.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name')).rows
      const local = (await readdir(new URL('../../../packages/database/prisma/migrations/', import.meta.url), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
      const applied = new Set(history.filter(row => row.finished_at && !row.rolled_back_at).map(row => row.migration_name))
      report.migrations = { applied: applied.size, localFolders: local.length, pendingLocalFolders: local.filter(name => !applied.has(name)).sort(), unfinished: history.filter(row => !row.finished_at && !row.rolled_back_at) }
    }
    const quote = name => `"${name.replaceAll('"', '""')}"`
    async function read(table, names, optional = []) {
      const available = columns.get(table)
      if (!available) { report.coverage.push({ table, status: 'missing-table', rows: null }); return [] }
      for (const name of names) assert.ok(available.has(name), `Required column missing: ${table}.${name}`)
      const selected = [...names, ...optional.filter(name => available.has(name))]
      const rows = (await db.query(`SELECT ${selected.map(quote).join(', ')} FROM ${quote(table)} ORDER BY "id"`)).rows
      report.coverage.push({ table, status: 'read', rows: rows.length, columns: selected, optionalColumnsAbsent: optional.filter(name => !available.has(name)) })
      return rows
    }
    const markets = await read('Marketplace', ['id', 'channel', 'code', 'language', 'isActive'], ['workspaceId', 'languages'])
    const products = await read('Product', ['id', 'sku', 'parentId', 'name', 'description', 'bulletPoints', 'keywords', 'localizedContent', 'categoryAttributes'], ['workspaceId', 'deletedAt', 'aPlusContent'])
    const translations = await read('ProductTranslation', ['id', 'productId', 'language', 'name', 'description', 'bulletPoints', 'keywords', 'source', 'reviewedAt'], ['workspaceId', 'attributes', 'sourceHash', 'authoredAt', 'version'])
    const listings = await read('ChannelListing', ['id', 'productId', 'channel', 'marketplace', 'region', 'title', 'description', 'titleOverride', 'descriptionOverride', 'bulletPointsOverride', 'overrideData', 'platformAttributes', 'flatFileSnapshot'], ['workspaceId', 'aliasId', 'channelConnectionId'])
    const presentRequired = ['Marketplace', 'Product', 'ProductTranslation', 'ChannelListing']
    assert.ok(presentRequired.every(table => report.coverage.some(row => row.table === table && row.status === 'read')), 'Required table unavailable; no baseline may be claimed.')
    assert.ok(markets.length > 0 && products.length > 0 && listings.length > 0, 'Production positive-control rows were not visible.')
    report.rls = (await db.query("SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname = ANY($1)", [presentRequired])).rows
    report.databaseRole = (await db.query('SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    assert.ok(report.rls.every(row => !row.enabled || report.databaseRole.rolsuper || report.databaseRole.rolbypassrls || row.owner === report.transaction.role && !row.forced), 'RLS could hide other workspaces; cannot claim a full production scan.')
    const workspace = row => row.workspaceId ?? '(pre-workspace-schema)'
    const productMap = new Map(products.map(row => [key([workspace(row), row.id]), row]))
    report.marketplaces = markets.map(row => ({ ...row, workspaceId: workspace(row), languages: row.languages ?? null }))
    report.population = { products: products.length, activeProducts: products.filter(row => !row.deletedAt).length, roots: products.filter(row => !row.parentId).length, listings: listings.length, translations: translations.length, marketplaces: markets.length, marketplaceLanguages: [...new Set(markets.map(row => row.language))].sort(), workspaces: [...new Set(products.map(workspace))] }
    const count = (bag, name) => { bag[name] = (bag[name] ?? 0) + 1 }
    function scanRow(table, row, names) {
      for (const name of names) {
        const found = []; scanTags({ [name]: row[name] }, table, found)
        report.regionalTags.push(...found.map(item => ({ table, rowId: row.id, workspaceId: workspace(row), ...item })))
      }
    }
    for (const product of products) {
      const w = workspace(product)
      for (const [tag, slot] of Object.entries(object(product.localizedContent))) {
        if (tag.startsWith('_')) continue
        const fields = Object.keys(object(slot)).filter(name => !name.startsWith('_'))
        const textFields = fields.filter(name => hasText(slot[name]))
        report.slotsByLanguage[tag] ??= { slots: 0, emptySlots: 0, slotsWithText: 0, fieldsPresent: 0, textFields: 0, metadataFields: 0 }
        const count = report.slotsByLanguage[tag]
        count.slots++; count.emptySlots += Number(fields.length === 0); count.slotsWithText += Number(textFields.length > 0); count.fieldsPresent += fields.length; count.textFields += textFields.length; count.metadataFields += Object.keys(object(slot?._meta)).length
        report.slotDetails.push({ workspaceId: w, productId: product.id, sku: product.sku, rawLanguage: tag, normalizedLanguage: language(tag), fields, textFields, empty: fields.length === 0 })
        if (!language(tag)) report.unknownLanguages.push({ store: 'Product.localizedContent', rowId: product.id, tag })
        const meta = Object.entries(object(slot?._meta))
        if (meta.length) report.reviewMetadata.push({ productId: product.id, language: tag, fields: meta.map(([field, value]) => ({ field, state: value?.state ?? null, sourceLocale: value?.sourceLocale ?? null, sourceHash: value?.sourceHash ?? null, authoredAt: value?.authoredAt ?? null })) })
        for (const [column, field] of Object.entries({ name: 'title', description: 'description', bulletPoints: 'bulletPoints', keywords: 'keywords' })) if (Object.hasOwn(object(slot), field)) report.slotSourceComparisons.push({ productId: product.id, sku: product.sku, language: tag, field, identicalToNativeColumn: key(slot[field]) === key(product[column]), slot: fingerprint(slot[field]), native: fingerprint(product[column]) })
        for (const translation of translations.filter(row => workspace(row) === w && row.productId === product.id && language(row.language) === language(tag))) {
          const overlaps = Object.entries(coreFields).filter(([name]) => ['name', 'description', 'bulletPoints', 'keywords'].includes(name)).flatMap(([column, field]) => Object.hasOwn(object(slot), field) && hasText(translation[column]) ? [{ field, identical: key(slot[field]) === key(translation[column]) }] : [])
          report.slotTableOverlaps.push({ productId: product.id, workspaceId: w, slotLanguage: tag, translationId: translation.id, tableLanguage: translation.language, fields: overlaps })
        }
      }
      scanRow('Product', product, ['localizedContent', 'categoryAttributes', 'aPlusContent'])
    }
    for (const row of translations) { count(report.translationRowsByLanguage, row.language); scanRow('ProductTranslation', row, ['language', 'attributes']) }
    report.overrides = { anyNonempty: 0, titleOverride: 0, descriptionOverride: 0, bulletPointsOverride: 0 }
    const observations = []
    for (const listing of listings) {
      const w = workspace(listing), marketCode = listing.marketplace && listing.marketplace !== 'DEFAULT' ? listing.marketplace : listing.region
      const marketRows = markets.filter(row => workspace(row) === w && row.channel === listing.channel && row.code === marketCode)
      const defaultLanguage = marketRows.length === 1 ? marketRows[0].language : null
      if (marketRows.length !== 1) report.unknownLanguages.push({ store: 'ChannelListing', rowId: listing.id, channel: listing.channel, marketplace: marketCode, reason: marketRows.length ? 'ambiguous-market-row' : 'missing-market-row' })
      const nonempty = ['titleOverride', 'descriptionOverride', 'bulletPointsOverride'].filter(name => hasText(listing[name]))
      if (nonempty.length) report.overrides.anyNonempty++
      for (const name of nonempty) report.overrides[name]++
      function add(field, value, tag, store) {
        if (!hasText(value)) return
        const locale = language(tag)
        if (!locale) { report.unknownLanguages.push({ store, rowId: listing.id, field, tag }); return }
        observations.push({ workspaceId: w, productId: listing.productId, listingId: listing.id, channel: listing.channel, market: marketCode, accountId: listing.channelConnectionId ?? null, aliasId: listing.aliasId ?? null, field: canonicalField(field), language: locale, rawLanguage: tag, store, ...fingerprint(value) })
      }
      // Preserve every stored candidate: conflicts inside a listing must not be hidden by a guessed cascade.
      for (const name of ['title', 'description', 'titleOverride', 'descriptionOverride', 'bulletPointsOverride']) add(name.replace(/Override$/, ''), listing[name], defaultLanguage, `ChannelListing.${name}`)
      for (const [name, value] of Object.entries(object(listing.overrideData))) if (coreFields[name]) add(name, value, defaultLanguage, `ChannelListing.overrideData.${name}`)
      const attrs = object(listing.platformAttributes)
      for (const bag of ['_etsyInformationLocales', '_shopifyInformationLocales', '_productMediaLocales']) {
        report.localeBagCounts[bag] ??= { listings: 0, slots: 0, languages: {} }
        const tags = Object.keys(object(attrs[bag]))
        if (tags.length) report.localeBagCounts[bag].listings++
        report.localeBagCounts[bag].slots += tags.length
        for (const tag of tags) count(report.localeBagCounts[bag].languages, tag)
      }
      // Some channel-native stores retain a direct value with an explicit source language.
      for (const [name, value] of Object.entries(attrs)) if (coreFields[name] || name === 'tags') add(name, value, attrs.language ?? defaultLanguage, `platformAttributes.${name}`)
      for (const bag of ['_etsyInformationLocales', '_shopifyInformationLocales']) for (const [tag, values] of Object.entries(object(attrs[bag]))) for (const [name, value] of Object.entries(object(values))) if (!name.startsWith('_')) add(name, value, tag, `platformAttributes.${bag}.${tag}.${name}`)
      for (const row of Array.isArray(attrs.translations) ? attrs.translations : Object.values(object(attrs.translations))) for (const [name, value] of Object.entries(object(row))) if (!['language', 'locale'].includes(name)) add(name, value, row.language ?? row.locale, `platformAttributes.translations.${name}`)
      for (const row of object(attrs._nexusLinkedProducts).sheetValues ?? []) add(row.fieldId, row.value, row.locale || defaultLanguage, 'platformAttributes._nexusLinkedProducts.sheetValues')
      for (const [name, values] of Object.entries(object(attrs.attributes))) {
        if (!Array.isArray(values)) continue
        const byTag = new Map()
        for (const entry of values) if (entry && entry.language_tag && hasText(entry.value)) { const rows = byTag.get(entry.language_tag) ?? []; rows.push(entry.value); byTag.set(entry.language_tag, rows) }
        for (const [tag, entries] of byTag) add(name, canonicalField(name) === 'bulletPoints' ? entries : entries.length === 1 ? entries[0] : entries, tag, `platformAttributes.attributes.${name}`)
      }
      if (!productMap.has(key([w, listing.productId]))) report.unknownLanguages.push({ store: 'ChannelListing', rowId: listing.id, reason: 'product-not-visible-in-same-workspace' })
      scanRow('ChannelListing', listing, ['overrideData', 'platformAttributes', 'flatFileSnapshot'])
    }
    for (const table of ['ProductSeo', 'APlusContent', 'BrandStory', 'ProductAiDraft', 'CellFormula', 'AssetLocaleOverlay']) {
      const rows = await read(table, ['id', 'locale'], ['workspaceId'])
      for (const row of rows) scanRow(table, row, ['locale'])
    }
    report.comparisons = compare(observations)
    report.comparisonCounts = {}
    for (const row of report.comparisons) count(report.comparisonCounts, row.classification)
    report.regionalTags = [...new Map(report.regionalTags.map(row => [key([row.table, row.rowId, row.path, row.tag]), row])).values()]
    report.regionalTagCounts = {}
    for (const row of report.regionalTags) count(report.regionalTagCounts, `${row.table}:${row.tag}`)
    report.regionalRowsByStore = {}
    for (const table of report.coverage.map(row => row.table)) report.regionalRowsByStore[table] = new Set(report.regionalTags.filter(row => row.table === table).map(row => row.rowId)).size
    report.controls.production = { productRowsVisible: products.length, namedFixtureRows: products.filter(row => /XAVIA|GALE-JACKET/i.test(`${row.sku} ${row.name}`)).length, marketRowsVisible: markets.length, listingRowsVisible: listings.length, transactionReadOnly: true, rlsCoverageVerified: true }
    assert.ok(report.controls.production.namedFixtureRows > 0, 'Named fixture positive control absent.')
    await db.query('ROLLBACK')
    report.transaction.rolledBack = true
    report.finishedAt = new Date().toISOString()
    const detail = gzipSync(JSON.stringify({ comparisons: report.comparisons, regionalTags: report.regionalTags, slotDetails: report.slotDetails }) + '\n')
    await writeFile(new URL('./production-details.json.gz', import.meta.url), detail)
    report.details = { path: 'production-details.json.gz', sha256: hash(detail), compressedBytes: detail.length, comparisonGroups: report.comparisons.length, regionalOccurrences: report.regionalTags.length, jsonSlots: report.slotDetails.length }
    report.comparisonBreakdown = {}
    for (const row of report.comparisons) if (row.channels.length > 1) count(report.comparisonBreakdown, `${row.field}:${row.language}:${row.classification}`)
    delete report.comparisons; delete report.regionalTags; delete report.slotDetails
    await writeFile(new URL('./production-baseline.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify({ startedAt, finishedAt: report.finishedAt, population: report.population, slotsByLanguage: report.slotsByLanguage, translationRowsByLanguage: report.translationRowsByLanguage, overrides: report.overrides, comparisonCounts: report.comparisonCounts, regionalTagCounts: report.regionalTagCounts, unknownLanguages: report.unknownLanguages.length, reviewMetadataSlots: report.reviewMetadata.length, slotTableOverlaps: report.slotTableOverlaps.length, controls: report.controls, coverage: report.coverage.map(({ table, status, rows }) => ({ table, status, rows })), report: 'docs/audits/2026-09-12-language-axis/production-baseline.json' }, null, 2))
  } catch (error) {
    // Driver messages can include hostnames/SQL values; emit only the code for network/database failures.
    if (error.code && error.code !== 'ERR_ASSERTION') console.error(`LX.0 failed: ${error.code}; no completed measurement claimed.`)
    else console.error(error.message)
    process.exitCode = 1
  } finally {
    if (connected) await db.query('ROLLBACK').catch(() => {})
    await db.end()
  }
}
