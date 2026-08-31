#!/usr/bin/env node
/**
 * PH.3 §guard — every field in the product graph has a stated auth decision.
 *
 * WHY
 * A single /graphql route carries ONE route-level permission, so route-keyed
 * RBAC — the platform's mechanism everywhere else — cannot distinguish a
 * product name from its cost price. Field-level protection has to be written
 * down per field, and the failure mode is silence: a field added to the SDL
 * with no decision is simply SERVED. Nothing errors, nothing logs.
 *
 * WHAT IT CHECKS (real parsers, no regex — a regex over SDL reads
 * descriptions and comments as fields)
 *   1. Every object-type field in schema.ts has an entry in FIELD_AUTH.
 *   2. No stale FIELD_AUTH entries for fields that no longer exist — a stale
 *      registry reads as coverage it does not have.
 *   3. The schema stays READ-ONLY. A Mutation type means the /graphql route's
 *      single read permission is now gating writes too, which must be split
 *      before it ships rather than discovered after.
 *
 *   node scripts/check-graph-contract.mjs
 */
import ts from 'typescript'
import { parse } from 'graphql'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = 'apps/api/src/graph/schema.ts'
const AUTH = 'apps/api/src/graph/auth.ts'

function fail(title, lines, hint) {
  console.error(`\n❌ graph contract: ${title}\n`)
  for (const l of lines) console.error(`   ${l}`)
  console.error(`\n   ${hint}\n`)
  process.exit(1)
}

/** Pull the SDL out of `export const schema = \`...\`` via the TS AST. */
function readSdl() {
  const src = readFileSync(join(repoRoot, SCHEMA), 'utf8')
  const sf = ts.createSourceFile(SCHEMA, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let sdl = null
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sf) === 'schema' &&
      node.initializer &&
      (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isTemplateExpression(node.initializer))
    ) {
      sdl = node.initializer.getText(sf).replace(/^`|`$/g, '')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return sdl
}

/** Read the FIELD_AUTH keys via the TS AST. */
function readRegistry() {
  const src = readFileSync(join(repoRoot, AUTH), 'utf8')
  const sf = ts.createSourceFile(AUTH, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const keys = new Set()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === 'FIELD_AUTH' && node.initializer) {
      let init = node.initializer
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) init = init.expression
      if (ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (prop.name) keys.add(prop.name.getText(sf).replace(/^['"]|['"]$/g, ''))
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return keys
}

const sdl = readSdl()
if (!sdl) {
  fail('could not read the SDL', [`${SCHEMA}: no \`export const schema = \`…\`\``],
       'The guard parses the schema template literal. If its shape changed, update this parser — do not delete the check.')
}

const doc = parse(sdl)
const fields = []
let hasMutation = false
for (const def of doc.definitions) {
  if (def.kind !== 'ObjectTypeDefinition') continue
  const typeName = def.name.value
  if (typeName === 'Mutation') hasMutation = true
  if (typeName === 'Subscription') hasMutation = true
  for (const f of def.fields ?? []) fields.push(`${typeName}.${f.name.value}`)
}

if (hasMutation) {
  fail('the schema is no longer read-only',
       ['a Mutation or Subscription type is defined in the SDL'],
       `/graphql is mapped to the READ permission (products.view) in permissions-manifest.ts. Split that mapping before shipping a write surface.`)
}

const registry = readRegistry()
const missing = fields.filter((f) => !registry.has(f))
if (missing.length) {
  fail(`${missing.length} field(s) have no auth decision`, missing,
       `Add each to FIELD_AUTH in ${AUTH}. An unlisted field is SERVED — silence is the failure mode this guard removes.`)
}

const stale = [...registry].filter((k) => !fields.includes(k))
if (stale.length) {
  fail(`${stale.length} stale FIELD_AUTH entr(ies)`, stale,
       'These fields are not in the schema. A stale registry reads as coverage it does not have.')
}

console.log(
  `✓ graph contract: ${fields.length} field(s), every one with a stated auth decision; schema is read-only`,
)
