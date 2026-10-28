#!/usr/bin/env node
/**
 * check-prisma-output — RULE: every generator in a factory Prisma schema has an explicit `output`, and that output
 * lies inside the schema's own workspace and outside node_modules. Without an output a generator writes into
 * node_modules, where Commerce's Prisma client lives, and one `prisma generate` would overwrite the other.
 *
 * Scans every .prisma file under the factory workspaces (apps/factory-api, apps/factory-web, packages/factory-db,
 * packages/factory-domain, packages/db-kit). A relative output is read from the folder of the file that holds the
 * generator, as Prisma does.
 *
 * Run: node scripts/factory/check-prisma-output.mjs — exit 1 on any violation, listed as file:line and rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKSPACES = ['apps/factory-api', 'apps/factory-web', 'packages/factory-db', 'packages/factory-domain', 'packages/db-kit']

const posix = (path) => path.split(sep).join('/')
const lineOf = (text, index) => text.slice(0, index).split('\n').length
const violations = []
let generators = 0

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return ['node_modules', 'generated', 'dist'].includes(entry.name) || entry.name.startsWith('.next') ? [] : files(path)
    return entry.name.endsWith('.prisma') ? [path] : []
  })
}

for (const workspace of WORKSPACES) {
  const workspaceDir = join(ROOT, workspace)
  for (const file of files(workspaceDir)) {
    const text = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, (comment) => ' '.repeat(comment.length))
    for (const block of text.matchAll(/\bgenerator\s+(\w+)\s*\{([^}]*)\}/g)) {
      generators++
      const where = `${posix(relative(ROOT, file))}:${lineOf(text, block.index)}  generator ${block[1]}`
      const output = /^\s*output\s*=\s*"([^"]+)"/m.exec(block[2])
      if (!output) {
        violations.push(`${where} has no output (it would write into node_modules, next to Commerce's client)`)
        continue
      }
      const target = isAbsolute(output[1]) ? output[1] : resolve(dirname(file), output[1])
      const inside = relative(workspaceDir, target)
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        violations.push(`${where}: output ${output[1]} resolves to ${posix(relative(ROOT, target))}, outside ${workspace}`)
      } else if (posix(target).split('/').includes('node_modules')) {
        violations.push(`${where}: output ${output[1]} is inside node_modules`)
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`check-prisma-output: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-prisma-output: ok (${generators} factory generator(s), each with its own output inside its workspace)`)
