#!/usr/bin/env node
/**
 * check-event-contract — RULE: the factory publishes only declared events (plan A1 §3.4 and §6.6, feature PLT-191;
 * Commerce hard rule 8 for the factory). The outbox writer refuses an undeclared event at run time, inside the
 * command's transaction; this guard finds the same mistakes before anything runs. Read with the TypeScript parser
 * (comments and strings are never mistaken for code, a call split over lines is still one call):
 *
 *   1. declarations (packages/factory-domain/src): every `defineEvent({ … })` sits in `src/<module>/events.ts`; its
 *      `type` is a string literal `<module>.<event>`, its `version` (when given) a whole number from 1, its `context`
 *      the module's folder name, and its `payload` a schema, written `z.strictObject(…)` (every declared type has a
 *      strict payload schema). One type and version is declared once. A live rule that reaches the floor names the
 *      floor permission a floor viewer needs as a string literal (`floor: 'floor.work'`, B-W2a-F5): `floor: true`,
 *      `false` or any other value is refused, so a tablet is never asked an office read no floor role holds (defineEvent
 *      checks at import that the permission is one floor roles may hold);
 *   2. assembly: `src/events/catalogue.ts` imports every `src/<module>/events.ts` (`from '../<module>/events'`), so a
 *      declared event is in the catalogue the writer checks;
 *   3. emits (apps/factory-api/src): every `emit({ type: '…', … })` with a literal type names a declared type, and its
 *      literal `version` (1 when left out) a declared version. A type held in a variable is checked at run time;
 *   4. the outbox table: only apps/factory-api/src/platform/outbox/ (the writer, the relay) writes OutboxEvent rows: no
 *      `outboxEvent.create|createMany|update|updateMany|upsert|delete|deleteMany(…)` and no SQL that inserts into,
 *      updates or deletes from "OutboxEvent" anywhere else in apps/factory-api/src, apps/factory-web/src or
 *      packages/factory-db/src. Everything else emits through command().
 * Test files are not scanned (they plant the mistakes), nor generated or build output.
 *
 * Run: node scripts/factory/check-event-contract.mjs [root] — root is the repository (default) or a copy of its layout
 * (the plant tests). Exit 1 on any violation, one per line as file:line.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const DOMAIN = join(ROOT, 'packages/factory-domain/src')
const CATALOGUE = join(DOMAIN, 'events/catalogue.ts')
const EMITTERS = ['apps/factory-api/src']
const OUTBOX_WRITERS = 'apps/factory-api/src/platform/outbox/'
const TABLE_SCANS = ['apps/factory-api/src', 'apps/factory-web/src', 'packages/factory-db/src']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next'])
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/
const TYPE = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)+$/
const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany'])
const TABLE_SQL = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:ONLY\s+)?(?:\\?"?public\\?"?\s*\.\s*)?\\?"?OutboxEvent\b/gi

const posix = (path) => path.split(sep).join('/')
const shown = (path) => posix(relative(ROOT, path))
const violations = []
const listDir = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])

function codeFiles(dir) {
  return listDir(dir).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : codeFiles(path)
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !TEST.test(entry.name) ? [path] : []
  })
}

function parse(file) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind)
}
const at = (source, node) => `${shown(source.fileName)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
const unwrap = (node) => {
  let current = node
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current) || ts.isTypeAssertionExpression(current))) current = current.expression
  return current
}
const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null)
const property = (object, name) =>
  object.properties.find((entry) => ts.isPropertyAssignment(entry) && (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) && entry.name.text === name)
function visit(node, each) {
  each(node)
  ts.forEachChild(node, (child) => visit(child, each))
}

// --- 1. declarations ----------------------------------------------------------------------------------------------
const declared = new Map() // `${type}@${version}` -> where
const declaredTypes = new Set()
/**
 * A live rule's object literal: a defineEvent's `live: { … }`, or a constant of the events file spread into one or used
 * as one (`const scanLive = { permission, floor, fields }`, `live: scanLive`, `live: { ...scanLive, fields }`).
 */
