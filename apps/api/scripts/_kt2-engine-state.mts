/**
 * _kt2-engine-state.mts — KT.2 stop conditions, measured (read-only).
 *
 * The brief states three conditions that must hold before KT.2 writes code. One of them looks
 * wrong from the source: it says the coverage engine is "scheduled nowhere", but
 * `startAllAdvertisingCrons()` calls `startCoverageEngineCron()` at ads-sync.job.ts:798 with a
 * default schedule of `10 7 * * *`. This measures what is actually true on prod:
 *
 *   1. who writes KeywordCoverageSet / KeywordCoverageTerm  (source-grepped: one service)
 *   2. is the engine scheduled AND running, what mode, and how many sets are armed
 *   3. does a watchlist-shaped model already exist
 *
 * `railway run` injects the production environment into this process, so `process.env` here is
 * what the API container sees.
 *
 * NO WRITES.
 * Run: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_kt2-engine-state.mts
 */
import '../src/env.js'
import prisma from '../src/db.js'

const line = (s = '') => console.log(s)
const h = (s: string) => { line(); line(`━━━ ${s} ${'━'.repeat(Math.max(0, 68 - s.length))}`) }
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString().slice(0, 16) : 'null')

async function main() {
  h('1 · the engine gate, from the production environment')
  for (const k of [
    'NEXUS_COVERAGE_ENGINE_MODE', 'NEXUS_COVERAGE_ENGINE_SCHEDULE',
    'NEXUS_ENABLE_AMAZON_ADS_CRON', 'NEXUS_AMAZON_ADS_MODE',
    'NEXUS_COVERAGE_STEP_UP_PCT', 'NEXUS_COVERAGE_DECAY_PCT', 'NEXUS_COVERAGE_DEFAULT_MAX_CPC_CENTS',
  ]) {
    const v = process.env[k]
    line(`${k.padEnd(38)} = ${v === undefined ? '(unset)' : JSON.stringify(v)}`)
  }
  const raw = (process.env.NEXUS_COVERAGE_ENGINE_MODE ?? 'observe').toLowerCase()
  const mode = raw === 'auto' ? 'auto' : raw === 'off' ? 'off' : 'observe'
  line(`⇒ engineMode() resolves to: ${mode.toUpperCase()}${mode === 'auto' ? '   🔴 THIS WRITES BIDS TO AMAZON' : ''}`)

  h('2 · has the scheduled engine actually RUN on prod?')
  const runs = await prisma.cronRun.findMany({
    where: { jobName: 'ads-coverage-engine' }, orderBy: { startedAt: 'desc' }, take: 10,
    select: { startedAt: true, finishedAt: true, status: true, errorMessage: true, outputSummary: true },
  })
  const total = await prisma.cronRun.count({ where: { jobName: 'ads-coverage-engine' } })
  line(`CronRun rows named 'ads-coverage-engine': ${total}`)
  if (!total) line('   → the cron is registered in code but has never recorded a run')
  for (const r of runs) {
    line(`   ${iso(r.startedAt)}  ${String(r.status).padEnd(8)} ${r.outputSummary ?? ""}${r.errorMessage ? ` ERR="${r.errorMessage.slice(0, 40)}"` : ""}`)
  }

  h('3 · what the engine would find: armed sets')
  const sets = await prisma.keywordCoverageSet.findMany({
    select: {
      id: true, name: true, marketplace: true, portfolioId: true, enabled: true,
      dailySpendCapCents: true, acosCapPct: true, createdAt: true, updatedAt: true,
      _count: { select: { terms: true } },
    },
  })
  line(`KeywordCoverageSet rows: ${sets.length}`)
  for (const s of sets) {
    line(`   "${s.name}" mkt=${s.marketplace} portfolio=${s.portfolioId} enabled=${s.enabled} terms=${s._count.terms} cap=${s.dailySpendCapCents ?? 'null'} acosCap=${s.acosCapPct ?? 'null'} updated=${iso(s.updatedAt)}`)
  }
  const armed = sets.filter((s) => s.enabled).length
  line(`⇒ sets the engine would act on right now: ${armed}`)
  const withLead = await prisma.keywordCoverageTerm.count({ where: { leadAsin: { not: null } } })
  const withTarget = await prisma.keywordCoverageTerm.count({ where: { targetSharePct: { not: null } } })
  const controls = await prisma.keywordCoverageTerm.count({ where: { isControl: true } })
  const statuses = await prisma.keywordCoverageTerm.groupBy({ by: ['status'], _count: { _all: true } })
  line(`terms: ${statuses.map((s) => `${s.status}=${s._count._all}`).join(' · ')} · leadAsin set on ${withLead} · targetSharePct on ${withTarget} · isControl ${controls}`)

  h('4 · has the engine ever logged a decision? (observe mode logs would-do)')
  // The engine writes actionType 'coverage_engine_observe' / '_apply' (service :309). There is no
  // `actor` column on this model — that first guess THREW, which is the point of never wrapping a
  // probe query in `.catch(() => [])`: a wrong field name would have printed "0 decisions logged".
  const actors = await prisma.advertisingActionLog.groupBy({
    by: ['actionType'], where: { actionType: { contains: 'coverage' } }, _count: { _all: true },
  })
  if (!actors.length) line('no AdvertisingActionLog rows with a coverage actionType — the engine has never logged a decision')
  for (const a of actors) line(`   actionType="${a.actionType}" rows=${a._count._all}`)

  h('5 · stop condition 3 — is there already a watchlist-shaped table?')
  // Ask the database itself rather than the schema file: a model could exist under any name.
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `select table_name::text as table_name from information_schema.tables
     where table_schema = 'public'
       and (table_name ilike '%watchlist%' or table_name ilike '%watch%'
            or table_name ilike '%trackedkeyword%' or table_name ilike '%keywordlist%')
     order by table_name`,
  )
  line(tables.length ? tables.map((t) => `   ${t.table_name}`).join('\n') : '   none')
  const kwTables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `select table_name::text as table_name from information_schema.tables
     where table_schema = 'public' and table_name ilike '%keyword%' order by table_name`,
  )
  line('every table with "keyword" in its name:')
  line(kwTables.map((t) => `   ${t.table_name}`).join('\n'))

  h('6 · defect 1 — the one Italian list served to four markets')
  const terms = await prisma.keywordCoverageTerm.findMany({ where: { setId: sets[0]?.id }, select: { term: true } })
  line(`the fallback list is "${sets[0]?.name}" (${sets[0]?.marketplace}, ${terms.length} terms) — served to IT, DE, ES and FR`)
  // How many of those Italian terms does each market's own feed even know?
  for (const m of ['IT', 'DE', 'ES', 'FR']) {
    const present = await prisma.searchQueryPerformance.groupBy({
      by: ['searchQuery'], where: { marketplace: m, searchQuery: { in: terms.map((t) => t.term.toLowerCase()) } }, _count: { _all: true },
    })
    line(`   ${m}: ${present.length} of the ${terms.length} Italian terms have EVER had a row in this market`)
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
