#!/usr/bin/env node
/**
 * check-route-manifest — RULE: every route of the factory API has a manifest entry (audiences, permission, scope), and
 * every entry has a route (plan A1 §3.2 and §6.6, PLAN §4.6). The API refuses to boot on the same mistakes
 * (apps/factory-api/src/core/manifest.ts); this guard finds them without starting anything.
 *
 * Scans apps/factory-api/src (or the folder given as the first argument): .ts files, tests and src/testing skipped,
 * comments ignored.
 *   1. A route is `<x>.get|post|put|patch|delete('/path', …)` or `<x>.route({ method: 'GET', url: '/path', … })`.
 *      The path and the method are string literals; on the usual receivers (app, fastify, instance, server, router,
 *      core, routes) a path that is not a literal is a violation, since nobody could check it.
 *   2. `.all()`, `.head()` and `.options()` routes are refused: the manifest names one method per route, and the API
 *      serves no HEAD or OPTIONS route (CORS answers preflights).
 *   3. A file that registers routes calls `defineRoutes(` and finds each route as a key `'METHOD /path'` in itself or
 *      in the `manifest.ts` beside it.
 *   4. Every key of a `manifest.ts` is a route of a file in the same folder (no entry without a route).
 *
 * Run: node scripts/factory/check-route-manifest.mjs [folder] — exit 1 on any violation, listed as file:line and rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SOURCE = resolve(process.argv[2] ?? join(ROOT, 'apps/factory-api/src'))
const SKIP_DIRS = new Set(['node_modules', 'dist', 'testing', 'generated'])
const TEST = /\.(test|spec)\.[cm]?tsx?$/
const KNOWN_RECEIVERS = /^(app|fastify|instance|server|router|core|routes)$/
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const posix = (path) => path.split(sep).join('/')
const shown = (file) => posix(relative(file.startsWith(ROOT) ? ROOT : SOURCE, file))

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : files(path)
    return /\.[cm]?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !TEST.test(entry.name) ? [path] : []
  })
}

/** Blanks comments (keeps newlines and string literals), so line numbers hold. */
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
const violations = []
const report = (file, text, index, rule) => violations.push(`${shown(file)}:${lineOf(text, index)}  ${rule}`)

/** A string literal at the start of `text` (after spaces): its value, or null when it is not a plain literal. */
function literalAt(text) {
  const match = /^\s*(['"`])((?:\\.|(?!\1).)*)\1/s.exec(text)
  if (!match) return null
  if (match[1] === '`' && match[2].includes('${')) return null
  return match[2]
}

/** The routes a file registers: [{ key, index }], with violations reported. */
function routesOf(file, code) {
  const routes = []
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|all|head|options)\s*\(/g)) {
    const [, receiver, method] = m
    const after = code.slice(m.index + m[0].length)
    const path = literalAt(after)
    if (path === null) {
      if (KNOWN_RECEIVERS.test(receiver) && /^\s*[^)\s]/.test(after)) {
        report(file, code, m.index, `rule 1: ${receiver}.${method}() needs its path as a string literal`)
      }
      continue
    }
    if (!path.startsWith('/')) continue
    if (['all', 'head', 'options'].includes(method)) {
      report(file, code, m.index, `rule 2: ${receiver}.${method}('${path}') — register one GET, POST, PUT, PATCH or DELETE per route`)
      continue
    }
    routes.push({ key: `${method.toUpperCase()} ${path}`, index: m.index })
  }
  for (const m of code.matchAll(/\.\s*route\s*\(\s*\{/g)) {
    const body = code.slice(m.index, m.index + 600)
    const method = /\bmethod\s*:\s*(['"`])([A-Za-z]+)\1/.exec(body)?.[2]
    const url = /\burl\s*:\s*(['"`])(\/[^'"`$]*)\1/.exec(body)?.[2]
    if (!method || !url) {
      report(file, code, m.index, 'rule 1: .route({ … }) needs method and url as string literals (one method)')
      continue
    }
    if (!METHODS.has(method.toUpperCase())) {
      report(file, code, m.index, `rule 2: .route({ method: '${method}' }) — one GET, POST, PUT, PATCH or DELETE per route`)
      continue
    }
    routes.push({ key: `${method.toUpperCase()} ${url}`, index: m.index })
  }
  return routes
}

/** The `'METHOD /path'` keys written in a file. */
function keysOf(code) {
  return [...code.matchAll(/(['"`])(GET|POST|PUT|PATCH|DELETE) (\/[^'"`\s]*)\1\s*:/g)].map((m) => ({
    key: `${m[2]} ${m[3]}`,
    index: m.index,
  }))
}

const sources = files(SOURCE)
const codeOf = new Map(sources.map((file) => [file, stripComments(readFileSync(file, 'utf8'))]))
const routesByFolder = new Map()
let routeCount = 0

for (const file of sources) {
  const code = codeOf.get(file)
  const routes = routesOf(file, code)
  if (routes.length === 0) continue
  routeCount += routes.length
  const folder = dirname(file)
  routesByFolder.set(folder, [...(routesByFolder.get(folder) ?? []), ...routes.map((route) => route.key)])
  if (!/\bdefineRoutes\s*\(/.test(code)) {
    report(file, code, routes[0].index, 'rule 3: a file that registers routes wraps them in defineRoutes(name, manifest, plugin)')
  }
  const sibling = join(folder, 'manifest.ts')
  const keys = new Set([...keysOf(code), ...(codeOf.has(sibling) ? keysOf(codeOf.get(sibling)) : [])].map((entry) => entry.key))
  for (const route of routes) {
    if (!keys.has(route.key)) {
      report(file, code, route.index, `rule 3: ${route.key} has no manifest entry (in this file or ${shown(sibling)})`)
    }
  }
}

for (const file of sources.filter((path) => path.endsWith(`${sep}manifest.ts`))) {
  const code = codeOf.get(file)
  const routes = new Set(routesByFolder.get(dirname(file)) ?? [])
  for (const { key, index } of keysOf(code)) {
    if (!routes.has(key)) report(file, code, index, `rule 4: ${key} has a manifest entry but no route in this folder`)
  }
}

if (violations.length > 0) {
  console.error(`check-route-manifest: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log(`check-route-manifest: ok (${routeCount} route(s), each with a manifest entry)`)
