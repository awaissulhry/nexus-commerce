import type { Prisma } from '@nexus/factory-db'
import { businessDate } from '@nexus/factory-domain/core/time'
import { pickLanguage, type NoticeKind } from '@nexus/factory-domain/privacy/notices'
import { floorPrivacyStatus, floorReadiness, type FloorPrivacyStatus, type FloorReadiness } from '@nexus/factory-domain/privacy/readiness'
import { floorRulesStatus, scanSubjectOf, type ScanSubject } from '@nexus/factory-domain/production/settings/monitoring'
import type { CommandTx } from '../../core/command'

/**
 * The privacy pack's reads that other parts of the API ask (B-W1-36): the notice in force, whether a worker acknowledged
 * it, the floor's gate. Each takes the client it is given (a command's transaction, or a scoped client) and reads only
 * what that scope may read: the floor scope reads notices, texts, its own site, its workers' acknowledgements and the
 * site's scan subject; the DPIA and the legal basis need the office scope (or the tenant's system caller).
 *
 *   workerNoticeRule(db, siteId)              the site's company and its worker notice in force
 *   acknowledgedInForce(db, siteId, workerId) the database's rule for naming a worker on a floor record (…_privacy_guards):
 *                                             an acknowledgement of the version in force; none counts while the
 *                                             site's company has no worker notice in force
 *   workerNoticeGate(db, siteId, workerId)    what the tablet does at sign-in: show the notice (due), hold the scan tiles
 *   floorPrivacyReady(db, companyId, now)     a stored DPIA and a published worker notice (office scope)
 *   floorReadinessFor(db, siteId, now)        that and the site's floor rules (B-W1-37) in one answer (office scope)
 */

type NoticeReader = Pick<CommandTx, 'privacyNotice' | 'site'>
type AckReader = NoticeReader & Pick<CommandTx, 'workerNoticeAck'>

export interface InForce {
  readonly id: string
  readonly label: string
  readonly versionNo: number
  readonly publishedAt: Date | null
}

const IN_FORCE_SELECT = { id: true, label: true, versionNo: true, publishedAt: true } as const

/** The company's version in force of a kind of notice, or null. Reads no hidden column (the floor may call it). */
export async function noticeInForce(db: Pick<CommandTx, 'privacyNotice'>, companyId: string, kind: NoticeKind): Promise<InForce | null> {
  return db.privacyNotice.findFirst({ where: { companyId, kind, status: 'PUBLISHED' }, select: IN_FORCE_SELECT })
}

export interface WorkerNoticeRule {
  readonly companyId: string | null
  readonly inForce: InForce | null
}

export async function workerNoticeRule(db: NoticeReader, siteId: string): Promise<WorkerNoticeRule> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { companyId: true } })
  if (!site) return { companyId: null, inForce: null }
  return { companyId: site.companyId, inForce: await noticeInForce(db, site.companyId, 'WORKER_FLOOR') }
}

/** The acknowledgements that count under the rule: those of the version in force (null: none can, none is in force). */
export function countingAcks(rule: WorkerNoticeRule): Prisma.WorkerNoticeAckWhereInput | null {
  return rule.inForce ? { noticeId: rule.inForce.id } : null
}

/** The worker acknowledged the notice that counts at the site now (the database's rule for naming them). */
export async function acknowledgedInForce(db: AckReader, siteId: string, workerId: string): Promise<boolean> {
  const where = countingAcks(await workerNoticeRule(db, siteId))
  if (where === null) return false
  return (await db.workerNoticeAck.findFirst({ where: { ...where, siteId, workerId }, select: { id: true } })) !== null
}

/** What the floor does with a worker at sign-in (design floor.notice): show the notice, hold the scan tiles. */
export interface WorkerNoticeGate {
  /** The worker notice in force at the site's company, or null. */
  readonly noticeId: string | null
  readonly label: string | null
  /** The worker acknowledged the notice that counts (the version in force). */
  readonly acknowledged: boolean
  /** A version is in force and the worker has not acknowledged it: the tablet opens it after sign-in. */
  readonly due: boolean
  /** The site names workers and the worker may not be named yet: every scan-taking tile is held ("Read the notice first"). */
  readonly blocksScans: boolean
}

