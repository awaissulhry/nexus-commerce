#!/usr/bin/env node
/**
 * check-no-design-route — RULE: the local design index `/design` (PLAN §3.1) never reaches a production build of
 * apps/factory-web. Its pages hold made-up data and every screen of the app; a deployed one would show them to anyone.
 *
 * How the app keeps it out (apps/factory-web/src/lib/design/route.ts): the design route files are named
 * `page.design.tsx` (`layout.design.tsx` …), and next.config.ts adds `design.tsx` to `pageExtensions` only for the
 * development server, so `next build` does not see them as routes at all. This guard holds every part of that:
 *   1. every Next.js route file under src/app/design/ carries the `.design.tsx` extension (a `page.tsx` there would ship);
 *   2. the `.design.tsx` extension is used only under src/app/design/ (dev-only routes live in one place);
 *   3. next.config.ts gives the design extension only to the development server, and route.ts declares only it;
 *   4. no app code outside src/app/design/ imports the design index (its registry or its parts);
 *   5. when a production build exists (`.next/BUILD_ID`), none of its route manifests names a `/design` route.
 *      `--require-build` makes a missing build a failure (run it after `next build`).
 *
 * Run: node scripts/factory/check-no-design-route.mjs [--require-build] — exit 1 on any violation.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WEB = join(ROOT, 'apps/factory-web')
const APP = join(WEB, 'src/app')
const DESIGN = join(APP, 'design')
const ROUTE_FILE = /^(page|layout|template|loading|error|global-error|not-found|forbidden|unauthorized|default|route)\.(tsx|ts|jsx|js|mdx|md)$/
const DESIGN_FILE = /\.design\.tsx$/
const CODE = /\.(tsx|ts|jsx|js|mjs|cjs)$/

const posix = (path) => path.split(sep).join('/')
const rel = (path) => posix(relative(ROOT, path))
const violations = []

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name.startsWith('.next') ? [] : files(path)
    return [path]
  })
}

// 1 + 2: route files.
const designFiles = files(DESIGN)
for (const file of designFiles) {
  const name = file.slice(file.lastIndexOf(sep) + 1)
  if (ROUTE_FILE.test(name)) violations.push(`${rel(file)}: a route file under src/app/design must be named <name>.design.tsx, or \`next build\` ships it`)
}
for (const file of files(join(WEB, 'src'))) {
  if (DESIGN_FILE.test(file) && !posix(file).startsWith(`${posix(DESIGN)}/`)) violations.push(`${rel(file)}: the .design.tsx extension (dev-only route) is for src/app/design only`)
}
const designRoutes = designFiles.filter((file) => DESIGN_FILE.test(file))

// 3: the config.
const config = existsSync(join(WEB, 'next.config.ts')) ? readFileSync(join(WEB, 'next.config.ts'), 'utf8') : ''
if (!/pageExtensions:\s*pageExtensionsFor\(\s*phase\s*===\s*PHASE_DEVELOPMENT_SERVER\s*\)/.test(config)) {
  violations.push('apps/factory-web/next.config.ts: pageExtensions must be pageExtensionsFor(phase === PHASE_DEVELOPMENT_SERVER) (the design extension for `next dev` only)')
}
const route = existsSync(join(WEB, 'src/lib/design/route.ts')) ? readFileSync(join(WEB, 'src/lib/design/route.ts'), 'utf8') : ''
const declared = /DESIGN_PAGE_EXTENSIONS\s*=\s*\[([^\]]*)\]/.exec(route)?.[1]?.match(/'[^']*'|"[^"]*"/g) ?? []
if (declared.length !== 1 || declared[0].slice(1, -1) !== 'design.tsx') {
  violations.push(`apps/factory-web/src/lib/design/route.ts: DESIGN_PAGE_EXTENSIONS must be exactly ['design.tsx'] (found ${declared.join(', ') || 'none'})`)
}
if (!/PAGE_EXTENSIONS\s*=\s*\['tsx',\s*'ts',\s*'jsx',\s*'js'\]/.test(route)) {
  violations.push("apps/factory-web/src/lib/design/route.ts: PAGE_EXTENSIONS must stay Next's defaults ['tsx', 'ts', 'jsx', 'js']")
}

// 4: nothing outside the design folder pulls the index in.
for (const file of files(join(WEB, 'src'))) {
  if (!CODE.test(file) || posix(file).startsWith(`${posix(DESIGN)}/`)) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
    if (/(^|\/)app\/design(\/|$)|^\.{1,2}\/(\.\.\/)*design\/(_registry|_parts)/.test(match[1])) {
      violations.push(`${rel(file)}:${text.slice(0, match.index).split('\n').length}: imports the design index (${match[1]}); only src/app/design may`)
    }
  }
}

// 5: the production build.
const requireBuild = process.argv.includes('--require-build')
let buildNote = 'no production build to inspect'
if (existsSync(join(WEB, '.next/BUILD_ID'))) {
  const manifests = ['.next/app-path-routes-manifest.json', '.next/server/app-paths-manifest.json', '.next/routes-manifest.json', '.next/prerender-manifest.json']
  const seen = []
  let routes = 0
  for (const manifest of manifests) {
    const path = join(WEB, manifest)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    seen.push(manifest)
    routes += (text.match(/"\/[^"]*"/g) ?? []).length
    for (const hit of text.matchAll(/"(\/design(?:\/[^"]*)?)"/g)) violations.push(`apps/factory-web/${manifest}: the production build has a /design route (${hit[1]})`)
  }
  if (seen.length === 0) violations.push('apps/factory-web/.next: a build exists but none of its route manifests could be read')
  buildNote = `production build ${readFileSync(join(WEB, '.next/BUILD_ID'), 'utf8').trim()}: ${seen.length} manifest(s), ${routes} route entries, none under /design`
} else if (requireBuild) {
  violations.push('apps/factory-web/.next/BUILD_ID: no production build (run `next build` first, or drop --require-build)')
}

if (violations.length > 0) {
  console.error(`check-no-design-route: ${violations.length} violation(s)\n  ${[...new Set(violations)].join('\n  ')}`)
  process.exit(1)
}
console.log(`check-no-design-route: ok (${designRoutes.length} dev-only route file(s) under src/app/design; ${buildNote})`)
