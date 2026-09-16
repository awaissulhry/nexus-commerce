#!/usr/bin/env node
//
// Model-ownership completeness.
//
// `workspaces/model-ownership.json` classifies every Prisma model as a
// `workspaceModel` (one business owns each row) or a `globalModel` (spans
// businesses). `scripts/workspace-policies.mjs` builds the row-level security
// from it, and the disposable test database applies what that builds.
//
// A model in NEITHER list gets no GRANT to `nexus_workspace_runtime` and no
// policy at all. Nothing else notices: `prisma validate`, tsc, both schema
// drift checks and every existing test pass. The first sign is a test that
// cannot read its own table, or a production write refused for no visible
// reason.
//
// It happened TWICE on 2026-09-16, a few hours apart — `ChannelAccountGrant`,
// then `WorkspaceMemberAccountLimit` — and both were caught only by counting
// by hand. This is that count, made permanent.
//
// Fails on:
//   • a model in the schema that is in neither list        (the bug above)
//   • a name in a list that is no longer a model           (a stale entry)
//   • a model listed in BOTH                                (contradictory)
//   • zero models parsed                                    (an empty result is not a pass)
//
//   node packages/database/scripts/check-model-ownership.mjs

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const schemaPath = join(pkgRoot, 'prisma', 'schema.prisma')
const ownershipPath = join(pkgRoot, 'workspaces', 'model-ownership.json')

function fail(lines) {
  console.error(`\n❌ model-ownership check FAILED\n\n${lines.join('\n')}\n`)
  process.exit(1)
}

const schema = readFileSync(schemaPath, 'utf8')
const models = [...schema.matchAll(/^model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)].map(m => m[1])
// An empty parse would make every check below vacuously true.
if (models.length === 0) fail([`No models parsed from ${schemaPath} — the check would have passed with nothing to look at.`])

let ownership
try {
  ownership = JSON.parse(readFileSync(ownershipPath, 'utf8'))
} catch (error) {
  fail([`Could not read ${ownershipPath}: ${error.message}`])
}
const workspace = ownership.workspaceModels ?? []
const global = ownership.globalModels ?? []
if (workspace.length + global.length === 0) fail([`${ownershipPath} lists no models at all.`])

const inSchema = new Set(models)
const inWorkspace = new Set(workspace)
const inGlobal = new Set(global)

const unclassified = models.filter(m => !inWorkspace.has(m) && !inGlobal.has(m))
const stale = [...inWorkspace, ...inGlobal].filter(m => !inSchema.has(m))
const both = workspace.filter(m => inGlobal.has(m))
const duplicated = [...workspace, ...global].filter((m, i, all) => all.indexOf(m) !== i)

const problems = []
if (unclassified.length) {
  problems.push(
    `Unclassified — in schema.prisma, in NEITHER list (${unclassified.length}):`,
    ...unclassified.map(m => `    ${m}`),
    '',
    '  Add each to packages/database/workspaces/model-ownership.json:',
    '    • "workspaceModels" if one business owns every row — the generated',
    '      isolation policy then scopes it automatically;',
    '    • "globalModels" if a row spans businesses — it then gets a GRANT but',
    '      NO generated policy, so it must bring its own in a workspaces/*.sql file.',
    '',
  )
}
if (stale.length) problems.push(`Stale — listed but no longer a model (${stale.length}):`, ...stale.map(m => `    ${m}`), '')
if (both.length) problems.push(`Contradictory — listed as BOTH workspace and global (${both.length}):`, ...both.map(m => `    ${m}`), '')
if (duplicated.length) problems.push(`Listed more than once (${[...new Set(duplicated)].length}):`, ...[...new Set(duplicated)].map(m => `    ${m}`), '')

if (problems.length) fail(problems)

console.log(`✓ model-ownership: all ${models.length} models classified (${workspace.length} workspace · ${global.length} global), none stale.`)
