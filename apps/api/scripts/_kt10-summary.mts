import '../src/env.js'
import prisma from '../src/db.js'
const r = await prisma.cronRun.findFirst({ where: { jobName: 'sqp-ingest' }, orderBy: { startedAt: 'desc' }, select: { outputSummary: true } })
console.log('FULL SUMMARY:\n' + (r?.outputSummary ?? '—').split(' · ').join('\n  · '))
await prisma.$disconnect()
