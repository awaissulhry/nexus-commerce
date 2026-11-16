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

/**
 * Mail received (B-W2b-GF1, F54: the Owner's decision of 15 Nov 2026 — the sweep may anonymise it): a settled mail (matched to a
 * record, rejected or failed: nothing waits on it) received before the cut-off is blanked — the sender's address and name, the
 * envelope sender, the subject, the text and the HTML — inside the sweep's own command: the database lets these six columns go
 * NULL only within an APPLY sweep of a switched-on InboundEmail ANONYMISE rule written in the same transaction
 * (…_privacy_partner_w2b_guards, factory_privacy_ops_mail_swept_ok). The mail row stays (where it went, when, SES's verdicts);
 * the sweep's counts are its record. A mail still waiting for a person (TRIAGE, HELD) or not read yet is never due.
 */
const SETTLED_MAIL = ['MATCHED', 'REJECTED', 'FAILED'] as const
const MAIL_COLUMNS = ['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml', 'envelopeFrom'] as const

const inboundMail: RetentionType = {
  recordType: 'InboundEmail',
  companyScoped: true,
  actions: ['ANONYMISE'],
  countsFrom: 'the time the mail was received',
  does: { ANONYMISE: "Blanks the sender's address and name, the envelope sender, the subject, the text and the HTML of a settled mail (matched, rejected or failed), keeping the mail's place, time and status; the record's thread keeps its own message as the correspondence of the record." },
  holdsAll: null,
  async due(db, scope, cut, _now, take) {
    const where: Prisma.InboundEmailWhereInput = {
      AND: [
        companyWhere(scope) as Prisma.InboundEmailWhereInput,
        { receivedAt: { lt: cut.instant }, status: { in: [...SETTLED_MAIL] } },
        { OR: MAIL_COLUMNS.map((column) => ({ [column]: { not: null } }) as Prisma.InboundEmailWhereInput) },
      ],
    }
    const [total, rows] = await Promise.all([db.inboundEmail.count({ where }), db.inboundEmail.findMany({ where, select: { id: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take })])
    return { total, ids: rows.map((row) => row.id) }
  },
  async apply(tx, action, ids) {
    if (action !== 'ANONYMISE' || ids.length === 0) return { applied: 0, held: null }
    // Only the six columns (no updatedAt, no version: the database compares everything else with what was there).
    const applied = await tx.$executeRaw`UPDATE "InboundEmail" SET "fromAddress" = NULL, "fromName" = NULL, "subject" = NULL, "bodyText" = NULL, "bodyHtml" = NULL, "envelopeFrom" = NULL
      WHERE id = ANY(${[...ids]}::uuid[]) AND status::text = ANY(${[...SETTLED_MAIL]}::text[])
        AND ("fromAddress" IS NOT NULL OR "fromName" IS NOT NULL OR "subject" IS NOT NULL OR "bodyText" IS NOT NULL OR "bodyHtml" IS NOT NULL OR "envelopeFrom" IS NOT NULL)`
    return { applied, held: null }
  },
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
