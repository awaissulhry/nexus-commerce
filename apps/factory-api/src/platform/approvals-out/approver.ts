import type { FactoryClient } from '@nexus/factory-db'
import { SAMPLE_ROUND_RECORD, type ApprovalKind, type ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { approverHeldWords, approverRuleOf, CUSTOMER_QUALITY_ROLE, mayAnswerAsApprover, type ApproverRule } from '@nexus/factory-domain/production-brand/approver'
import type { CommandTx } from '../../core/command'
import { liveAssignment } from '../auth/roles/access'

/**
 * B-PR-29 (production plan §3 "Brand alone", §C S-LIM-approver; 08-backend §4.4 "Named approver checked in
 * api:platform/approvals-out/answer.ts"; review fix R-25): who of the customer answers its production approvals. Read in the
 * tenant's SYSTEM scope (PortalSettings is office-only: the partner role reads none of it), before the answer's command and for
 * the pages that say who may answer:
 *
 *   the rule      factory-domain production-brand/approver: PP, size set and top-of-production rounds (asked as a SAMPLE) and
 *                 fabric and trim approvals are the named approver's (the top of production also the customer's Quality
 *                 people); every other kind keeps today's rule
 *   the approver  PortalSettings.productionApproverId of the request's own customer (the row's id is the party's), an ACTIVE
 *                 portal person of that customer; anyone else (made inactive, moved) counts as nobody named
 *   the answerer  the portal person (or, for TOP, a holder of the customer's live Quality role); a link answers for nobody
 *
 * Nothing here crosses customers: the settings, the person and the role are read by the request's own party.
 */

type Client = FactoryClient | CommandTx

export interface ApproverFacts {
  readonly rule: ApproverRule
  readonly approver: { readonly id: string; readonly name: string }
}

export interface ApproverAsk {
  readonly kind: string
  readonly recordType: string
  readonly recordId: string
  readonly partyId: string
}

/** The named approver this request waits for, or null (not a production approval, or nobody named, or nobody active). */
export async function approverOf(client: Client, request: ApproverAsk): Promise<ApproverFacts | null> {
  const sampleKind = request.recordType === SAMPLE_ROUND_RECORD ? ((await client.sampleRound.findUnique({ where: { id: request.recordId }, select: { kind: true } }))?.kind ?? null) : null
  const rule = approverRuleOf({ kind: request.kind as ApprovalKind, recordType: request.recordType, sampleKind })
  if (rule === null) return null
  const settings = await client.portalSettings.findUnique({ where: { id: request.partyId }, select: { partyId: true, productionApproverId: true } })
  if (!settings || settings.partyId !== request.partyId || !settings.productionApproverId) return null
  const person = await client.user.findUnique({ where: { id: settings.productionApproverId }, select: { id: true, displayName: true, status: true, audience: true, partyId: true } })
  if (!person || person.status !== 'ACTIVE' || person.audience !== 'PARTNER' || person.partyId !== request.partyId) return null
  return { rule, approver: { id: person.id, name: person.displayName } }
}

/** The person holds the customer's Quality role now (a live assignment of the system role `customer-quality`). */
async function holdsQuality(client: Client, userId: string, now: Date): Promise<boolean> {
  return (await client.roleAssignment.count({ where: { userId, ...liveAssignment(now), role: { key: CUSTOMER_QUALITY_ROLE, audience: 'PARTNER' } } })) > 0
}

export interface ApproverVerdict {
  /** The named approver's name (the customer's own colleague). */
  readonly name: string
  /** This answerer may answer. */
  readonly may: boolean
  /** Why not, in the reader's words ("Waiting for Anna: …"); null when they may. */
  readonly held: string | null
}

/** What the named approver means for this answerer, or null when nobody named covers the request (today's rule holds). */
export async function approverVerdict(client: Client, request: ApproverAsk, who: { readonly via: 'LINK' | 'PORTAL'; readonly userId: string | null }, locale: ApprovalLocale, now: Date): Promise<ApproverVerdict | null> {
  const facts = await approverOf(client, request)
  if (!facts) return null
  const quality = facts.rule === 'APPROVER_OR_QUALITY' && who.via === 'PORTAL' && who.userId !== null && who.userId !== facts.approver.id ? await holdsQuality(client, who.userId, now) : false
  const may = mayAnswerAsApprover(facts.rule, facts.approver.id, { via: who.via, userId: who.userId, quality })
  return { name: facts.approver.name, may, held: may ? null : approverHeldWords(facts.rule, facts.approver.name, who.via, locale) }
}
