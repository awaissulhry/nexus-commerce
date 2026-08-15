/**
 * AUTO.P0 step 1 — the evidence for re-sizing `maxExecutionsPerDay`. READ-ONLY.
 *
 * The cap has not tripped for any rule since 2026-08-04 (P0.1). Repairing the counter without
 * first re-sizing the caps would take every rule from unbounded to abruptly bounded at a number
 * nobody chose — a rule capped at 1/day that has been running 765 times would drop to 1
 * overnight. So this measures, per rule:
 *
 *   · the declared cap
 *   · executions per UTC day over the last 8 FULL days — max, median, and today so far
 *   · the SUCCESS / DRY_RUN / FAILED / PARTIAL split
 *   · DISTINCT ENTITIES touched per day — the natural size of the rule's legitimate work,
 *     and therefore the number a cap should be sized against
 *   · ticks per day (distinct evaluation minutes) — the cadence the cap has to survive
 *
 * `startedAt` is `timestamp without time zone` holding UTC (measured, _auto-p0-shape.mts), and
 * the service's counter is UTC-day-based (`setUTCHours(0,0,0,0)`). Everything here is therefore
 * `date_trunc('day', "startedAt")` with NO timezone conversion — same day boundary as the
 * service, no AT TIME ZONE double-cast needed.
 *
 * 🔴 Every execution filter spells out the null branch:
 *      OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }]
 *    `NOT (errorMessage = 'X')` is NULL — not TRUE — for the null errorMessage every SUCCESS and
 *    DRY_RUN row carries, and Postgres drops NULL from a WHERE. That is the defect under repair;
 *    it has produced a confident zero four times in this programme, including in a study script.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const DAYS = 9 // 8 full days + today

// The entity key per grain, measured from real rows in _auto-p0-shape.mts:
//   campaign-grain triggers → triggerData.campaign.id
//   target-grain   triggers → triggerData.adTarget.id
//   search-term    triggers → triggerData.searchTerm.{query|searchTerm}
//   SCHEDULE       triggers → account-level; one context per MARKETPLACE per tick
const ENTITY_KEY = `COALESCE(
  "triggerData"->'campaign'->>'id',
  "triggerData"->'adTarget'->>'id',
  "triggerData"->'adGroup'->>'id',
  "triggerData"->'searchTerm'->>'query',
  "triggerData"->'searchTerm'->>'searchTerm',
  'mkt:' || COALESCE("triggerData"->>'marketplace', '?')
)`

type Row = {
  ruleId: string
  day: Date
  execs: bigint
  entities: bigint
  ticks: bigint
  markets: bigint
  ok: bigint
  dry: bigint
  failed: bigint
  partial: bigint
  capRows: bigint
}

// ONE query. The null branch is spelled out in the CASE arms rather than a WHERE, so the
// cap rows are counted separately instead of silently vanishing.
const rows = await prisma.$queryRawUnsafe<Row[]>(`
  SELECT
    e."ruleId"                                              AS "ruleId",
    date_trunc('day', e."startedAt")                        AS "day",
    COUNT(*) FILTER (WHERE e."errorMessage" IS NULL
                        OR e."errorMessage" <> 'DAILY_CAP_EXCEEDED')          AS "execs",
    COUNT(DISTINCT ${ENTITY_KEY}) FILTER (WHERE e."errorMessage" IS NULL
                        OR e."errorMessage" <> 'DAILY_CAP_EXCEEDED')          AS "entities",
    COUNT(DISTINCT date_trunc('minute', e."startedAt"))                        AS "ticks",
    COUNT(DISTINCT e."triggerData"->>'marketplace')                            AS "markets",
    COUNT(*) FILTER (WHERE e."status" = 'SUCCESS')                             AS "ok",
    COUNT(*) FILTER (WHERE e."status" = 'DRY_RUN')                             AS "dry",
    COUNT(*) FILTER (WHERE e."status" = 'FAILED'
                       AND (e."errorMessage" IS NULL
                        OR e."errorMessage" <> 'DAILY_CAP_EXCEEDED'))          AS "failed",
    COUNT(*) FILTER (WHERE e."status" = 'PARTIAL')                             AS "partial",
    COUNT(*) FILTER (WHERE e."errorMessage" = 'DAILY_CAP_EXCEEDED')            AS "capRows"
  FROM "AutomationRuleExecution" e
  WHERE e."startedAt" >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '${DAYS} days'
  GROUP BY 1, 2
  ORDER BY 1, 2
`)

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, actions: true,
  },
})
const byId = new Map(rules.map(r => [r.id, r]))

const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

const today = new Date(); today.setUTCHours(0, 0, 0, 0)
const isFullDay = (d: Date) => d.getTime() < today.getTime()

const grouped = new Map<string, Row[]>()
for (const r of rows) {
  if (!grouped.has(r.ruleId)) grouped.set(r.ruleId, [])
  grouped.get(r.ruleId)!.push(r)
}

const med = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const n = (x: number, w: number) => String(x).padStart(w)

console.log(`\n═══ Executions per rule per UTC day — last ${DAYS - 1} full days + today ═══`)
console.log('   (execs = the null branch spelled out. entities = DISTINCT entity contexts that day.)\n')
console.log(
  `${pad('rule', 40)} ${pad('trigger', 26)} ${pad('lvl', 8)} ${'cap'.padStart(5)}`
  + ` ${'max/d'.padStart(6)} ${'med/d'.padStart(6)} ${'ent max'.padStart(7)} ${'ticks'.padStart(5)}`
  + ` ${'mkts'.padStart(4)}  status split (8 full days)`,
)
console.log('─'.repeat(160))

type Out = {
  name: string; trigger: string; level: string; enabled: boolean; cap: number | null
  maxDay: number; medDay: number; entMax: number; entMed: number; ticks: number; markets: number
  ok: number; dry: number; failed: number; partial: number; capRows: number; todayExecs: number
  perTick: number
}
const out: Out[] = []

for (const [ruleId, rs] of grouped) {
  const r = byId.get(ruleId)
  if (!r) continue // non-advertising rule
  const full = rs.filter(x => isFullDay(x.day))
  const todayRow = rs.find(x => !isFullDay(x.day))
  const execs = full.map(x => Number(x.execs))
  const ents = full.map(x => Number(x.entities))
  const level = resolveAutonomy(r as { enabled: boolean; dryRun: boolean; autonomyLevel?: string | null })
  const maxDay = execs.length ? Math.max(...execs) : 0
  const ticks = full.length ? Math.max(...full.map(x => Number(x.ticks))) : 0
  out.push({
    name: r.name, trigger: r.trigger, level, enabled: r.enabled, cap: r.maxExecutionsPerDay,
    maxDay, medDay: med(execs),
    entMax: ents.length ? Math.max(...ents) : 0, entMed: med(ents),
    ticks, markets: full.length ? Math.max(...full.map(x => Number(x.markets))) : 0,
    ok: full.reduce((a, x) => a + Number(x.ok), 0),
    dry: full.reduce((a, x) => a + Number(x.dry), 0),
    failed: full.reduce((a, x) => a + Number(x.failed), 0),
    partial: full.reduce((a, x) => a + Number(x.partial), 0),
    capRows: full.reduce((a, x) => a + Number(x.capRows), 0),
    todayExecs: todayRow ? Number(todayRow.execs) : 0,
    perTick: ticks ? Math.round((maxDay / ticks) * 10) / 10 : 0,
  })
}
out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.maxDay - a.maxDay)

for (const o of out) {
  const over = o.cap != null && o.maxDay > o.cap
  console.log(
    `${pad(o.name, 40)} ${pad(o.trigger, 26)} ${pad(o.enabled ? o.level : 'off', 8)} ${n(o.cap ?? -1, 5)}`
    + ` ${n(o.maxDay, 6)} ${n(o.medDay, 6)} ${n(o.entMax, 7)} ${n(o.ticks, 5)} ${n(o.markets, 4)}`
    + `  S${o.ok} D${o.dry} F${o.failed} P${o.partial}${o.capRows ? ` cap${o.capRows}` : ''}`
    + (over ? `  🔴 ${Math.round(o.maxDay / (o.cap || 1))}× its cap` : ''),
  )
}

console.log('\n═══ Per-tick fan-out — how many contexts one evaluation tick produces ═══')
console.log('   A cap must be at least (ticks/day × contexts/tick) for the rule to complete one pass.\n')
console.log(`${pad('rule', 40)} ${'cap'.padStart(5)} ${'ticks/d'.padStart(7)} ${'ctx/tick'.padStart(8)} ${'entities'.padStart(8)}  one full pass needs`)
for (const o of out.filter(x => x.enabled)) {
  console.log(
    `${pad(o.name, 40)} ${n(o.cap ?? -1, 5)} ${n(o.ticks, 7)} ${n(o.perTick, 8)} ${n(o.entMax, 8)}`
    + `  ${o.entMax} per tick × ${o.ticks} ticks = ${o.entMax * o.ticks}`,
  )
}

// ── the historical residue, by date, so the special-casing can be retired by date ──
const residue = await prisma.$queryRawUnsafe<Array<{ day: Date; c: bigint }>>(`
  SELECT date_trunc('day', "startedAt") AS day, COUNT(*) AS c
  FROM "AutomationRuleExecution"
  WHERE "errorMessage" = 'DAILY_CAP_EXCEEDED'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 8
`)
const totalResidue = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED' } })
console.log(`\n═══ DAILY_CAP_EXCEEDED residue — ${totalResidue} rows all-time; newest 8 days that have any ═══`)
for (const d of residue) console.log(`   ${d.day.toISOString().slice(0, 10)}  ${d.c}`)

await prisma.$disconnect()
