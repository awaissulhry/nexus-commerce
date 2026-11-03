import { can, holds, type ScopedRecord } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as rulesEvents } from '@nexus/factory-domain/quality-rules/events'
import { alertRuleSentence, firingTitle, RECORD_VIEW, testTitle, type AlertRecordType, type QualityAlertEvent } from '@nexus/factory-domain/quality/rules/alerts'
import { QUALITY_RULES_VIEW } from '@nexus/factory-domain/quality/rules/permissions'
import { liveAssignment } from '../../../platform/auth/roles/access'
import type { Draft, FanOutRule, RuleContext } from '../../../platform/notifications/fan-out'
import type { Db } from './store'

/**
 * The bell of a quality alert rule (B-W2b-118; QHS-154), one line in platform/notifications/rules/index.ts:
 *
 *   quality.alert_fired   ALERT to the rule's audience for the record: the record's owner (OWNER, OWNER_AND_ROLE) and the
 *                         live holders of the rule's office role over the record's company (ROLE, OWNER_AND_ROLE), each
 *                         only while ACTIVE, with Home (home.view) and the record's own view permission over it; a test,
 *                         the person who asked alone (with quality.rules.view). The sentence is notifications.alert.raised
 *                         ("Alert on {record}: {title}"), the title in the person's language (factory-domain firingTitle);
 *                         the record opens from the bell.
 * E-mail reaches a person only through their digest of the bell (off by default). Nothing reaches a customer or supplier.
 */

const payloadSchema = rulesEvents.find((event) => event.type === 'quality.alert_fired')!.payload

interface Fired {
  readonly ruleId: string
  readonly event: QualityAlertEvent
  readonly audience: 'OWNER' | 'ROLE' | 'OWNER_AND_ROLE'
  readonly recordType: string
  readonly recordId: string
  readonly label: string
  readonly companyId: string | null
  readonly siteId: string | null
  readonly step: number
  readonly date: string | null
  readonly testFor: string | null
}

/** The record's owner and scope, as the rule's audience and the reader's check need them (null: gone). */
async function factsOf(db: Db, recordType: AlertRecordType, recordId: string): Promise<{ ownerId: string | null; scope: ScopedRecord } | null> {
  switch (recordType) {
    case 'QualityHold': {
      const row = await db.qualityHold.findUnique({ where: { id: recordId }, select: { ownerId: true, companyId: true, siteId: true } })
      return row ? { ownerId: row.ownerId, scope: { companyId: row.companyId, siteId: row.siteId } } : null
    }
    case 'Nonconformance': {
      const row = await db.nonconformance.findUnique({ where: { id: recordId }, select: { ownerId: true, companyId: true, siteId: true } })
      return row ? { ownerId: row.ownerId, scope: { companyId: row.companyId, siteId: row.siteId } } : null
    }
    case 'Complaint': {
      const row = await db.complaint.findUnique({ where: { id: recordId }, select: { ownerId: true, companyId: true, partyId: true } })
      return row ? { ownerId: row.ownerId, scope: { companyId: row.companyId, partyId: row.partyId } } : null
    }
    case 'Inspection': {
      const row = await db.inspection.findUnique({ where: { id: recordId }, select: { status: true, assignedInspectorId: true, inspectorUserId: true, companyId: true, siteId: true } })
      // Waiting to be signed: the inspector it is assigned to; a release waiting: the inspector who signed it.
      return row ? { ownerId: row.status === 'OPEN' ? (row.assignedInspectorId ?? row.inspectorUserId) : row.inspectorUserId, scope: { companyId: row.companyId, siteId: row.siteId } } : null
    }
    case 'IncomingInspection': {
      const row = await db.incomingInspection.findUnique({ where: { id: recordId }, select: { inspectorUserId: true, companyId: true, siteId: true } })
      return row ? { ownerId: row.inspectorUserId, scope: { companyId: row.companyId, siteId: row.siteId } } : null
    }
    case 'Certificate': {
      const row = await db.certificate.findUnique({ where: { id: recordId }, select: { companyId: true } })
      return row ? { ownerId: null, scope: row.companyId ? { companyId: row.companyId } : {} } : null
    }
    case 'CapaAction':
      return null
  }
}

const isRecordType = (value: string): value is AlertRecordType => Object.hasOwn(RECORD_VIEW, value)

async function languageOf(db: Db, userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { locale: true } })
  return user?.locale === 'en' ? 'en' : 'it'
}

export const QUALITY_ALERT_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'quality.alertFired',
    events: ['quality.alert_fired'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const fired = payloadSchema.parse(raw) as unknown as Fired
      const db = context.tx
      const rule = await db.qualityAlertRule.findUnique({ where: { id: fired.ruleId }, select: { companyId: true, audience: true, roleId: true, withinMinutes: true, daysBefore: true, channels: true, event: true, role: { select: { name: true } } } })
      if (!rule) return []
      if (fired.testFor) {
        // A test: the person who asked, with their bell and the rules page; the rule itself opens from the bell.
        const reader = await context.reader(fired.testFor)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, QUALITY_RULES_VIEW, rule.companyId ? { companyId: rule.companyId } : {})) return []
        const language = await languageOf(db, fired.testFor)
        const sentence = alertRuleSentence({ event: rule.event, audience: rule.audience, withinMinutes: rule.withinMinutes, daysBefore: rule.daysBefore, channels: rule.channels }, rule.role?.name ?? null, language)
        return [{ userId: fired.testFor, category: 'ALERT', record: { type: 'QualityAlertRule', id: fired.ruleId, label: fired.label }, companyId: rule.companyId, anchor: null, messageKey: 'notifications.alert.raised', params: { title: testTitle(sentence, language) }, actorId: null }]
      }
      if (!isRecordType(fired.recordType)) return []
      const facts = await factsOf(db, fired.recordType, fired.recordId)
      if (!facts) return []
      const wanted = new Set<string>()
      if ((rule.audience === 'OWNER' || rule.audience === 'OWNER_AND_ROLE') && facts.ownerId) wanted.add(facts.ownerId)
      if ((rule.audience === 'ROLE' || rule.audience === 'OWNER_AND_ROLE') && rule.roleId) {
        const held = await db.roleAssignment.findMany({ where: { roleId: rule.roleId, ...liveAssignment(context.now) }, select: { userId: true, allCompanies: true, companyIds: true }, orderBy: [{ userId: 'asc' }], take: 500 })
        for (const assignment of held) if (fired.companyId === null || assignment.allCompanies || assignment.companyIds.includes(fired.companyId)) wanted.add(assignment.userId)
      }
      const drafts: Draft[] = []
      for (const userId of [...wanted].sort()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, RECORD_VIEW[fired.recordType], facts.scope)) continue
        const language = await languageOf(db, userId)
        drafts.push({
          userId,
          category: 'ALERT',
          record: { type: fired.recordType, id: fired.recordId, label: fired.label },
          companyId: fired.companyId,
          anchor: null,
          messageKey: 'notifications.alert.raised',
          params: { title: firingTitle({ event: fired.event, withinMinutes: rule.withinMinutes, step: fired.step, date: fired.date }, language) },
          actorId: null,
        })
      }
      return drafts
    },
  },
])
