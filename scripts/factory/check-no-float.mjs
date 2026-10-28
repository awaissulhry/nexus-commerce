#!/usr/bin/env node
/**
 * check-no-float — RULE: no binary floating point for money or quantities in the factory. Amounts are integer minor
 * units, unit prices and costs Decimal(18,6), quantities Decimal(18,4); a float silently rounds them.
 *
 *   1. The factory Prisma schema (packages/factory-db/prisma/**\/*.prisma) has no field of type Float (Float?, Float[])
 *      and no Unsupported("…") float column.
 *   2. The factory migrations (packages/factory-db/prisma/migrations/**\/*.sql) create no REAL, FLOAT, FLOAT4, FLOAT8
 *      or DOUBLE PRECISION column (comments and string literals ignored).
 *   3. Domain code (packages/factory-domain/src, tests aside) does not turn a decimal into a float: no parseFloat(),
 *      no .toNumber(), and no Number(…) around a value whose name says it is an amount, price, cost, quantity, rate
 *      and so on (QUANTITY_NAMES below).
 *
 * Run: node scripts/factory/check-no-float.mjs — exit 1 on any violation, listed as file:line and rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PRISMA_DIR = join(ROOT, 'packages/factory-db/prisma')
const MIGRATIONS_DIR = join(PRISMA_DIR, 'migrations')
const DOMAIN_DIR = join(ROOT, 'packages/factory-domain/src')
const QUANTITY_NAMES =
  /(qty|quantit|price|cost|amount|total|subtotal|rate|margin|discount|tax|vat|weight|area|balance|deposit|allowance|yield)/i

const posix = (path) => path.split(sep).join('/')
const lineOf = (text, index) => text.slice(0, index).split('\n').length
const violations = []
const report = (file, text, index, rule) => violations.push(`${posix(relative(ROOT, file))}:${lineOf(text, index)}  ${rule}`)

function files(dir, accept) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(path, accept)
    return accept(entry.name) ? [path] : []
  })
}

// 1. Prisma schema: the type is the second word of a field line inside a model or type block.
for (const file of files(PRISMA_DIR, (name) => name.endsWith('.prisma'))) {
  const text = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, (comment) => ' '.repeat(comment.length))
  for (const block of text.matchAll(/\b(model|type)\s+\w+\s*\{([^}]*)\}/g)) {
    const start = block.index + block[0].indexOf('{') + 1
    let offset = 0
    for (const line of block[2].split('\n')) {
      const field = /^\s*(\w+)\s+(\S+)/.exec(line)
      if (field && /^Float(\?|\[\])?$/.test(field[2])) {
        report(file, text, start + offset, `rule 1: field ${field[1]} is ${field[2]}; use Int (minor units) or Decimal`)
      }
      if (/Unsupported\(\s*"[^"]*\b(real|float[48]?|double)\b/i.test(line)) {
        report(file, text, start + offset, 'rule 1: an Unsupported float column')
      }
      offset += line.length + 1
    }
  }
}

// 2. Migrations: comments and string literals blanked first, so a word in a comment or a value does not count.
for (const file of files(MIGRATIONS_DIR, (name) => name.endsWith('.sql'))) {
  const text = readFileSync(file, 'utf8')
    .replace(/--.*$/gm, (comment) => ' '.repeat(comment.length))
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/'(?:[^']|'')*'/g, (literal) => literal.replace(/[^\n]/g, ' '))
  for (const m of text.matchAll(/\b(double\s+precision|float[48]?|real)\b/gi)) {
    report(file, text, m.index, `rule 2: ${m[1].toUpperCase()} column type; use INTEGER/BIGINT minor units or NUMERIC`)
  }
}

// 3. Domain code.
for (const file of files(DOMAIN_DIR, (name) => /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name))) {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, (comment, before) => before + ' '.repeat(comment.length - before.length))
  for (const m of text.matchAll(/(?<![\w$.])(?:Number\.)?parseFloat\s*\(/g)) report(file, text, m.index, 'rule 3: parseFloat()')
  for (const m of text.matchAll(/\.toNumber\s*\(\s*\)/g)) report(file, text, m.index, 'rule 3: .toNumber() on a decimal')
  for (const m of text.matchAll(/(?<![\w$.])Number\s*\(/g)) {
    let depth = 1
    let end = m.index + m[0].length
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth++
      if (text[end] === ')') depth--
      end++
    }
    const argument = text.slice(m.index + m[0].length, end - 1)
    if (QUANTITY_NAMES.test(argument)) report(file, text, m.index, `rule 3: Number(${argument.trim()}) turns a decimal into a float`)
  }
}

if (violations.length > 0) {
  console.error(`check-no-float: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log('check-no-float: ok (no Float in the factory schema or migrations, no decimal-to-float in domain code)')
