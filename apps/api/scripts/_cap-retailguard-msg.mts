/**
 * CAP step 7 — Retail guard announces a pause it did not perform.
 *
 * Its `notify` action fires unconditionally, so it has been sending
 * "Retail guard paused campaign(s) — check execution log" ~809 times a day while its own
 * `retail_guard` output reads `{ paused: 0, skipped: 0, pausedIds: [] }`.
 *
 * The `notify` handler cannot see the preceding action's result — `meta` is `{ dryRun, ruleId }` —
 * so making it conditional is an engine change with its own blast radius, and threading prior
 * results into every handler to fix one message is not worth it. Reported in the doc; what is
 * fixed here is the claim itself, which is a data change on the rule's actions JSON.
 *
 * Requires --apply. Snapshots the full row first and reads the change back.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const APPLY = process.argv.includes('--apply')
const L: string[] = []
const say = (s = '') => L.push(s)

const OLD = 'Retail guard paused campaign(s) — check execution log'
const NEW = 'Retail guard ran — see the execution log for any campaigns it paused'

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', name: 'Retail guard' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, actions: true },
})
if (rules.length !== 1) { console.error(`🔴 REFUSING: expected exactly 1 rule named "Retail guard", found ${rules.length}`); process.exit(1) }
const rule = rules[0]

say(`── SNAPSHOT ──\n  ${JSON.stringify(rule)}`)

const actions = (Array.isArray(rule.actions) ? (rule.actions as Array<Record<string, unknown>>) : [])
const notifyIdx = actions.findIndex((a) => a?.type === 'notify')
if (notifyIdx < 0) { console.error('🔴 REFUSING: no notify action on Retail guard'); process.exit(1) }
if (actions[notifyIdx].message !== OLD) {
  console.error(`🔴 REFUSING: the message is not what this script was written against.\n  found: ${JSON.stringify(actions[notifyIdx].message)}\n  expected: ${JSON.stringify(OLD)}`)
  process.exit(1)
}

say(`\n── PLAN ──`)
say(`  before: ${OLD}`)
say(`  after : ${NEW}`)
say(`  🔴 the claim is false ~809 times a day: retail_guard's own output reads paused: 0.`)

if (!APPLY) {
  say('\n  DRY RUN — nothing written. Re-run with --apply.')
  process.stdout.write('\n<<<CAP-RGMSG>>>\n' + L.join('\n') + '\n')
  await prisma.$disconnect(); process.exit(0)
}

const next = actions.map((a, i) => (i === notifyIdx ? { ...a, message: NEW } : a))
await prisma.automationRule.update({ where: { id: rule.id }, data: { actions: next as never } })

const after = await prisma.automationRule.findUnique({ where: { id: rule.id }, select: { actions: true } })
const got = (Array.isArray(after?.actions) ? (after!.actions as Array<Record<string, unknown>>) : [])[notifyIdx]?.message
const ok = got === NEW
say(`\n── READ BACK ──`)
say(`  ${ok ? '✓' : '🔴'} notify.message = ${JSON.stringify(got)}`)
say(`  ${actions.length === next.length ? '✓' : '🔴'} action count unchanged: ${actions.length}`)

process.stdout.write('\n<<<CAP-RGMSG>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
process.exit(ok ? 0 : 1)
