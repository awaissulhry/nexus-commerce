/**
 * ACR.1.6c — find class names a component APPLIES that no stylesheet DEFINES.
 *
 * Written after `.h10-pill.bad` was found by accident: referenced by the Ad Manager's
 * delivery column since AX2.1, never defined in `ads.css`, so a FAILED write rendered as
 * plain body text beside "Live" as a proper blue chip. Nothing catches this — it is valid
 * TSX, valid CSS, and the page renders. A second run found `.h10-spw-cs-pwarn.caution`,
 * where the super-wizard's ADVICE was rendering in the exact amber of the BLOCKER above it.
 *
 * The signal to look at is the SECOND list. A whole class that is undefined is usually a
 * semantic wrapper and fine (`acr-today`, `acr-guard` are plain layout divs). A bare
 * MODIFIER riding alongside a defined base class is the dangerous shape: it exists to say
 * "this one is different", and when it is undefined the difference silently disappears —
 * which is worst exactly when the difference is severity.
 *
 * Read-only. Reports; changes nothing.
 *
 *   node scripts/_acr-css-undefined.mjs [rootDir]
 *   node scripts/_acr-css-undefined.mjs apps/web/src/app/marketing/ads     (default)
 *
 * Known limits, stated so the output is not over-trusted:
 *   · Only `className="…"` and `className={`…`}` are read. A class assembled in a variable
 *     or a lookup map is invisible here — which is how `.bad` hid, since it arrived via
 *     DELIVERY_PILL's `cls` field. Scanning the literal halves of template strings catches
 *     the common `${base} modifier` shape but not a fully computed name.
 *   · `${…}` is stripped before tokenising, so a dynamic tail can leave a truncated stub
 *     (`t-` from `t-${tone}`). Treat one-or-two-character tokens as artefacts and check by
 *     hand — all four `.t-*` tones were in fact defined.
 *   · Stylesheets are collected from the same tree, so a class defined in a global sheet
 *     outside `rootDir` reads as missing.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, extname } from 'path'

const ROOT = process.argv[2] ?? 'apps/web/src/app/marketing/ads'
const PROJECT_PREFIX = /^(h10|acr|ads|nx)-/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const files = walk(ROOT)
const sheets = files.filter((f) => extname(f) === '.css')
const components = files.filter((f) => ['.tsx', '.ts'].includes(extname(f)))

// Every class token any stylesheet in this tree defines. Comments stripped first — a class
// NAMED IN A COMMENT would otherwise read as defined, the same trap the DS ratchet hit.
const defined = new Set()
for (const f of sheets) {
  const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of src.matchAll(/\.([A-Za-z_][\w-]*)/g)) defined.add(m[1])
}

const wholeMissing = new Map()
const modifierMissing = new Map()
const add = (map, key, file) => {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(file.replace(`${ROOT}/`, ''))
}

for (const f of components) {
  const src = readFileSync(f, 'utf8')
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    const tokens = (m[1] ?? m[2] ?? '')
      .replace(/\$\{[^}]*\}/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
    for (const t of tokens) {
      if (PROJECT_PREFIX.test(t) && !defined.has(t)) add(wholeMissing, t, f)
    }
    const base = tokens.find((t) => PROJECT_PREFIX.test(t) && defined.has(t))
    if (!base) continue
    for (const t of tokens) {
      if (PROJECT_PREFIX.test(t)) continue
      if (!/^[a-z][\w-]*$/.test(t)) continue
      if (!defined.has(t)) add(modifierMissing, `${base} + .${t}`, f)
    }
  }
}

const show = (title, map, note) => {
  console.log(`\n── ${title} (${map.size}) ──`)
  if (note) console.log(`   ${note}`)
  if (!map.size) { console.log('   none'); return }
  for (const [k, fs] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [first] = fs
    console.log(`   ${k.padEnd(36)} ${first}${fs.size > 1 ? ` +${fs.size - 1}` : ''}`)
  }
}

console.log(`${ROOT}: ${components.length} components · ${sheets.length} stylesheets · ${defined.size} defined classes`)
show('whole classes never defined', wholeMissing, 'usually harmless — semantic wrappers with no styling of their own')
show('MODIFIERS never defined, beside a defined base', modifierMissing, 'the .h10-pill.bad shape — the distinction they exist to draw does not render')
