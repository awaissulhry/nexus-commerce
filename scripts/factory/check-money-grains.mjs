#!/usr/bin/env node
/**
 * check-money-grains — RULE: every money field of the factory is a marked type (plan A1 §3.11 "Money fields", PLAN
 * §4.6 item 4; feature PLT-034). The API filters money by its marking, never by a field's name, so a field that looks
 * like money (MONEY_NAME: *cost*, *margin*, *price*, *amount*, *total*, *wage*) and is not marked would reach every
 * caller.
 *
 *   1. Contracts and schemas (apps/factory-api/src and packages/factory-domain/src, tests and testing/ folders aside):
 *      a property with a money-looking name in the object of `output({…})`, `input({…})`, `z.object({…})`,
 *      `z.strictObject({…})`, `z.looseObject({…})` or `.extend({…})` / `.safeExtend({…})` is a chain that starts with
 *      `money.price(…)`, `money.cost(…)`, `money.margin(…)` or `money.wages(…)` (factory-domain money/marked), or
 *      `notMoney(…)` for a name that only looks like money (`totalLines`).
 *   2. The audit rows of a command: a money-looking key of an object written inline as `before:` or `after:` of an
 *      `audit({…})` call holds `markMoney(grain, value)`, so the audit history shows it only with its grain.
 *   3. The Prisma schema (packages/factory-db/prisma/schema): a field with a money-looking name has a doc line
 *      `/// @grain price|cost|margin|wages` (or `/// @not-money <why>`) above it; the floor and partner column
 *      grants (A1 §2.2) are decided from these.
 *
 * Run: node scripts/factory/check-money-grains.mjs [root] — the repository by default; another root (a test's copy)
 * is read with the same layout. Exit 1 on any violation, listed as file:line and rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url))
const SOURCES = ['apps/factory-api/src', 'packages/factory-domain/src']
const PRISMA = 'packages/factory-db/prisma/schema'
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', 'testing', '__fixtures__'])
const TEST = /\.(test|spec)\.[cm]?tsx?$/
// The same list as factory-domain money/marked.ts MONEY_NAME.
const MONEY_NAME = /cost|margin|price|amount|total|wage/i
const GRAINS = new Set(['price', 'cost', 'margin', 'wages'])
const OBJECT_BUILDERS = new Set(['output', 'input', 'object', 'strictObject', 'looseObject', 'extend', 'safeExtend'])

const posix = (path) => path.split(sep).join('/')
const violations = []
const report = (file, line, rule) => violations.push(`${posix(relative(ROOT, file))}:${line}  ${rule}`)

function files(dir, accept) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : files(path, accept)
    return accept(entry.name) ? [path] : []
  })
}

const nameOf = (property) => {
  const name = property.name
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

/** The called function's last name: `output(…)` → output, `z.object(…)` → object, `x.extend(…)` → extend. */
const calleeName = (call) => {
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return undefined
}

/** The first call of a chain: `money.cost(x).nullable()` → `money.cost(x)`. */
function firstCall(expression) {
  let current = expression
  let first
  while (current) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression
    } else if (ts.isCallExpression(current)) {
      first = current
      current = ts.isPropertyAccessExpression(current.expression) ? current.expression.expression : undefined
    } else {
      break
    }
  }
  return first
}

/** The chain starts with money.<grain>(…) or notMoney(…). */
function isMarkedSchema(expression) {
  const call = firstCall(expression)
  if (!call) return false
  const callee = call.expression
  if (ts.isIdentifier(callee)) return callee.text === 'notMoney'
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'money' && GRAINS.has(callee.name.text)
}

const isMarkMoney = (expression) => ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'markMoney'

function checkAuditJson(file, source, object) {
  for (const property of object.properties) {
    const name = nameOf(property)
    if (!ts.isPropertyAssignment(property) || name === undefined) continue
    const value = property.initializer
    if (MONEY_NAME.test(name) && !isMarkMoney(value)) {
      const { line } = source.getLineAndCharacterOfPosition(property.getStart(source))
      report(file, line + 1, `rule 2: audit field "${name}" looks like money; write it as markMoney(<grain>, value)`)
    }
    if (ts.isObjectLiteralExpression(value)) checkAuditJson(file, source, value)
  }
}

function checkSource(file) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node)
      const [argument] = node.arguments
      if (name !== undefined && OBJECT_BUILDERS.has(name) && argument && ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          const key = nameOf(property)
          if (key === undefined || !MONEY_NAME.test(key)) continue
          const value = ts.isPropertyAssignment(property) ? property.initializer : undefined
          if (!value || !isMarkedSchema(value)) {
            const { line } = source.getLineAndCharacterOfPosition(property.getStart(source))
            report(file, line + 1, `rule 1: contract field "${key}" looks like money; mark it money.<price|cost|margin|wages>(…) (or notMoney(…))`)
          }
        }
      }
      if (name === 'audit' && argument && ts.isObjectLiteralExpression(argument)) {
        for (const property of argument.properties) {
          const key = nameOf(property)
          if ((key === 'before' || key === 'after') && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
            checkAuditJson(file, source, property.initializer)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

function checkPrisma(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  let inModel = false
  lines.forEach((line, index) => {
    if (/^\s*model\s+\w+\s*\{/.test(line)) inModel = true
    else if (/^\s*\}/.test(line)) inModel = false
    else if (inModel) {
      const field = /^\s*(\w+)\s+[A-Z]\w*/.exec(line)
      if (!field || !MONEY_NAME.test(field[1])) return
      let doc = index - 1
      let marked = false
      while (doc >= 0 && /^\s*\/\/\//.test(lines[doc])) {
        if (/^\s*\/\/\/\s*@grain\s+(price|cost|margin|wages)\b/.test(lines[doc]) || /^\s*\/\/\/\s*@not-money\s+\S/.test(lines[doc])) marked = true
        doc--
      }
      if (!marked) report(file, index + 1, `rule 3: column "${field[1]}" looks like money; add /// @grain <price|cost|margin|wages> (or /// @not-money <why>) above it`)
    }
  })
}

let scanned = 0
for (const dir of SOURCES) {
  for (const file of files(join(ROOT, dir), (name) => /\.[cm]?ts$/.test(name) && !name.endsWith('.d.ts') && !TEST.test(name))) {
    checkSource(file)
    scanned++
  }
}
for (const file of files(join(ROOT, PRISMA), (name) => name.endsWith('.prisma'))) {
  checkPrisma(file)
  scanned++
}

if (violations.length > 0) {
  console.error(`check-money-grains: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-money-grains: ok (${scanned} file(s): every money-looking contract field, audit field and column is marked)`)