const named = (object, name) => object.properties.some((entry) => (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) && ts.isIdentifier(entry.name) && entry.name.text === name)
const isRuleShaped = (object) => named(object, 'permission') || (object.properties.some(ts.isSpreadAssignment) && named(object, 'floor'))
for (const file of codeFiles(DOMAIN)) {
  const source = parse(file)
  const rel = posix(relative(DOMAIN, file))
  const home = /^([a-z][a-z0-9-]*)\/events\.ts$/.exec(rel)
  const liveRules = new Set()
  if (home && home[1] !== 'events') {
    // Constants that hold a live rule (`const live = { permission: …, floor: …, fields: … } as const`).
    visit(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !node.initializer) return
      const value = unwrap(node.initializer)
      if (value && ts.isObjectLiteralExpression(value) && isRuleShaped(value)) liveRules.add(value)
    })
  }
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'defineEvent') return
    const where = at(source, node)
    if (!home || home[1] === 'events') {
      violations.push(`${where}  defineEvent() outside src/<module>/events.ts; declare the module's events there`)
      return
    }
    const spec = unwrap(node.arguments[0])
    if (!spec || !ts.isObjectLiteralExpression(spec)) {
      violations.push(`${where}  defineEvent() takes an object literal (type, version, context, description, payload)`)
      return
    }
    const type = property(spec, 'type')
    const typeValue = type && unwrap(type.initializer)
    if (!typeValue || !ts.isStringLiteralLike(typeValue) || !TYPE.test(typeValue.text)) {
      violations.push(`${where}  the event type must be a string literal <module>.<event>`)
      return
    }
    const version = property(spec, 'version')
    let versionValue = 1
    if (version) {
      const value = unwrap(version.initializer)
      if (!value || !ts.isNumericLiteral(value) || !/^[1-9]\d*$/.test(value.text)) {
        violations.push(`${where}  ${typeValue.text}: the version must be a whole number literal from 1`)
        return
      }
      versionValue = Number(value.text)
    }
    const context = property(spec, 'context')
    const contextValue = context && unwrap(context.initializer)
    if (!contextValue || !ts.isStringLiteralLike(contextValue) || contextValue.text !== home[1]) {
      violations.push(`${where}  ${typeValue.text}: the context must be the module that declares it ('${home[1]}')`)
    }
    const payload = property(spec, 'payload')
    const payloadValue = payload && unwrap(payload.initializer)
    if (!payloadValue) {
      violations.push(`${where}  ${typeValue.text}: no payload schema (payload: z.strictObject({ … }))`)
    } else if (!ts.isCallExpression(payloadValue) || payloadValue.expression.getText(source) !== 'z.strictObject') {
      violations.push(`${where}  ${typeValue.text}: the payload schema must be written z.strictObject({ … }) (strict: an unknown key fails)`)
    }
    const live = property(spec, 'live')
    const liveValue = live && unwrap(live.initializer)
    if (liveValue && ts.isObjectLiteralExpression(liveValue)) liveRules.add(liveValue)
    const key = `${typeValue.text}@${versionValue}`
    if (declared.has(key)) violations.push(`${where}  ${typeValue.text} version ${versionValue} is declared twice (also ${declared.get(key)})`)
    else declared.set(key, where)
    declaredTypes.add(typeValue.text)
  })
  for (const rule of liveRules) {
    const floor = property(rule, 'floor')
    if (!floor) continue
    const value = unwrap(floor.initializer)
    if (!value || !ts.isStringLiteralLike(value) || !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/.test(value.text)) {
      violations.push(
        `${at(source, floor)}  live.floor must name the floor permission a floor viewer needs, as a string literal (floor: 'floor.work', or one the floor shares such as 'production.cut'), not ${floor.initializer.getText(source)}: a tablet is never asked the office read`,
      )
    }
  }
}

// --- 2. assembly --------------------------------------------------------------------------------------------------
if (!existsSync(CATALOGUE)) {
  violations.push('packages/factory-domain/src/events/catalogue.ts is missing (the catalogue the outbox writer checks)')
} else {
  const source = parse(CATALOGUE)
  const imported = new Set()
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const match = /^\.\.\/([a-z][a-z0-9-]*)\/events$/.exec(statement.moduleSpecifier.text)
      if (match) imported.add(match[1])
    }
  }
  for (const entry of listDir(DOMAIN).filter((entry) => entry.isDirectory() && entry.name !== 'events')) {
    if (existsSync(join(DOMAIN, entry.name, 'events.ts')) && !imported.has(entry.name)) {
      violations.push(`packages/factory-domain/src/${entry.name}/events.ts is not assembled: import it in src/events/catalogue.ts and add its events to EVENT_DEFINITIONS`)
    }
  }
}

// --- 3. emits -----------------------------------------------------------------------------------------------------
let emits = 0
for (const file of EMITTERS.flatMap((dir) => codeFiles(join(ROOT, dir)))) {
  const source = parse(file)
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || calleeName(node) !== 'emit') return
    const event = unwrap(node.arguments[0])
    if (!event || !ts.isObjectLiteralExpression(event)) return
    const type = property(event, 'type')
    const typeValue = type && unwrap(type.initializer)
    if (!typeValue || !ts.isStringLiteralLike(typeValue)) return
    emits++
    const version = property(event, 'version')
    const versionValue = version && unwrap(version.initializer)
    const number = versionValue && ts.isNumericLiteral(versionValue) ? Number(versionValue.text) : version ? null : 1
    if (!declaredTypes.has(typeValue.text)) {
      violations.push(`${at(source, node)}  emit('${typeValue.text}') — not declared in the event catalogue (packages/factory-domain/src/<module>/events.ts)`)
    } else if (number !== null && !declared.has(`${typeValue.text}@${number}`)) {
      violations.push(`${at(source, node)}  emit('${typeValue.text}', version ${number}) — that version is not declared`)
    }
  })
}

// --- 4. the outbox table ------------------------------------------------------------------------------------------
for (const file of TABLE_SCANS.flatMap((dir) => codeFiles(join(ROOT, dir)))) {
  if (shown(file).startsWith(OUTBOX_WRITERS)) continue
  const source = parse(file)
  visit(source, (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && WRITES.has(node.expression.name.text)) {
      const target = unwrap(node.expression.expression)
      const name = target && (ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : null)
      if (name === 'outboxEvent') violations.push(`${at(source, node)}  outboxEvent.${node.expression.name.text}() outside platform/outbox; emit events through command()`)
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      for (const match of node.text.matchAll(TABLE_SQL)) {
        violations.push(`${at(source, node)}  SQL ${match[1].toUpperCase().replace(/\s+/g, ' ')} "OutboxEvent" outside platform/outbox; emit events through command()`)
      }
    }
  })
}

if (violations.length > 0) {
  console.error(`check-event-contract: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-event-contract: ok (${declared.size} declared event version(s), ${emits} literal emit(s) checked; OutboxEvent written only by platform/outbox)`)
