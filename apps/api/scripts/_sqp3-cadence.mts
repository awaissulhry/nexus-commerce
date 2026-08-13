/** _sqp3-cadence.mts — SQP.3: the prompt says sqp-collect runs 1.1x/day. Count it. READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
async function main() {
  for (const [label, ms] of [['24h', 86_400_000], ['7d', 7 * 86_400_000]] as Array<[string, number]>) {
    const n = await prisma.cronRun.count({ where: { jobName: 'sqp-collect', startedAt: { gte: new Date(Date.now() - ms) } } })
    const days = ms / 86_400_000
    console.log(`sqp-collect runs in ${label}: ${n} (${(n / days).toFixed(1)}/day)`)
  }
  const first = await prisma.cronRun.findFirst({ where: { jobName: 'sqp-collect' }, orderBy: { startedAt: 'asc' }, select: { startedAt: true } })
  console.log(`first ever sqp-collect run: ${first?.startedAt.toISOString()}`)
  const ageH = first ? (Date.now() - +first.startedAt) / 3_600_000 : 0
  const total = await prisma.cronRun.count({ where: { jobName: 'sqp-collect' } })
  console.log(`total runs: ${total} over ${ageH.toFixed(1)}h alive = ${(total / (ageH / 24)).toFixed(1)}/day since deploy`)
  console.log(`⇒ the "1.1/day" figure is what you get from ${total} runs / ${(ageH / 24).toFixed(1)} days ONLY if you divide by days since the job existed rather than counting the last 24h`)
  // the createReport rate: the request pass took 2629s for 40 creates
  const ing = await prisma.cronRun.findFirst({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, finishedAt: true, outputSummary: true } })
  if (ing?.finishedAt) {
    const secs = (+ing.finishedAt - +ing.startedAt) / 1000
    console.log(`\nlast request pass: ${secs.toFixed(0)}s for 40 createReport calls = ${(secs / 40).toFixed(1)}s each`)
    console.log(`⇒ createReport is rate-limited (~1/min documented). THAT bounds the request pass, not the generation queue.`)
  }
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0,200)); await prisma.$disconnect(); process.exit(1) })
