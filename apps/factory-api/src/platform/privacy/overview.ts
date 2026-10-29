import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { NOTICE_KINDS, type NoticeKind } from '@nexus/factory-domain/privacy/notices'
import { PRIVACY_VIEW } from '@nexus/factory-domain/privacy/permissions'
import type { CommandCaller } from '../../core/command'
import { actorOf } from '../../core/context'
import { dayOf, officeOf } from './access'
import { floorReadinessFor, noticeInForce } from './read'

/**
 * "Your privacy duties" (A2 SCR-086 `duties`; B-W1-36; GDPR arts. 13, 28, 30, 35; L. 300/1970 art. 4): per company the
 * caller's privacy.view reaches, what the law asks and its real state, read from the records (never a tick box), and per
 * site whether real floor work may start (the privacy gate and the floor rules, in words). privacy.view.
 */

const DUTY_WORDS = {
  register: (done: boolean, count: number) =>
    done ? `${count} processing ${count === 1 ? 'activity is' : 'activities are'} in the record (GDPR art. 30), with the processors (art. 28).` : 'The record of processing activities is empty (GDPR art. 30): add what the company processes, and its processors (art. 28).',
  publicNotice: (label: string | null) => (label ? `Public privacy notice ${label} is published at /privacy/<company> (GDPR arts. 13, 14).` : 'No public privacy notice is published (GDPR arts. 13, 14): link pages and e-mails point to an empty page.'),
  staffNotice: (label: string | null) => (label ? `Staff notice ${label} is in force: each office person sees it once at sign-in.` : 'No staff notice is published (GDPR art. 13): office staff are not told what the system keeps about them.'),
  workerNotice: (label: string | null) =>
    label ? `Worker notice ${label} is in force: each worker acknowledges it on the tablet before their first scan.` : 'No worker notice is published (L. 300/1970 art. 4 c.3; GDPR art. 13): floor work that records workers stays off.',
  dpia: (version: number | null) => (version ? `DPIA version ${version} is stored (GDPR art. 35).` : 'No signed DPIA is stored (GDPR art. 35): badge sign-ins and scans that record workers stay off.'),
} as const

export async function privacyOverview(caller: CommandCaller, query: { companyId?: string | undefined }, now: Date) {
  const context = officeOf(caller)
  const where: Prisma.CompanyWhereInput = { AND: [scopeWhere(actorOf(context), PRIVACY_VIEW, { company: 'id' }) as Prisma.CompanyWhereInput, query.companyId ? { id: query.companyId } : {}] }
  return caller.withClient(async (client) => {
    const companies = await client.company.findMany({ where, select: { id: true, code: true, legalName: true, tradeName: true }, orderBy: [{ code: 'asc' }] })
    const answer = []
    for (const company of companies) {
      const notices = {} as Record<NoticeKind, { id: string; label: string; publishedAt: string | null } | null>
      for (const kind of NOTICE_KINDS) {
        const inForce = await noticeInForce(client, company.id, kind)
        notices[kind] = inForce ? { id: inForce.id, label: inForce.label, publishedAt: inForce.publishedAt ? toUtcIso(inForce.publishedAt) : null } : null
      }
      const dpia = await client.privacyDpia.findFirst({ where: { companyId: company.id, status: 'STORED' }, select: { id: true, versionNo: true, signedOn: true, reviewDueOn: true } })
      const activities = await client.processingActivity.count({ where: { companyId: company.id, status: 'ACTIVE' } })
      const sites = await client.site.findMany({
        where: { AND: [{ companyId: company.id }, scopeWhere(actorOf(context), PRIVACY_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput] },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      })
      const siteViews = []
      for (const site of sites) {
        const readiness = (await floorReadinessFor(client, site.id, now))!
        siteViews.push({ ...site, readyForFloor: readiness.readyForFloor, notes: readiness.notes })
      }
      answer.push({
        company: { id: company.id, code: company.code, name: company.tradeName ?? company.legalName },
        duties: [
          { key: 'register' as const, done: activities > 0, words: DUTY_WORDS.register(activities > 0, activities) },
          { key: 'publicNotice' as const, done: notices.PRIVACY_PUBLIC !== null, words: DUTY_WORDS.publicNotice(notices.PRIVACY_PUBLIC?.label ?? null) },
          { key: 'staffNotice' as const, done: notices.OFFICE_STAFF !== null, words: DUTY_WORDS.staffNotice(notices.OFFICE_STAFF?.label ?? null) },
          { key: 'workerNotice' as const, done: notices.WORKER_FLOOR !== null, words: DUTY_WORDS.workerNotice(notices.WORKER_FLOOR?.label ?? null) },
          { key: 'dpia' as const, done: dpia !== null, words: DUTY_WORDS.dpia(dpia?.versionNo ?? null) },
        ],
        notices,
        dpia: dpia ? { id: dpia.id, versionNo: dpia.versionNo, signedOn: dayOf(dpia.signedOn), reviewDueOn: dayOf(dpia.reviewDueOn) } : null,
        activities,
        sites: siteViews,
      })
    }
    return { companies: answer }
  })
}