export async function workerNoticeGate(db: AckReader & Pick<CommandTx, 'productionSettings'>, siteId: string, workerId: string): Promise<WorkerNoticeGate> {
  const rule = await workerNoticeRule(db, siteId)
  const where = countingAcks(rule)
  const acknowledged = where !== null && (await db.workerNoticeAck.findFirst({ where: { ...where, siteId, workerId }, select: { id: true } })) !== null
  const subject = scanSubjectOf((await db.productionSettings.findUnique({ where: { id: siteId }, select: { scanSubject: true } })) as { scanSubject: ScanSubject } | null)
  return {
    noticeId: rule.inForce?.id ?? null,
    label: rule.inForce?.label ?? null,
    acknowledged,
    due: rule.inForce !== null && !acknowledged,
    blocksScans: subject === 'WORKER' && !acknowledged,
  }
}

/** A notice version's text for a reader: their language, else Italian, else English. */
export async function noticeTextFor(db: Pick<CommandTx, 'privacyNoticeText'>, noticeId: string, wanted: string | null | undefined) {
  const texts = await db.privacyNoticeText.findMany({ where: { noticeId, body: { not: null } }, select: { locale: true, body: true, sha256: true }, orderBy: { locale: 'asc' } })
  const languages = texts.map((text) => text.locale)
  const locale = pickLanguage(languages, wanted)
  const text = texts.find((entry) => entry.locale === locale) ?? null
  return { languages, text: text ? { locale: text.locale, body: text.body as string, sha256: text.sha256 } : null, languageReady: wanted ? languages.includes(wanted) : true }
}

/** The privacy gate of a company's floor: a stored DPIA and a published worker notice (office scope or system caller). */
export async function floorPrivacyReady(db: Pick<CommandTx, 'privacyDpia' | 'privacyNotice'>, companyId: string, now: Date): Promise<FloorPrivacyStatus> {
  const dpia = await db.privacyDpia.findFirst({ where: { companyId, status: 'STORED' }, select: { versionNo: true, reviewDueOn: true } })
  const workerNotice = await noticeInForce(db, companyId, 'WORKER_FLOOR')
  return floorPrivacyStatus({
    dpia: dpia ? { versionNo: dpia.versionNo, reviewDueOn: dpia.reviewDueOn ? dpia.reviewDueOn.toISOString().slice(0, 10) : null } : null,
    workerNotice: workerNotice ? { label: workerNotice.label } : null,
    today: businessDate(now),
  })
}

/**
 * One site's answer to "may real floor work start?": the company's privacy gate and the site's floor rules (B-W1-37:
 * naming workers needs a legal basis on record), in plain words. Office scope or the tenant's system caller: the floor
 * may read neither the DPIA nor the legal basis. Null: no such site in scope.
 */
export async function floorReadinessFor(db: Pick<CommandTx, 'privacyDpia' | 'privacyNotice' | 'site' | 'productionSettings'>, siteId: string, now: Date): Promise<FloorReadiness | null> {
  const site = await db.site.findUnique({ where: { id: siteId }, select: { companyId: true } })
  if (!site) return null
  const rules = await db.productionSettings.findUnique({ where: { id: siteId }, select: { scanSubject: true, monitoringBasis: true } })
  const privacy = await floorPrivacyReady(db, site.companyId, now)
  return floorReadiness(privacy, floorRulesStatus({ scanSubject: scanSubjectOf(rules as { scanSubject: ScanSubject } | null), basisOnRecord: (rules?.monitoringBasis ?? null) !== null }))
}

/** The office person's state against their company's staff notice in force (shown once per version at sign-in). */
export interface StaffNoticeState {
  readonly noticeId: string
  readonly label: string
  readonly acknowledged: boolean
}

export async function staffNoticeState(db: Pick<CommandTx, 'privacyNotice' | 'staffNoticeAck'>, companyId: string | null | undefined, userId: string): Promise<StaffNoticeState | null> {
  if (!companyId) return null
  const inForce = await noticeInForce(db, companyId, 'OFFICE_STAFF')
  if (!inForce) return null
  const ack = await db.staffNoticeAck.findFirst({ where: { companyId, noticeId: inForce.id, userId }, select: { id: true } })
  return { noticeId: inForce.id, label: inForce.label, acknowledged: ack !== null }
}
