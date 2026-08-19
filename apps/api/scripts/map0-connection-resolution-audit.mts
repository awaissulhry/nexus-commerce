/**
 * MAP.0 — Connection-resolution audit.
 *
 * Enumerates every site that resolves a `ChannelConnection` and classifies
 * whether the caller NAMES the account it means, or picks one ambiently.
 * The ambient set is exactly the burn-down list MAP.3 has to convert before
 * a second account can safely exist.
 *
 * Run from apps/api:  npx tsx scripts/map0-connection-resolution-audit.mts
 *   --json <path>   also write the machine-readable result
 *   --md   <path>   also write the burn-down checklist as markdown
 *   --ratchet       exit 1 if the ambient count EXCEEDS AMBIENT_BASELINE below.
 *                   This is the MAP.3 guard: the singleton assumption cannot grow
 *                   back. Converting sites lowers the baseline; adding one raises
 *                   it, and raising it is a visible diff someone has to justify.
 *
 * READ-ONLY. Touches no database and no network — it parses source files.
 *
 * Why the TypeScript AST and not grep: per `reference_verification_probe_false_positives`,
 * a regex over source invents findings here. ES6 shorthand (`{ where }`) beats a
 * naive pattern, a `vi.fn()` mock reads as a call site, and a commented-out block
 * counts. This walks the parsed tree, so a match is a real call expression and the
 * `where` keys are real properties.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'
import ts from 'typescript'

/**
 * The number of ambient resolution sites the tree is allowed to contain.
 *
 * 60 when MAP.0 measured it (2026-08-19, 38 files).
 * 54 after MAP.3a converted all six job sites.
 * 12 after MAP.3b converted every remaining service and route.
 *  0 after MAP.6 part 1 converted the flat-file route, with the operator's
 *    explicit approval of the edit list (docs/2026-08-19-map6-flat-file-edit-list.md).
 *
 * **The burn-down is closed.** Zero sites in this codebase resolve a marketplace
 * account without being told, or explicitly declaring, which one they mean. Any
 * increase from here is a regression, not a backlog item — which is exactly what a
 * baseline of 0 is for.
 *
 * Deliberately a structural count, not a grep: a regex over source counts comments
 * and misses ES6 shorthand, which is how the DS guard came to fail on a COMMENT
 * (reference_ds_guard_greps_comments) and how a probe invented three findings in
 * one check (reference_verification_probe_false_positives).
 */
const AMBIENT_BASELINE = 0

/**
 * The one file allowed to resolve a connection ambiently: the resolver itself.
 * `listActiveConnections` genuinely means "every active account for this channel",
 * which is the correct query — it is what the fail-closed decision is made FROM.
 * Everything else must go through it.
 */
const RESOLVER_EXEMPT = new Set(['services/connection-resolver.service.ts'])

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src')

/** Prisma read/write ops we care about on the channelConnection delegate. */
const READ_OPS = new Set(['findFirst', 'findMany', 'findUnique', 'findFirstOrThrow', 'findUniqueOrThrow', 'count'])
const WRITE_OPS = new Set(['create', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])

type Verdict =
  | 'NAMED'          // where.id — the caller already knows which account
  | 'SCOPED'         // filters channelType but NOT isActive-singleton (e.g. by managedBy) — review
  | 'AMBIENT'        // channelType + isActive:true, no id — THE singleton assumption
  | 'INDIRECT'       // where is a variable/shorthand — cannot judge syntactically
  | 'WRITE'          // a write; listed for completeness, not part of the burn-down
  | 'OTHER'

