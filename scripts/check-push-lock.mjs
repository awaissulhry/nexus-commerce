#!/usr/bin/env node
/** Presence W1.5: derive push functions from executable source, never from a function-name allowlist. */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const sourceRoot = path.join(root, 'apps/api/src')
const seed = process.argv.includes('--seed-red')
const seedNew = process.argv.includes('--seed-new-path')
const seedFeed = process.argv.includes('--seed-feed-bypass')
const seedEbayFeed = process.argv.includes('--seed-ebay-feed')
const seedMarketing = process.argv.includes('--seed-marketing')
const all = !process.argv.includes('--slice')
const transports = process.argv.includes('--transport-inventory')
// Default to every derived listing writer. It remains red when any is
// unguarded. --transport-inventory also shows non-listing candidates. --slice is deliberately
// explicit: its green cannot stand in for repository-wide W1.5 completion.
const owned = new Set([
  'services/outbound-sync.service.ts', 'services/pricing-outbound.service.ts',
  'services/shopify/offer-sync.service.ts', 'services/shopify/content-sync.service.ts',
  'services/amazon/flat-file.service.ts',
])
const clientFiles = [
  'clients/amazon-sp-api.client.ts', 'services/ebay-trading-api.service.ts',
  'services/marketplaces/shopify.service.ts', 'services/marketplaces/woocommerce.service.ts',
]
const nodes = []
function visit(node, fn) { fn(node); ts.forEachChild(node, child => visit(child, fn)) }
function functions(file) {
  const original = fs.readFileSync(path.join(sourceRoot, file), 'utf8')
  // Mutate only a scratch source string; exercise discovery itself, not its verdict.
  let src = seed && file === 'services/pricing-outbound.service.ts'
    ? original.replaceAll('assertPushAllowed(', '__seed_missing_guard(') : original
  if (seedEbayFeed && file === 'services/ebay-feed.service.ts' || seedMarketing && file === 'services/ebay-marketing-dispatch.service.ts') {
    src = src.replaceAll('assertPushAllowed(', '__seed_missing_guard(')
  }
  if (seedNew && file === (all ? 'services/listing-push-controls.ts' : 'services/pricing-outbound.service.ts')) src += '\nasync function __seedNewPush() { await amazonSpApiClient.patchListingPrice({}); }'
  const tree = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true)
  const result = []
  visit(tree, node => {
    const namedArrow = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) ? node.parent.name : null
    const routeHandler = ts.isArrowFunction(node) && ts.isCallExpression(node.parent)
      && ['get', 'post', 'put', 'patch', 'delete'].includes(method(node.parent)) && literal(node.parent.arguments[0])
    if (((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.body && node.name) || namedArrow || routeHandler) {
      result.push({ file, name: routeHandler ? `${method(node.parent).toUpperCase()} ${literal(node.parent.arguments[0])}` : (namedArrow ?? node.name).getText(tree), body: node.body, tree, parameters: node.parameters,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 })
    }
  })
  return result
}
const calls = node => {
  const result = []
  const descend = n => {
    if (n !== node && (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && (ts.isVariableDeclaration(n.parent) || ts.isCallExpression(n.parent) && ['get','post','put','patch','delete'].includes(method(n.parent)) && literal(n.parent.arguments[0])))) return
    if (ts.isCallExpression(n)) result.push(n)
    ts.forEachChild(n, descend)
  }
  descend(node)
  return result
}
const method = call => ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText()
const literal = n => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : ''
const writeVerbs = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
function directTransport(call) {
  if (['request', 'makeRequest'].includes(method(call)) && writeVerbs.has(literal(call.arguments[0]))) return true
  if (method(call) === 'callTradingApi' && /^(Add|Revise|End|Set|Delete)/.test(literal(call.arguments[0]))) return true
  if (/^(gql|graphql)$/.test(method(call)) && /^\s*mutation\b/.test(call.arguments[0]?.getText().replace(/^[`'"]/, '') ?? '')) return true
  if (['fetch', 'fetchWithRetry', 'makeRequest'].includes(method(call))) {
    const options = call.arguments[1]
    return !!options && ts.isObjectLiteralExpression(options) && options.properties.some(p =>
      ts.isPropertyAssignment(p) && p.name.getText() === 'method' && writeVerbs.has(literal(p.initializer)))
  }
  return false
}
// Client write-method names come from their actual transport calls. Validation
// and lifecycle methods remain visible in --transport-inventory.
const writeMethods = new Set()
for (const file of clientFiles) for (const fn of functions(file)) {
  if (!/^(get|request$|callTradingApi$|addOrderNote$|updateOrderStatus$)/.test(fn.name) && calls(fn.body).some(directTransport)) writeMethods.add(fn.name)
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.ts$/.test(file) && !/\.(test|spec|d)\.ts$/.test(file)) {
      const relative = path.relative(sourceRoot, file)
      nodes.push(...functions(relative))
    }
  }
}
walk(sourceRoot)
// A function taking the typed Shopify transport is an adapter primitive, just
// like a method on the four client modules. Its caller owns the listing lock.
// Discover these adapters from the function signature and mutation source.
const graphqlAdapters = nodes.filter(fn => fn.parameters.some(p => /ShopifyGraphql/.test(p.type?.getText() ?? '')))
const lifecycleMethods = new Set(['deleteListingsItem', 'endFixedPriceItem', 'patchPurchasableOffer', 'deleteProduct'])
// Resolve local/top-level constant identifiers used for endpoint and GraphQL strings.
function sourceValue(node, seen = new Set()) {
  if (!node || seen.has(node)) return ''
  seen.add(node)
  if (ts.isIdentifier(node)) {
    const declarations = []
    visit(node.getSourceFile(), n => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === node.text && n.initializer && n.getStart() < node.getStart()) declarations.push(n)
    })
    const declaration = declarations.at(-1)
    if (declaration) return sourceValue(declaration.initializer, seen)
  }
  return node.getText().replace(/^[`'"]/, '')
}
const listingMutation = call => /^(gql|graphql)$/.test(method(call)) && call.arguments.some(a => {
  const query = sourceValue(a)
  if (!/^\s*mutation\b/.test(query)) return false
  // Collection-owned metafields describe navigation, not a product listing.
  const variables = call.arguments.at(-1)?.getText() ?? ''
  if (/\bmetafieldsSet\b/.test(query) && /ownerId:\s*`gid:\/\/shopify\/Collection\//.test(variables)) return false
  return /\b(product[A-Z]\w*|inventory[A-Z]\w*|metafieldsSet|metafieldsDelete|publishablePublish|publishableUnpublish|translationsRegister|translationsRemove|bulkOperationRunMutation)\b/.test(query)
})
const adapterWrites = new Set(graphqlAdapters.filter(fn => calls(fn.body).some(listingMutation)).map(fn => fn.name))
let adapterChanged = true
while (adapterChanged) {
  adapterChanged = false
  for (const fn of graphqlAdapters) if (!adapterWrites.has(fn.name) && calls(fn.body).some(c => adapterWrites.has(method(c)))) {
    adapterWrites.add(fn.name); adapterChanged = true
  }
}
for (const name of adapterWrites) writeMethods.add(name)
const adapterNodes = new Set(graphqlAdapters.filter(fn => adapterWrites.has(fn.name)))
// Feed payload uploads are listing writes even though their endpoint does not
// contain /inventory/. Derive the wrapper and its callers from the upload URL.
const feedUploadMethods = new Set(nodes.filter(fn => calls(fn.body).some(c =>
  ['fetch', 'fetchWithRetry'].includes(method(c)) && directTransport(c)
  && /\/sell\/feed\/v1\/task\/.*\/upload_file/.test(sourceValue(c.arguments[0]))
)).map(fn => fn.name))
// Generic POST wrappers take their resource path from the caller. Follow the
// actual parameter into the URL, then classify its supplied literal endpoint.
const parameterizedListingMethods = new Set(nodes.filter(fn => ts.isFunctionDeclaration(fn.body.parent)
  && fn.parameters.some((parameter, index) => calls(fn.body).some(c =>
    ['fetch', 'fetchWithRetry'].includes(method(c)) && directTransport(c)
    && sourceValue(c.arguments[0]).includes('${' + parameter.name.getText() + '}'))
    && nodes.some(caller => calls(caller.body).some(c => method(c) === fn.name
      && /\/(sell\/marketing|sell\/inventory|listings|products|variants)\//.test(literal(c.arguments[index])))))
).map(fn => fn.name))
function listingTransport(call, fn) {
  const name = method(call)
  if (feedUploadMethods.has(name)) return true
  if (parameterizedListingMethods.has(name)) return true
  if (parameterizedListingMethods.has(fn.name) && ['fetch', 'fetchWithRetry'].includes(name) && directTransport(call)) return true
  if (name === 'reviseInventoryStatus' && /quantity:\s*0\b/.test(call.arguments[0]?.getText() ?? '') && !/price:/.test(call.arguments[0]?.getText() ?? '') && /<Delete>true<\/Delete>/.test(fn.body.getText())) return false
  if (name === 'callTradingApi' && literal(call.arguments[0]) === 'ReviseFixedPriceItem' && /<Delete>true<\/Delete>/.test(sourceValue(call.arguments[1]))) return false
  if (writeMethods.has(name) && !lifecycleMethods.has(name)) return true
  if (name === 'callTradingApi' && /^(Add|Revise|Set)/.test(literal(call.arguments[0])) && literal(call.arguments[0]) !== 'SetNotificationPreferences') return true
  if (listingMutation(call)) return true
  if (name === 'callAPI' && (/operation:\s*['"](?:putListingsItem|patchListingsItem)['"]/.test(call.arguments[0]?.getText() ?? '') || /operation:\s*['"]createFeed['"]/.test(call.arguments[0]?.getText() ?? '') && /feedType:\s*['"]JSON_LISTINGS_FEED['"]/.test(call.arguments[0]?.getText() ?? ''))) return true
  if (['fetch', 'fetchWithRetry'].includes(name) && !directTransport(call)) {
    const options = call.arguments[1]
    const dynamic = options && ts.isObjectLiteralExpression(options) && options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'method' && !literal(p.initializer))
    if (dynamic) {
      const localCalls = calls(fn.body).filter(c => c !== call)
      const mapper = nodes.filter(n => n.file === fn.file && localCalls.some(c => method(c) === n.name))
      if (mapper.some(n => /method:\s*['"](?:PUT|POST|PATCH)['"]/.test(n.body.getText()) && /\/sell\/inventory\//.test(n.body.getText()))) return true
    }
  }
  if (['fetch', 'fetchWithRetry'].includes(name) && directTransport(call)) {
    const options = call.arguments[1]
    if (options && ts.isObjectLiteralExpression(options) && options.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText() === 'method' && literal(p.initializer) === 'DELETE')) return false
    const url = sourceValue(call.arguments[0])
    if (/\/withdraw(?:`|'|"|$)/.test(url)) return false
    // HTTP POST also starts reports and refreshes tokens. Only listing endpoint
    // paths or the explicit listings-feed type make a raw HTTP call a push here.
    if (/\/sell\/inventory\/v1\/location(?:\/|`|$)/.test(url)) return false
    return /\/(listings|sell\/inventory|sell\/marketing|products|variants|inventory_levels|inventory_items)(?:\/|\.json)/.test(url)
      || /\/sell\/feed\/v1\/task\/.*\/upload_file/.test(url)
      || /JSON_LISTINGS_FEED/.test(fn.body.getText())
  }
  return false
}
const byName = new Map()
for (const fn of nodes) {
  const peers = byName.get(fn.name) ?? []; peers.push(fn); byName.set(fn.name, peers)
  fn.calls = calls(fn.body)
  fn.transportCandidates = fn.calls.filter(c => directTransport(c) || writeMethods.has(method(c)))
  fn.sinks = transports ? fn.transportCandidates : fn.calls.filter(c => listingTransport(c, fn))
  const guards = fn.calls.filter(c => method(c) === 'assertPushAllowed' || method(c) === 'map' && c.arguments[0]?.getText() === 'assertPushAllowed')
  const firstWrite = Math.min(...fn.sinks.map(c => c.getStart()))
  fn.guarded = guards.some(c => c.getStart() < firstWrite)
}
for (const fn of nodes) {
  if (fn.guarded) continue
  const firstWrite = Math.min(...fn.sinks.map(c => c.getStart()))
  fn.guarded = fn.calls.some(c => c.getStart() < firstWrite && (byName.get(method(c)) ?? []).some(target => target.file === fn.file && target.guarded && target.calls.some(g => method(g) === 'assertPushAllowed')))
}
// Transitive publisher calls count too: synchronizeContent must protect its own
// boundary even though publishContent owns the productSet transport call.
function reachesWrite(fn, seen = new Set()) {
  if (seen.has(fn)) return false
  seen.add(fn)
  return fn.sinks.length > 0 || fn.calls.some(c => (byName.get(method(c)) ?? []).some(target => reachesWrite(target, seen)))
}
const derived = nodes.filter(fn => (all || owned.has(fn.file)) && (transports || !clientFiles.includes(fn.file) && !adapterNodes.has(fn)) && (fn.sinks.length > 0
  || !all && fn.calls.some(c => (byName.get(method(c)) ?? []).some(target => !owned.has(target.file) && reachesWrite(target)))))
// Read-only preview and the currently inert Woo dispatcher are explicit contracts,
// not transport discoveries. Both remain guarded even while they send nothing.
const contracts = nodes.filter(fn => owned.has(fn.file) && ['previewContentSync', 'syncToWoocommerce', 'prepareRowsForPush'].includes(fn.name))
const required = [...new Set([...derived, ...contracts])]
const errors = []
console.log(`Scope: ${transports ? 'Raw transport inventory (includes infrastructure/lifecycle)' : all ? 'All API listing-push callers; transport adapters and lifecycle verbs are classified separately' : 'Presence §D automatic/direct push slice ONLY'}`)
console.log(`Discovered Shopify transport adapters: ${[...adapterWrites].sort().join(', ')}`)
console.log(`Discovered eBay feed payload upload methods: ${[...feedUploadMethods].sort().join(', ')}`)
console.log(`Discovered listing POST wrappers from caller endpoints: ${[...parameterizedListingMethods].sort().join(', ')}`)
console.log(`Client write methods derived from source: ${[...writeMethods].sort().join(', ')}`)
for (const fn of required) {
  const preparedCall = fn.calls.find(c => method(c) === 'prepareRowsForPush')
  const feedBoundary = fn.file === 'routes/amazon-flat-file.routes.ts' && preparedCall && fn.calls.some(c => method(c) === 'buildJsonFeedBodyWithReport') && preparedCall.getStart() < Math.min(...fn.sinks.map(c => c.getStart()))
  const guarded = fn.guarded || feedBoundary
  console.log(`${guarded ? 'PASS' : 'FAIL'} apps/api/src/${fn.file}:${fn.line} ${fn.name} -> ${fn.sinks.map(method).join(', ') || 'transitive write / explicit containment contract'}`)
  if (!guarded) errors.push(`${fn.file}#${fn.name}`)
}
// The feed service is only a boundary when the route actually consumes its
// prepared rows. Read PR.1's file; never rewrite it to exercise this contract.
const routeFile = 'routes/amazon-flat-file.routes.ts'
let routeSource = fs.readFileSync(path.join(sourceRoot, routeFile), 'utf8')
if (seedFeed) routeSource = routeSource.replace('buildJsonFeedBodyWithReport(push.rows,', 'buildJsonFeedBodyWithReport(rows,')
const routeTree = ts.createSourceFile(routeFile, routeSource, ts.ScriptTarget.Latest, true)
const routeCalls = []
visit(routeTree, n => { if (ts.isCallExpression(n)) routeCalls.push(n) })
const preparations = routeCalls.filter(c => method(c) === 'prepareRowsForPush')
const builders = routeCalls.filter(c => method(c) === 'buildJsonFeedBodyWithReport')
const preparedNames = new Map(preparations.flatMap(c => {
  const declaration = ts.isAwaitExpression(c.parent) ? c.parent.parent : c.parent
  return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
    ? [[declaration.name.text, c.getStart()]] : []
}))
const feedGuarded = builders.length > 0 && builders.every(c => {
  const rows = c.arguments[0]
  return rows && ts.isPropertyAccessExpression(rows) && rows.name.text === 'rows'
    && ts.isIdentifier(rows.expression) && (preparedNames.get(rows.expression.text) ?? Infinity) < c.getStart()
})
console.log(`${feedGuarded ? 'PASS' : 'FAIL'} apps/api/src/${routeFile} feed builder consumes guarded prepared rows`)
if (!feedGuarded) errors.push(`${routeFile}#feed-preflight-consumer`)
if (!required.length || !derived.length) errors.push('EMPTY DISCOVERY: no positive control')
if (seed && !errors.length) errors.push('seed-red did not exercise a guarded path')
console.log(`Derived ${derived.length} ${transports ? 'transport candidates (not a validated listing-push set)' : 'listing-push functions'}; ${contracts.length} explicit preview/containment/feed contracts; ${errors.length} missing guards.`)
process.exitCode = errors.length ? 1 : 0
