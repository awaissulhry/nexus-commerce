import type { Prisma } from '@nexus/factory-db'
import { companyWhere, earlier, holdAll, HOUR, type RetentionType } from './type'

/**
 * The platform's record types a retention rule may name (B-W2b-405; PLT-204). The database's own windows stay the floor: a job
 * run is deleted no sooner than 7 days after it finished, a closed error item no sooner than 30 days after it closed.
 * Operational logs are deleted without an ErasureRecord each (the sweep's counts are their record; an erasure record per job
 * run would grow forever in an append-only table).
 */

/** A person's report runs ("last run by me"): deleted once old. */
const reportRuns: RetentionType = {
  recordType: 'ReportRun',
  companyScoped: false,
  actions: ['DELETE'],
  countsFrom: 'the time the report was run',
  does: { DELETE: 'Deletes the run (who ran which report with which filters); the reports themselves stay.' },
  holdsAll: null,
  async due(db, _scope, cut, _now, take) {
    const where: Prisma.ReportRunWhereInput = { at: { lt: cut.instant } }
    const [total, rows] = await Promise.all([db.reportRun.count({ where }), db.reportRun.findMany({ where, select: { id: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  async apply(tx, action, ids) {
    if (action !== 'DELETE' || ids.length === 0) return { applied: 0, held: null }
    const { count } = await tx.reportRun.deleteMany({ where: { id: { in: [...ids] } } })
    return { applied: count, held: null }
  },
}

/** The scheduled jobs' runs (B-W2b-415 writes them): deleted once old, never sooner than 7 days after they finished. */
const cronRuns: RetentionType = {
  recordType: 'CronRun',
  companyScoped: false,
  actions: ['DELETE'],
  countsFrom: 'the time the run finished (a running one is never due)',
  does: { DELETE: 'Deletes the finished run (job, time, result, error); never one still running, never within 7 days of its end.' },
  holdsAll: null,
  async due(db, _scope, cut, now, take) {
    const where: Prisma.CronRunWhereInput = { status: { in: ['SUCCEEDED', 'FAILED'] }, finishedAt: { lt: earlier(cut.instant, new Date(now.getTime() - 168 * HOUR)) } }
    const [total, rows] = await Promise.all([db.cronRun.count({ where }), db.cronRun.findMany({ where, select: { id: true }, orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  async apply(tx, action, ids) {
    if (action !== 'DELETE' || ids.length === 0) return { applied: 0, held: null }
    const { count } = await tx.cronRun.deleteMany({ where: { id: { in: [...ids] } } })
    return { applied: count, held: null }
  },
}

/** The error queue's closed items (dismissed or retried): deleted once old, never sooner than 30 days after they closed. */
const errorItems: RetentionType = {
  recordType: 'IntegrationErrorItem',
  companyScoped: true,
  actions: ['DELETE'],
  countsFrom: 'the time the item was dismissed or retried (an open item is never due)',
  does: { DELETE: 'Deletes the closed item (the failed message, its reason and tries); never an open one, never within 30 days of its close.' },
  holdsAll: null,
  async due(db, scope, cut, now, take) {
    const until = earlier(cut.instant, new Date(now.getTime() - 720 * HOUR))
    const where: Prisma.IntegrationErrorItemWhereInput = {
      AND: [companyWhere(scope) as Prisma.IntegrationErrorItemWhereInput, { OR: [{ state: 'DISMISSED', dismissedAt: { lt: until } }, { state: 'RETRIED', retriedAt: { lt: until } }] }],
    }
    const [total, rows] = await Promise.all([db.integrationErrorItem.count({ where }), db.integrationErrorItem.findMany({ where, select: { id: true }, orderBy: [{ lastFailedAt: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  async apply(tx, action, ids) {
    if (action !== 'DELETE' || ids.length === 0) return { applied: 0, held: null }
    const { count } = await tx.integrationErrorItem.deleteMany({ where: { id: { in: [...ids] } } })
    return { applied: count, held: null }
  },
}

/** Mail received: the database keeps a read mail as it came, so anonymising it is held until a guarded erasure path exists. */
const inboundMail: RetentionType = {
  recordType: 'InboundEmail',
  companyScoped: true,
  actions: ['ANONYMISE'],
  countsFrom: 'the time the mail was received',
  does: { ANONYMISE: "Would blank the sender's address and name, the subject and the text, keeping the mail's thread and status: held today (the database keeps a read mail unchanged)." },
  holdsAll: 'IMMUTABLE',
  async due(db, scope, cut, _now, take) {
    const where: Prisma.InboundEmailWhereInput = { AND: [companyWhere(scope) as Prisma.InboundEmailWhereInput, { receivedAt: { lt: cut.instant } }] }
    const [total, rows] = await Promise.all([db.inboundEmail.count({ where }), db.inboundEmail.findMany({ where, select: { id: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  apply: holdAll('IMMUTABLE'),
}

/** Exports: the database never deletes one (it expires; its file goes with exports.expire): a rule only reports them. */
const exportJobs: RetentionType = {
  recordType: 'ExportJob',
  companyScoped: true,
  actions: [],
  countsFrom: 'the time the export was asked',
  does: {},
  holdsAll: 'NEVER_DELETED',
  async due(db, scope, cut, _now, take) {
    const where: Prisma.ExportJobWhereInput = { AND: [companyWhere(scope) as Prisma.ExportJobWhereInput, { createdAt: { lt: cut.instant } }] }
    const [total, rows] = await Promise.all([db.exportJob.count({ where }), db.exportJob.findMany({ where, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  apply: holdAll('NEVER_DELETED'),
}

export const PLATFORM_TYPES: readonly RetentionType[] = [reportRuns, cronRuns, errorItems, inboundMail, exportJobs]
