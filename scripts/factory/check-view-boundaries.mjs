#!/usr/bin/env node
/**
 * check-view-boundaries — RULE: apps/factory-web keeps its four views and its screen views apart (plan A1 §6.6,
 * PLAN §3.1).
 *   1. The web never reaches a database or a server's insides: no `@nexus/factory-db`, Prisma, pg, Redis or BullMQ, no
 *      factory API source (`@nexus/factory-api`, apps/factory-api), no Commerce app (`apps/web`, `apps/api`).
 *   2. A screen's VIEW (any file in a `view/` folder) draws one view model and fetches nothing: no API client
 *      (src/lib/api), no session loader or office API hook (src/lib/session/{server,context}), no request headers or
 *      cookies (`next/headers`, `next/server`, `next/cache`, src/lib/i18n/server), no link token reader, no
 *      `fetch(`, no `'use server'`, no `process.env`, no TanStack Query. The page or container that renders the view
 *      loads the data (a build step swaps fixtures for the API without touching the view).
 *   3. A view (route group) never imports another's files: Office (`src/app/(office)`, `src/shell/{office,nav,switcher,
 *      palette}`, `src/areas`), Links (`src/app/(links)`, `src/shell/links`, `src/links`), Floor (`src/app/(floor)`, `src/floor`),
 *      Portal (`src/app/(portal)`, `src/portal`, `src/shell/portal`). Shared code lives in src/lib. Design-only files
 *      (`fixtures.ts`, `src/shell/design-data.ts`) and tests are exempt, and nothing but a fixture, a test or the
 *      design index may import a design-only file.
 *
 * Imports are read as written (`from '…'`, `import('…')`, `require('…')`, `export … from '…'`); relative ones are
 * resolved from their file. Comments are ignored.
 *
 * Run: node scripts/factory/check-view-boundaries.mjs — exit 1 on any violation, listed as file:line and rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB = join(ROOT, 'apps/factory-web')
const SRC = join(WEB, 'src')
const CODE = /\.(tsx|ts|jsx|js|mjs|cjs)$/
const TEST = /\.(vitest\.)?test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/

const posix = (path) => path.split(sep).join('/')
const fromSrc = (path) => posix(relative(SRC, path))

const FORBIDDEN_PACKAGES = [
  [/^@nexus\/factory-db(\/|$)/, 'the factory database (the web never touches it: it calls the API)'],
  [/^@prisma\//, 'Prisma'],
  [/^(pg|postgres|ioredis|redis|bullmq)(\/|$)/, 'a database or queue client'],
  [/^@nexus\/(factory-api|web|api)(\/|$)/, 'another app'],
]
const FORBIDDEN_PATHS = [
  [/^apps\/factory-api\//, 'the factory API source'],
  [/^apps\/(web|api)\//, 'a Commerce app'],
  [/^packages\/factory-db\//, 'the factory database package'],
]

const VIEW_FETCHING = [
  [/^next\/(headers|server|cache)$/, 'request headers, cookies or server caching'],
  [/^@tanstack\/react-query/, 'data fetching (TanStack Query)'],
  [/^server-only$/, 'server-only code'],
]
const VIEW_FETCHING_FILES = [
  [/^lib\/api\//, 'the API client'],
  [/^lib\/session\/(server|context)(\.tsx?)?$/, 'the session loader or the office API hook'],
  [/^lib\/i18n\/server(\.ts)?$/, 'the request (headers, cookies)'],
  [/^lib\/links\/token(\.ts)?$/, 'the link token reader'],
]

const VIEWS = [
  ['office', [/^app\/\(office\)\//, /^shell\/(office|nav|switcher|palette)\//, /^areas\//]],
  ['links', [/^app\/\(links\)\//, /^shell\/links\//, /^links\//]],
  ['floor', [/^app\/\(floor\)\//, /^floor\//]],
  ['portal', [/^app\/\(portal\)\//, /^portal\//, /^shell\/portal\//]],
]
const DESIGN_ONLY = (path) => /(^|\/)fixtures\.ts$/.test(path) || path === 'shell/design-data.ts'
const DESIGN_INDEX = (path) => path.startsWith('app/design/')
const viewOf = (path) => VIEWS.find(([, patterns]) => patterns.some((pattern) => pattern.test(path)))?.[0] ?? null

/** Blanks comments (keeps newlines and string literals). */
function stripComments(source) {
  let out = ''
  let i = 0
  let quote = null
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
    } else if (c === "'" || c === '"' || c === '`') {
      quote = c
      out += c
      i++
    } else if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? source.length : end + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else {
      out += c
      i++
    }
  }
  return out
}

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.next') ? [] : files(path)
    return CODE.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

/** A relative import as a path under src/ (extension-less, as written), or null for a package. */
function resolveSpecifier(file, specifier) {
  if (!specifier.startsWith('.')) return null
  return posix(relative(SRC, resolve(dirname(file), specifier)))
}

const violations = []
let checked = 0
let views = 0

for (const file of files(SRC)) {
  const path = fromSrc(file)
  const isTest = TEST.test(path)
  const isView = /(^|\/)view\//.test(path) && !isTest
  const view = viewOf(path)
  const exempt = isTest || DESIGN_ONLY(path) || DESIGN_INDEX(path)
  if (isView) views++
  checked++
  const text = stripComments(readFileSync(file, 'utf8'))
  const lineAt = (index) => text.slice(0, index).split('\n').length
  const report = (index, rule) => violations.push(`apps/factory-web/src/${path}:${lineAt(index)}  ${rule}`)

  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm)) {
    const specifier = match[2]
    const target = resolveSpecifier(file, specifier)
    const repoPath = target === null ? null : posix(relative(ROOT, join(SRC, target)))

    // 1. never a database, a server's source or another app
    for (const [pattern, what] of FORBIDDEN_PACKAGES) if (pattern.test(specifier)) report(match.index, `imports ${what}: '${specifier}'`)
    if (repoPath) for (const [pattern, what] of FORBIDDEN_PATHS) if (pattern.test(repoPath)) report(match.index, `imports ${what}: '${specifier}'`)

    // 2. a view fetches nothing
    if (isView) {
      for (const [pattern, what] of VIEW_FETCHING) if (pattern.test(specifier)) report(match.index, `a view imports ${what}: '${specifier}' (load data in the page, pass the view model)`)
      if (target !== null) for (const [pattern, what] of VIEW_FETCHING_FILES) if (pattern.test(target)) report(match.index, `a view imports ${what}: '${specifier}' (load data in the page, pass the view model)`)
    }

    if (target === null) continue
    // 3. a view group never imports another's files; design-only files stay in design code
    if (!exempt && view) {
      const other = viewOf(target)
      if (other && other !== view) report(match.index, `the ${view} view imports the ${other} view: '${specifier}' (share it through src/lib)`)
    }
    if (!exempt && (DESIGN_ONLY(`${target}.ts`) || DESIGN_ONLY(target))) report(match.index, `imports design-only fixtures: '${specifier}' (only fixtures, tests and src/app/design may)`)
  }

  if (isView) {
    for (const match of text.matchAll(/\bfetch\s*\(/g)) report(match.index, 'a view calls fetch() (load data in the page, pass the view model)')
    for (const match of text.matchAll(/(['"])use server\1/g)) report(match.index, "a view holds a server action ('use server')")
    for (const match of text.matchAll(/\bprocess\.env\b/g)) report(match.index, 'a view reads process.env')
  }
}

if (violations.length > 0) {
  console.error(`check-view-boundaries: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-view-boundaries: ok (${checked} files in apps/factory-web/src, ${views} view file(s); no database, no fetching in views, no view importing another)`)
