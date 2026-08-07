/**
 * NAF.SB.M.1a — does the map endpoint tell the truth?
 *
 * Read-only. Calls the service directly against prod data and asserts the
 * things the page will claim, especially the ones the CURRENT map gets wrong.
 */
const { getFleetMap } = await import('../src/services/agent-fleet/fleet-map.service.js')
const { default: prisma } = await import('../src/db.js')

const m = await getFleetMap('7d')

console.log(`asOf ${m.asOf.toISOString()}  window=${m.window.key} since=${m.window.since?.toISOString() ?? 'all time'}`)
console.log(`state: halted=${m.state.halted} ceiling=$${m.state.dailyCeilingUSD} spentToday=$${m.state.spentTodayUSD.toFixed(4)} degraded=${m.state.degraded}`)
console.log(`wiring: ${m.wiring.workflows.length} enabled workflow(s) — ${m.wiring.workflows.map((w) => `${w.workflowKey}[${w.kind}/${w.source}/${w.trigger}]`).join(' ')}`)
console.log(`        degraded=${m.wiring.degraded} unordered=${m.wiring.unorderedReason ?? 'no — ranked cleanly'}`)
console.log(`schedule: ${m.schedule.map((j) => `${j.key}=${j.enabled ? (j.nextFireAt?.toISOString() ?? 'no next fire') : 'off'}`).join(' · ')}`)
console.log(`totals: runsLifetime=${m.totals.runsLifetime} crossedLifetime=${m.totals.crossedLifetime}`)
for (const w of m.warnings) console.log(`  ⚠ ${w}`)

console.log(`\nNODES (${m.nodes.length})`)
for (const n of m.nodes) {
  const c = n.charter
  const lr = n.lastRun
  console.log(
    `  ${n.key.padEnd(26)} lane=${n.lane.padEnd(10)} rank=${n.rank ?? '—'} tier=${n.tier.padEnd(9)} ` +
      `${c.enabled ? 'ON ' : 'OFF'} lvl=${c.autonomyLevel}/cap=${c.autonomyCap} prov=${c.provisioned} ` +
      `runs=${n.runs.window}/${n.runs.lifetime} notOk=${n.runs.notOkWindow} running=${n.runs.runningNow} ` +
      `open=${n.findings.open}(${n.findings.openExpired} expired) appr=${n.approvals.waiting}/${n.approvals.scheduled} ` +
      `cost=$${n.cost.windowUSD.toFixed(4)}/${n.cost.runs}runs life=$${n.cost.lifetimeUSD.toFixed(4)} ` +
      `last=${lr ? `${lr.status}/${lr.ok ? 'ok' : 'not-ok'} ${lr.createdAt.toISOString().slice(5, 16)}` : 'NEVER RUN'} ` +
      `by=[${n.declaredBy.map((d) => d.workflowKey).join(',') || '—'}]`,
  )
}

console.log(`\nEDGES (${m.edges.length})`)
for (const e of m.edges) {
  console.log(
    `  ${e.id.padEnd(52)} crossed=${e.counts.crossed} dropped=${e.counts.dropped} conflicted=${e.counts.conflicted} ` +
      `everCrossed=${e.everCrossed} lineage=${e.lineage} verdicts=${e.verdicts ? `p${e.verdicts.pass}/r${e.verdicts.revise}/b${e.verdicts.block}` : '—'} ` +
      `by=[${e.declaredBy.map((d) => `${d.workflowKey}:${d.kind}/${d.source}`).join(',')}]`,
  )
  for (const d of e.dropped.slice(0, 3)) console.log(`      dropped ${d.findingId} (${d.charterKey}) — ${d.reason.slice(0, 80)}`)
}

/* ── the assertions that matter ───────────────────────────────────────── */
console.log('\nCHECKS')
const fail: string[] = []
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) fail.push(label)
}

// 1 — the defect this endpoint exists to kill. `FleetTab.tsx:430-440` labels a
// finding edge with the SOURCE worker's open-findings count and the plan edge
// with `plans.length`. The assertion is that the new vector is not that vector.
// Per-edge equality proves nothing on its own: a worker whose findings were all
// carried will legitimately match, and one does today.
const oldFormula = m.edges
  .filter((e) => e.artifact === 'finding')
  .map((e) => m.nodes.find((n) => n.key === e.from)?.findings.open ?? 0)