interface Site {
  file: string
  line: number
  op: string
  verdict: Verdict
  channelType: string | null
  whereKeys: string[]
  layer: string
  isTest: boolean
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walkFiles(p, out)
    } else if (/\.(ts|mts)$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

/** apps/api/src/jobs/foo.ts -> "jobs" */
function layerOf(rel: string): string {
  const first = rel.split(path.sep)[0]
  return ['jobs', 'routes', 'services', 'workers', 'lib', 'clients', 'providers', 'utils'].includes(first)
    ? first
    : 'other'
}

/**
 * Collect the top-level keys of a `where` object literal, descending one level
 * into OR/AND/NOT arrays so `{ OR: [{ channelType }, …] }` is not read as opaque.
 */
function collectWhereKeys(node: ts.ObjectLiteralExpression): { keys: string[]; channelType: string | null } {
  const keys: string[] = []
  let channelType: string | null = null

  const visitObj = (obj: ts.ObjectLiteralExpression, depth: number) => {
    for (const prop of obj.properties) {
      // `{ where }` shorthand carries no key information at this site.
      if (ts.isShorthandPropertyAssignment(prop)) {
        keys.push(`${prop.name.text}(shorthand)`)
        continue
      }
      if (ts.isSpreadAssignment(prop)) {
        keys.push('…spread')
        continue
      }
      if (!ts.isPropertyAssignment(prop)) continue
      const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : null
      if (!name) continue
      if (depth === 0) keys.push(name)

      if (name === 'channelType') {
        const init = prop.initializer
        if (ts.isStringLiteral(init)) channelType = init.text
        else channelType = '<dynamic>'
      }
      // Descend into boolean combinators so nested channelType/isActive count.
      if ((name === 'OR' || name === 'AND' || name === 'NOT') && depth < 2) {
        const init = prop.initializer
        if (ts.isArrayLiteralExpression(init)) {
          for (const el of init.elements) {
            if (ts.isObjectLiteralExpression(el)) visitObj(el, depth + 1)
          }
        } else if (ts.isObjectLiteralExpression(init)) {
          visitObj(init, depth + 1)
        }
      }
    }
  }
  visitObj(node, 0)
  return { keys, channelType }
}

function classify(op: string, whereObj: ts.ObjectLiteralExpression | null, allKeys: string[]): Verdict {
  if (WRITE_OPS.has(op)) return 'WRITE'
  if (!whereObj) return allKeys.some((k) => k.endsWith('(shorthand)')) ? 'INDIRECT' : 'OTHER'
  const has = (k: string) => allKeys.includes(k)
  if (has('id')) return 'NAMED'
  if (allKeys.some((k) => k.endsWith('(shorthand)') || k === '…spread')) return 'INDIRECT'
  if (has('channelType') && has('isActive')) return 'AMBIENT'
  if (has('channelType')) return 'SCOPED'
  return 'OTHER'
}

const sites: Site[] = []

for (const file of walkFiles(SRC)) {
  const text = fs.readFileSync(file, 'utf8')
  // Cheap pre-filter; the AST walk below is what actually decides.
  if (!text.includes('channelConnection')) continue

  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const rel = path.relative(SRC, file)
  const isTest = /\.(test|spec|vitest\.test)\.(ts|mts)$/.test(file)

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const opNode = node.expression                       // <recv>.<op>
      const op = opNode.name.text
      const recv = opNode.expression                       // <something>.channelConnection
      if (
        ts.isPropertyAccessExpression(recv) &&
        recv.name.text === 'channelConnection' &&
        (READ_OPS.has(op) || WRITE_OPS.has(op))
      ) {
        const arg = node.arguments[0]
        let whereObj: ts.ObjectLiteralExpression | null = null
        let keys: string[] = []
        let channelType: string | null = null

        if (arg && ts.isObjectLiteralExpression(arg)) {
          const whereProp = arg.properties.find(
            (p) =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
              ts.isIdentifier(p.name) &&
              p.name.text === 'where',
          )
          if (whereProp && ts.isPropertyAssignment(whereProp) && ts.isObjectLiteralExpression(whereProp.initializer)) {
            whereObj = whereProp.initializer
            const collected = collectWhereKeys(whereObj)
            keys = collected.keys
            channelType = collected.channelType
          } else if (whereProp) {
            keys = ['where(shorthand)']
          }
        } else if (arg) {
          keys = ['where(shorthand)']
        }

        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        sites.push({
          file: rel,
          line: line + 1,
          op,
          verdict: classify(op, whereObj, keys),
          channelType,
          whereKeys: keys,
          layer: layerOf(rel),
          isTest,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}

// ── Report ─────────────────────────────────────────────────────────
const prod = sites.filter((s) => !s.isTest && !RESOLVER_EXEMPT.has(s.file.split(path.sep).join('/')))
const tests = sites.filter((s) => s.isTest)
const byVerdict = (v: Verdict, set = prod) => set.filter((s) => s.verdict === v)
const ambient = byVerdict('AMBIENT')
const indirect = byVerdict('INDIRECT')

const pad = (s: string, n: number) => s.padEnd(n)
console.log('\n══ MAP.0 — Connection-resolution audit ══\n')
console.log(`Source root      : ${path.relative(process.cwd(), SRC)}`)
console.log(`Call sites found : ${sites.length}  (${prod.length} production, ${tests.length} in tests)\n`)

console.log('By verdict (production only):')
for (const v of ['AMBIENT', 'INDIRECT', 'NAMED', 'SCOPED', 'WRITE', 'OTHER'] as Verdict[]) {
  const n = byVerdict(v).length
  if (n === 0) continue
  const note =
    v === 'AMBIENT' ? '← the burn-down list: MAP.3 converts these'
    : v === 'INDIRECT' ? '← where-clause is a variable; needs a human read'
    : v === 'NAMED' ? '  already names an account — safe as-is'
    : ''
  console.log(`  ${pad(v, 9)} ${String(n).padStart(4)}   ${note}`)
}

console.log('\nAmbient sites by layer:')
const layers = [...new Set(ambient.map((s) => s.layer))].sort()
for (const l of layers) {
  const inLayer = ambient.filter((s) => s.layer === l)
  const files = new Set(inLayer.map((s) => s.file)).size
  console.log(`  ${pad(l, 10)} ${String(inLayer.length).padStart(3)} sites in ${files} files`)
}

console.log('\nAmbient sites by channelType literal:')
const chans = [...new Set(ambient.map((s) => s.channelType ?? '<none>'))].sort()
for (const c of chans) {
  console.log(`  ${pad(c, 12)} ${String(ambient.filter((s) => (s.channelType ?? '<none>') === c).length).padStart(3)}`)
}

// The heaviest files first — MAP.3 converts them in this order.
console.log('\nTop files by ambient count:')
const perFile = new Map<string, number>()
for (const s of ambient) perFile.set(s.file, (perFile.get(s.file) ?? 0) + 1)
;[...perFile.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .forEach(([f, n]) => console.log(`  ${String(n).padStart(3)}  ${f}`))

if (indirect.length > 0) {
  console.log('\nINDIRECT sites (where-clause not a literal — read these by hand):')
  for (const s of indirect) console.log(`  ${s.file}:${s.line}  .${s.op}()`)
}

// ── Optional outputs ───────────────────────────────────────────────
const argv = process.argv.slice(2)
const optOf = (flag: string) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : null
}

const jsonOut = optOf('--json')
if (jsonOut) {
  fs.writeFileSync(
    jsonOut,
    JSON.stringify(
      {
        generatedFrom: 'apps/api/src',
        totals: {
          all: sites.length,
          production: prod.length,
          tests: tests.length,
          ambient: ambient.length,
          indirect: indirect.length,
          named: byVerdict('NAMED').length,
        },
        sites,
      },
      null,
      2,
    ),
  )
  console.log(`\nJSON written: ${jsonOut}`)
}

const mdOut = optOf('--md')
if (mdOut) {
  const lines: string[] = []
  lines.push('# MAP.0 — connection-resolution burn-down')
  lines.push('')
  lines.push(`Generated by \`apps/api/scripts/map0-connection-resolution-audit.mts\`.`)
  lines.push(`${ambient.length} ambient sites across ${new Set(ambient.map((s) => s.file)).size} files.`)
  lines.push('')
  lines.push('Each line is a site that picks a connection without being told which one.')
  lines.push('MAP.3 converts every one to `resolveConnection(scope)`; the box is ticked when it does.')
  lines.push('')
  for (const l of layers) {
    lines.push(`## ${l}`)
    lines.push('')
    for (const s of ambient.filter((x) => x.layer === l).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      lines.push(`- [ ] \`src/${s.file}:${s.line}\` — \`.${s.op}()\` ${s.channelType ? `(${s.channelType})` : ''}`)
    }
    lines.push('')
  }
  if (indirect.length > 0) {
    lines.push('## Needs a human read (where-clause is not a literal)')
    lines.push('')
    for (const s of indirect) lines.push(`- [ ] \`src/${s.file}:${s.line}\` — \`.${s.op}()\``)
    lines.push('')
  }
  fs.writeFileSync(mdOut, lines.join('\n'))
  console.log(`Markdown written: ${mdOut}`)
}

// ── Ratchet ────────────────────────────────────────────────────────
if (argv.includes('--ratchet')) {
  if (ambient.length > AMBIENT_BASELINE) {
    console.error(
      `\n✗ MAP.3 ratchet: ${ambient.length} ambient connection lookups, baseline is ${AMBIENT_BASELINE}.\n` +
        `  A new site resolves a ChannelConnection without being told which account it means.\n` +
        `  Use resolveConnection(scope) from src/services/connection-resolver.service.ts.\n` +
        `  If the increase is genuinely intended, raise AMBIENT_BASELINE in this file and say why.\n`,
    )
    process.exit(1)
  }
  console.log(
    `✓ MAP.3 ratchet: ${ambient.length} ambient lookups (baseline ${AMBIENT_BASELINE})` +
      (ambient.length < AMBIENT_BASELINE
        ? ` — ${AMBIENT_BASELINE - ambient.length} below; lower AMBIENT_BASELINE to lock the gain in.`
        : ''),
  )
}

console.log('')
