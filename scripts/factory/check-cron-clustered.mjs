#!/usr/bin/env node
/**
 * check-cron-clustered — RULE: the factory schedules work only through the clustered cron (plan A1 §3.1 and §6.6;
 * Commerce hard rule 7 for the factory). A plain scheduler runs once per process, so a second scheduler replica (or a
 * worktree's local run) would run every job twice. apps/factory-api/src/core/cron.ts claims each tick in Redis first.
 *
 *   1. `node-cron` is imported (import, export … from, import(), require()) only by apps/factory-api/src/core/cron.ts;
 *   2. no factory code imports another scheduler library: cron, node-schedule, croner, toad-scheduler, bree, agenda;
 *   3. no factory code creates a BullMQ repeatable job (`upsertJobScheduler(`, a `repeat:` job option): the scheduler
 *      process and core/cron.ts own the schedules;
 *   4. core/cron.ts still claims each tick: it runs a Redis SET with 'NX' and a TTL ('PX').
 * Scanned: apps/factory-api, apps/factory-web, packages/factory-db, packages/factory-domain, packages/db-kit (.ts .tsx
 * .mts .cts .js .mjs .cjs; tests, node_modules, build output and generated code skipped; comments ignored).
 *
 * Run: node scripts/factory/check-cron-clustered.mjs [root] — root is the repository (default) or a copy of its layout
 * (the plant tests). Exit 1 on any violation, listed as file:line and rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)))
const WORKSPACES = ['apps/factory-api', 'apps/factory-web', 'packages/factory-db', 'packages/factory-domain', 'packages/db-kit']
const CLUSTERED = 'apps/factory-api/src/core/cron.ts'
const SCHEDULERS = ['cron', 'node-schedule', 'croner', 'toad-scheduler', 'bree', 'agenda']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', '.turbo', 'coverage'])
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/

const posix = (path) => path.split(sep).join('/')
const violations = []

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) || entry.name.startsWith('.next') ? [] : files(path)
    return CODE.test(entry.name) && !entry.name.endsWith('.d.ts') && !TEST.test(entry.name) ? [path] : []
  })
}

/** Blanks comments (keeps newlines, so line numbers hold) and leaves string literals as they are. */
function stripComments(source) {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < source.length && source[j] !== c && !(c !== '`' && source[j] === '\n')) j += source[j] === '\\' ? 2 : 1
      out += source.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const importOf = (name) =>
  new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+|\\brequire\\s*\\(\\s*)(['"\`])${escape(name)}(?:\\/[^'"\`]*)?\\1`, 'g')

for (const workspace of WORKSPACES) {
  for (const file of files(join(ROOT, workspace))) {
    const rel = posix(relative(ROOT, file))
    const code = stripComments(readFileSync(file, 'utf8'))
    const report = (index, rule) => violations.push(`${rel}:${lineOf(code, index)}  ${rule}`)
    if (rel !== CLUSTERED) {
      for (const match of code.matchAll(importOf('node-cron'))) {
        report(match.index, `rule 1: node-cron outside ${CLUSTERED}; schedule with defineCron() and the scheduler (core/cron.ts)`)
      }
    }
    for (const library of SCHEDULERS) {
      for (const match of code.matchAll(importOf(library))) report(match.index, `rule 2: the scheduler library ${library}; schedule with defineCron() (core/cron.ts)`)
    }
    for (const match of code.matchAll(/\bupsertJobScheduler\s*\(/g)) report(match.index, 'rule 3: a BullMQ job scheduler; schedule with defineCron() (core/cron.ts)')
    for (const match of code.matchAll(/\brepeat\s*:\s*\{/g)) report(match.index, 'rule 3: a BullMQ repeatable job (repeat:); schedule with defineCron() (core/cron.ts)')
  }
}

const clustered = join(ROOT, CLUSTERED)
if (!existsSync(clustered)) {
  violations.push(`${CLUSTERED}  rule 4: the clustered cron is missing`)
} else {
  const code = stripComments(readFileSync(clustered, 'utf8'))
  if (!/\.set\s*\([\s\S]{0,200}?['"]PX['"][\s\S]{0,100}?['"]NX['"]/.test(code)) {
    violations.push(`${CLUSTERED}  rule 4: no tick claim (redis.set(key, holder, 'PX', ttl, 'NX')); every tick must be claimed before it runs`)
  }
}

if (violations.length > 0) {
  console.error(`check-cron-clustered: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-cron-clustered: ok (node-cron only in ${CLUSTERED}, which claims every tick in Redis)`)
