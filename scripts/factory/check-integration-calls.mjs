#!/usr/bin/env node
/**
 * check-integration-calls — RULE: every call from the factory to an outside service goes through the gateway (plan A1
 * §4 "every outbound call goes through integrationCall()", §6.6; feature PLT-195; Commerce hard rule 4 for the factory):
 * account state and mode, rate limit, circuit breaker, timeout, retries and one IntegrationCall row per call. So no
 * factory source outside
 *     apps/factory-api/src/platform/gateway/   the gateway itself
 *     apps/factory-api/src/adapters/           the provider adapters, whose calls run inside gateway.call()
 *     apps/factory-api/src/platform/secrets/aws-kms.ts   the KMS key provider: platform infrastructure, not a tenant's
 *                                              account (its calls are CloudTrail-logged by AWS, not ledgered here)
 * may, read with the TypeScript parser (comments and strings are never mistaken for code):
 *   1. import an HTTP client, a raw network client or a provider SDK — static `import … from` / `export … from`,
 *      `import()`, `require()`; type-only imports are fine (they vanish at build): node:http, node:https, node:http2,
 *      node:net, node:tls, node:dgram (with or without `node:`), undici, axios, got, node-fetch, cross-fetch,
 *      isomorphic-fetch, ky, superagent, request, ws, @aws-sdk/*, @smithy/*, aws-sdk, stripe, @sendgrid/*, nodemailer,
 *      soap, twilio, googleapis, @google-cloud/*, openai, @anthropic-ai/*;
 *   2. call the global fetch (`fetch(…)`, `globalThis.fetch(…)`) or open `new XMLHttpRequest`, `new WebSocket`,
 *      `new EventSource`.
 * Scanned: apps/factory-api/src, packages/factory-db/{src,seed}, packages/factory-domain/src, packages/db-kit/src
 * (.ts .tsx .mts .cts .js .mjs .cjs). Not scanned: tests (`*.test.*`, `*.spec.*`) and test support (`testing.ts`,
 * `src/testing/`), which plant or drive real sockets on purpose; generated code and build output. The factory web is
 * not scanned: it calls only its own API.
 *
 * Run: node scripts/factory/check-integration-calls.mjs [root] — root is the repository (default) or a copy of its
 * layout (the plant tests). Exit 1 on any violation, one per line as file:line.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const SCANNED = ['apps/factory-api/src', 'packages/factory-db/src', 'packages/factory-db/seed', 'packages/factory-domain/src', 'packages/db-kit/src']
const ALLOWED = ['apps/factory-api/src/platform/gateway/', 'apps/factory-api/src/adapters/', 'apps/factory-api/src/platform/secrets/aws-kms.ts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', 'testing'])
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/
const SUPPORT = /(^|\/)testing\.[cm]?[jt]s$/
const CODE = /\.(?:[cm]?[jt]s|tsx)$/
const CLIENTS = [
  /^(node:)?(http|https|http2|net|tls|dgram)$/,
  /^(undici|axios|got|node-fetch|cross-fetch|isomorphic-fetch|ky|superagent|request|ws|aws-sdk|stripe|nodemailer|soap|twilio|googleapis|openai)(\/|$)/,
  /^@(aws-sdk|smithy|sendgrid|google-cloud|anthropic-ai)\//,
]
const GLOBAL_CONSTRUCTORS = new Set(['XMLHttpRequest', 'WebSocket', 'EventSource'])

const posix = (path) => path.split(sep).join('/')
const shown = (path) => posix(relative(ROOT, path))
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
const violations = []

function codeFiles(dir) {
  return listDir(dir).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : codeFiles(path)
    return CODE.test(entry.name) && !entry.name.endsWith('.d.ts') && !TEST.test(entry.name) && !SUPPORT.test(entry.name) ? [path] : []
  })
}

const isClient = (module) => CLIENTS.some((rule) => rule.test(module))
const allowed = (file) => ALLOWED.some((path) => (path.endsWith('/') ? shown(file).startsWith(path) : shown(file) === path))

function scan(file) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind)
  const at = (node) => `${shown(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
  const report = (node, what) => violations.push(`${at(node)}  ${what}; call the outside only through the gateway (platform/gateway) or an adapter (src/adapters)`)

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.importClause?.isTypeOnly === true
      const allTypes =
        node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && !node.importClause.name
          ? node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)
          : false
      if (!typeOnly && !allTypes && isClient(node.moduleSpecifier.text)) report(node, `imports ${node.moduleSpecifier.text}`)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      if (!node.isTypeOnly && isClient(node.moduleSpecifier.text)) report(node, `re-exports ${node.moduleSpecifier.text}`)
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const [first] = node.arguments
      if ((callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) && first && ts.isStringLiteralLike(first) && isClient(first.text)) {
        report(node, `${callee.kind === ts.SyntaxKind.ImportKeyword ? 'imports' : 'requires'} ${first.text}`)
      }
      if (ts.isIdentifier(callee) && callee.text === 'fetch') report(node, 'calls fetch()')
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fetch' && ts.isIdentifier(callee.expression) && ['globalThis', 'window', 'self', 'global'].includes(callee.expression.text)) {
        report(node, `calls ${callee.expression.text}.fetch()`)
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && GLOBAL_CONSTRUCTORS.has(node.expression.text)) {
      report(node, `opens new ${node.expression.text}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

let scanned = 0
for (const file of SCANNED.flatMap((dir) => codeFiles(join(ROOT, dir)))) {
  if (allowed(file)) continue
  scanned++
  scan(file)
}

if (violations.length > 0) {
  console.error(`check-integration-calls: ${violations.length} direct outside call(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-integration-calls: ok (no HTTP client, network client, provider SDK or fetch() in ${scanned} source file(s) outside the gateway and the adapters)`)
