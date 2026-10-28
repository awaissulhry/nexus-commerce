#!/usr/bin/env node
/**
 * check-env-loader — RULE: factory code reads its configuration only through its own env loaders, and never from the
 * repository root's `.env` (on the Owner's Mac that file holds Commerce's production credentials) or from a Commerce
 * variable such as DATABASE_URL.
 *
 * Scans apps/factory-api, apps/factory-web, packages/factory-db, packages/factory-domain and packages/db-kit
 * (.ts .tsx .mts .cts .js .mjs .cjs; node_modules, build output and generated code skipped; comments ignored):
 *   1. no `dotenv` import or require: its default reads the `.env` of the current folder, which can be the root's;
 *   2. env files are parsed (`parseEnv`, `loadEnvFile`) only in the loaders listed in LOADERS;
 *   3. a loader names its env file by an explicit path literal that resolves inside its own workspace, and does not
 *      build a path from `process.cwd()`;
 *   4. no path climbs two or more folders up to a `.env` (`'../../.env'`, or `'..', '..', '.env'` on one line);
 *   5. `process.env` is read only for FACTORY_… names, NODE_ENV and RAILWAY_ENVIRONMENT: no other name, no computed
 *      name, no destructuring of another name or of the rest;
 *   6. outside tests, the Commerce names DATABASE_URL, DIRECT_URL, SHADOW_DATABASE_URL, MIGRATION_DATABASE_URL and
 *      REDIS_URL do not appear at all (FACTORY_DATABASE_URL and friends are fine).
 *
 * Run: node scripts/factory/check-env-loader.mjs — exit 1 on any violation, listed as file:line and rule.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const WORKSPACES = ['apps/factory-api', 'apps/factory-web', 'packages/factory-db', 'packages/factory-domain', 'packages/db-kit']
const LOADERS = new Set(['apps/factory-api/src/env.ts', 'packages/factory-db/prisma.config.ts'])
const ALLOWED_ENV = /^(FACTORY_[A-Z0-9_]+|NODE_ENV|RAILWAY_ENVIRONMENT)$/
const COMMERCE_NAMES = /(?<![\w$])(DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|MIGRATION_DATABASE_URL|REDIS_URL)(?![\w$])/g
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'test-results', 'playwright-report'])
const SKIP_PATHS = new Set(['packages/factory-db/src/generated'])
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/
const TEST = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)tests\//

const posix = (path) => path.split(sep).join('/')

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    const rel = posix(relative(ROOT, path))
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.next') || SKIP_PATHS.has(rel)) return []
      return files(path)
    }
    return CODE.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
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
const violations = []
const report = (file, text, index, rule) => violations.push(`${posix(relative(ROOT, file))}:${lineOf(text, index)}  ${rule}`)

for (const workspace of WORKSPACES) {
  const workspaceDir = join(ROOT, workspace)
  for (const file of files(workspaceDir)) {
    const rel = posix(relative(ROOT, file))
    const code = stripComments(readFileSync(file, 'utf8'))
    const isLoader = LOADERS.has(rel)

    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`]dotenv(?:\/[^'"`]*)?['"`]/g)) {
      report(file, code, m.index, 'rule 1: dotenv is not used in factory code (it reads the current folder\'s .env)')
    }

    if (!isLoader) {
      for (const m of code.matchAll(/\b(parseEnv|loadEnvFile)\s*\(/g)) {
        report(file, code, m.index, `rule 2: ${m[1]}() only in the env loaders (${[...LOADERS].join(', ')})`)
      }
    } else {
      const envPaths = [...code.matchAll(/(['"`])([^'"`\n]*\.env)\1/g)]
      if (envPaths.length === 0) report(file, code, 0, 'rule 3: a loader names its .env file by an explicit path literal')
      for (const m of envPaths) {
        const target = resolve(dirname(file), m[2])
        if (target !== join(workspaceDir, '.env')) {
          report(file, code, m.index, `rule 3: ${m[2]} resolves to ${posix(relative(ROOT, target)) || '.'}, not ${workspace}/.env`)
        }
      }
      for (const m of code.matchAll(/\bprocess\.cwd\s*\(/g)) {
        report(file, code, m.index, 'rule 3: a loader does not build its path from process.cwd()')
      }
    }

    for (const m of code.matchAll(/(['"`])((?:[^'"`\n]*\/)?(?:\.\.\/){2,}(?:[^'"`\n]*\/)?\.env[^'"`\n/]*)\1/g)) {
      report(file, code, m.index, `rule 4: ${m[2]} climbs to a .env outside the workspace`)
    }
    code.split('\n').forEach((line, index) => {
      if ((line.match(/(['"`])\.\.\1/g) ?? []).length >= 2 && /(['"`])\.env\1/.test(line)) {
        violations.push(`${rel}:${index + 1}  rule 4: '..', '..', '.env' climbs to a .env outside the workspace`)
      }
    })

    for (const m of code.matchAll(/\bprocess\.env\s*(?:\?\.\s*|\.\s*)([A-Za-z_$][\w$]*)/g)) {
      if (!ALLOWED_ENV.test(m[1])) report(file, code, m.index, `rule 5: process.env.${m[1]} (only FACTORY_…, NODE_ENV, RAILWAY_ENVIRONMENT)`)
    }
    for (const m of code.matchAll(/\bprocess\.env\s*(?:\?\.)?\s*\[\s*(?:(['"`])([^'"`]*)\1\s*\])?/g)) {
      if (m[2] === undefined) report(file, code, m.index, 'rule 5: process.env[…] with a computed name')
      else if (!ALLOWED_ENV.test(m[2])) report(file, code, m.index, `rule 5: process.env['${m[2]}'] (only FACTORY_…, NODE_ENV, RAILWAY_ENVIRONMENT)`)
    }
    for (const m of code.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1].split(',').map((p) => p.trim()).filter(Boolean)) {
        const name = part.startsWith('...') ? part : part.split(/[:=]/)[0].trim()
        if (!ALLOWED_ENV.test(name)) report(file, code, m.index, `rule 5: destructures ${name} from process.env`)
      }
    }

    if (!TEST.test(rel)) {
      for (const m of code.matchAll(COMMERCE_NAMES)) {
        report(file, code, m.index, `rule 6: ${m[1]} is a Commerce variable; factory code uses FACTORY_${m[1]}`)
      }
    }
  }
}

for (const loader of LOADERS) {
  if (!existsSync(join(ROOT, loader))) violations.push(`${loader}  the listed env loader is missing (update LOADERS)`)
}

if (violations.length > 0) {
  console.error(`check-env-loader: ${violations.length} violation(s)\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log('check-env-loader: ok (factory code reads only its own .env files and FACTORY_ variables)')
