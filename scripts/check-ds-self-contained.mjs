#!/usr/bin/env node
/**
 * The design system is self-contained — `apps/web/src/design-system`.
 *
 * WHY THIS EXISTS
 * The design system is meant to move as ONE folder (into its own package) and to be used by more
 * than one app. It can only do that if nothing in it reaches out of it. One import of app code, or
 * one `@/…` alias (which means "this app's src/"), and the folder no longer builds anywhere else.
 * App code may import the design system; the design system may not import app code.
 *
 * THE RULE (strict, no baseline: the count is zero)
 * A file under `apps/web/src/design-system/` imports only
 *   - a relative path that stays inside that folder, and
 *   - an npm package.
 * It never imports through an alias (`@/…`, or any other `paths` key in `apps/web/tsconfig.json`),
 * a bare path that the tsconfig `baseUrl` resolves into the app (`src/lib/x`), an absolute path,
 * or a relative path that leaves the folder. The `/design-system` page's examples
 * live with the page (`apps/web/src/app/design-system/_catalog/`), and tests that need app code or
 * repo fixtures live next to that app code, so they are not exceptions here.
 *
 * WHAT COUNTS AS AN IMPORT
 * Read from the TypeScript syntax tree, so comments and prose never count: import and export
 * declarations, `import x = require()`, `import()`, `require()`, `typeof import()` types, and the
 * module argument of `vi.mock` / `vi.doMock` / `vi.unmock` / `vi.doUnmock` / `vi.importActual` /
 * `vi.importMock`. An `import()` whose path is computed cannot be checked, so it fails too.
 * In CSS: `@import` and `url()` (data: and remote URLs are fine).
 * Files: `.ts .tsx .mts .cts .js .jsx .mjs .cjs .css`, tracked and untracked (git-ignored files,
 * such as generated `.d.ts`, are skipped).
 *
 * NOT COVERED: a path a test builds at run time and reads with `fs` (`new URL('../x', import.meta.url)`).
 *
 *   node scripts/check-ds-self-contained.mjs     # exit 1 on any import that leaves the folder
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DS_REL = 'apps/web/src/design-system'
const DS = join(ROOT, DS_REL)
const TSCONFIG = join(ROOT, 'apps/web/tsconfig.json')
const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const CSS = /\.css$/
const VI = new Set(['mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock'])

// Every alias the web app defines (`@/*` today), plus `@/` itself so the rule cannot loosen if the
// tsconfig entry is ever renamed.
const config = ts.readConfigFile(TSCONFIG, ts.sys.readFile)
const aliasPrefixes = new Set(['@/'])
for (const key of Object.keys(config.config?.compilerOptions?.paths ?? {})) aliasPrefixes.add(key.replace(/\*$/, ''))
// `baseUrl` (apps/web/tsconfig.json sets ".") lets a bare `src/lib/x` resolve into the app, so a bare
// specifier is only an npm package when it does NOT name a file under the baseUrl.
const baseUrl = config.config?.compilerOptions?.baseUrl
const BASE = baseUrl ? resolve(dirname(TSCONFIG), baseUrl) : null
const EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts', '.json', '.css', '/index.ts', '/index.tsx', '/index.js']
const viaBaseUrl = (spec) => BASE !== null && EXTS.some((ext) => existsSync(join(BASE, spec + ext)))

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const files = [...new Set([
  ...git('ls-files', '-z', '--', DS_REL).split('\0'),
  ...git('ls-files', '-z', '--others', '--exclude-standard', '--', DS_REL).split('\0'),
])].filter((f) => f && (CODE.test(f) || CSS.test(f)))

if (!files.length) {
  console.error(`✗ ds-self-contained: no design-system files found under ${DS_REL} — nothing was checked.`)
  process.exit(1)
}

const inside = (abs) => abs === DS || abs.startsWith(DS + sep)

/** Why a specifier leaves the design system, or null when it is fine. */
function verdict(spec, fileAbs) {
  for (const prefix of aliasPrefixes) if (spec.startsWith(prefix)) return `alias "${prefix}"`
  if (spec.startsWith('/')) return 'absolute path'
  if (spec.startsWith('.')) return inside(resolve(dirname(fileAbs), spec)) ? null : 'relative path out of the design system'
  if (viaBaseUrl(spec)) return 'bare path resolved through the tsconfig baseUrl'
  return null // npm package (or a node: builtin)
}

const offenders = []
const report = (file, line, spec, why) => offenders.push(`  ${file}:${line}  '${spec}'  — ${why}`)

for (const file of files) {
  const abs = join(ROOT, file)
  let src
  try { src = readFileSync(abs, 'utf8') } catch { continue } // listed but deleted in the working tree
  if (CSS.test(file)) {
    const css = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    const re = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1|url\(\s*(['"]?)([^'")]+)\3\s*\)/g
    let m
    while ((m = re.exec(css))) {
      const spec = (m[2] ?? m[4]).trim()
      if (/^(data:|https?:|#|var\()/.test(spec)) continue
      const why = verdict(spec, abs)
      if (why) report(file, css.slice(0, m.index).split('\n').length, spec, why)
    }
    continue
  }
  const kind = /x$/.test(file) ? ts.ScriptKind.TSX : /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, kind)
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const check = (node, computedFails) => {
    if (!node) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const why = verdict(node.text, abs)
      if (why) report(file, lineOf(node), node.text, why)
    } else if (computedFails) {
      report(file, lineOf(node), node.getText(sf).slice(0, 60), 'computed import() path — cannot be checked')
    }
  }
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) check(n.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) check(n.moduleReference.expression)
    else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) check(n.argument.literal)
    else if (ts.isCallExpression(n)) {
      const e = n.expression
      if (e.kind === ts.SyntaxKind.ImportKeyword) check(n.arguments[0], true)
      else if (ts.isIdentifier(e) && e.text === 'require') check(n.arguments[0])
      else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'vi' && VI.has(e.name.text)) check(n.arguments[0])
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

if (offenders.length) {
  console.error(`✗ ds-self-contained: ${offenders.length} import(s) leave ${DS_REL}:`)
  console.error(offenders.join('\n'))
  console.error(`\n  Inside the design system, import its own files by relative path (e.g. '../primitives', not '@/design-system/primitives').`)
  console.error(`  App code, app tests and repo fixtures stay out: move an example to apps/web/src/app/design-system/_catalog/`)
  console.error(`  and a test that needs app code next to that code. Rule + why: scripts/check-ds-self-contained.mjs header.`)
  process.exit(1)
}
console.log(`✓ ds-self-contained: ${files.length} files; every import stays inside ${DS_REL} or is an npm package`)