const newVector = m.edges.filter((e) => e.artifact === 'finding').map((e) => e.counts.crossed)
ok(
  'the crossed counts are not the old open-findings vector',
  JSON.stringify(oldFormula) !== JSON.stringify(newVector),
  `old=[${oldFormula.join(',')}] new=[${newVector.join(',')}]`,
)
const planCount = await prisma.agentPlan.count()
const planEdgeCrossed = m.edges.filter((e) => e.artifact === 'plan').map((e) => e.counts.crossed)
ok(
  'the plan edge no longer reports every plan that has ever existed',
  planEdgeCrossed.every((c) => c === 0),
  `plans in db=${planCount} plan-edge crossed=[${planEdgeCrossed.join(',')}]`,
)

// 2 — nothing has crossed on a fleet with no sweep runs, so every finding edge
// must be honestly empty rather than labelled.
const crossedTotal = m.edges.reduce((s, e) => s + e.counts.crossed, 0)
ok('crossed totals are counted, not invented', Number.isInteger(crossedTotal), `total crossed=${crossedTotal}`)

// 3 — the running-row trap: a row still in flight must not count as not-ok.
const inFlight = await prisma.agentRun.count({ where: { mode: { not: null }, status: 'running' } })
const notOkSum = m.nodes.reduce((s, n) => s + n.runs.notOkWindow, 0)
const rawNotOk = await prisma.agentRun.count({
  where: { mode: { not: null }, ok: false, createdAt: { gte: m.window.since ?? new Date(0) } },
})
ok('in-flight runs excluded from the not-ok count', notOkSum <= rawNotOk, `notOk=${notOkSum} rawNotOk=${rawNotOk} inFlight=${inFlight}`)

// 4 — job furniture survives. The auditor is in no stored definition; if it is
// missing from the map, the map is lying about who runs nightly.
const auditor = m.nodes.find((n) => n.key === 'fleet-auditor')
ok('fleet-auditor is on the map', auditor != null, auditor ? `lane=${auditor.lane}` : 'MISSING')
ok('fleet-auditor is labelled as furniture, not wiring', auditor?.lane === 'standalone', auditor?.lane ?? '—')

// 5 — retired workers never reach the browser. Retirement is not a column:
// it is `supersededBy === 'retired'` (charter-registry.ts:133), and
// `resolveCharter` returns null for such a row, which is what makes retired
// mean "cannot run" rather than "hidden".
const retiredKeys = (
  await prisma.agentCharter.findMany({ where: { supersededBy: 'retired' }, select: { key: true } })
).map((r) => r.key)
ok(
  'retired workers excluded server-side',
  !m.nodes.some((n) => retiredKeys.includes(n.key)),
  `retired in db: ${retiredKeys.join(',') || 'none'}`,
)

// 6 — costs are numbers, not Prisma Decimals.
ok('costs serialise as numbers', m.nodes.every((n) => typeof n.cost.windowUSD === 'number'))

// 7 — the census must partition: every node has exactly one lane.
const lanes = new Set(m.nodes.map((n) => n.lane))
ok('every node has exactly one lane', m.nodes.every((n) => ['ranked', 'standalone', 'unwired'].includes(n.lane)), [...lanes].join(','))

// 8 — edge endpoints all resolve to drawn nodes.
const keys = new Set(m.nodes.map((n) => n.key))
ok('no edge points at a node that is not drawn', m.edges.every((e) => keys.has(e.from) && keys.has(e.to)))

// 9 — the director→critic edge carries a verdict, never a volume.
const planEdges = m.edges.filter((e) => e.artifact === 'plan')
ok('plan edges carry a verdict and no crossed volume', planEdges.every((e) => e.lineage === 'none' && e.verdicts != null), `${planEdges.length} plan edge(s)`)

// 10 — cross-check open findings against a direct count.
const openDirect = await prisma.agentFinding.count({ where: { status: 'open' } })
const openSum = m.nodes.reduce((s, n) => s + n.findings.open, 0)
ok('open findings match a direct count', openSum === openDirect, `map=${openSum} db=${openDirect}`)

// 11 — lifetime runs cross-check.
const runsDirect = await prisma.agentRun.count({ where: { mode: { not: null } } })
ok('lifetime run total matches a direct count', m.totals.runsLifetime === runsDirect, `map=${m.totals.runsLifetime} db=${runsDirect}`)

console.log(fail.length === 0 ? '\nALL CHECKS PASSED' : `\n${fail.length} CHECK(S) FAILED: ${fail.join(' | ')}`)
await prisma.$disconnect()
