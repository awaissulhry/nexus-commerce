import type { Prisma } from '@nexus/factory-db'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import type { PartnerMessageKey } from '@nexus/factory-domain/portal/notifications/messages'
import type { CommandTx } from '../../../../core/command'
import type { PartnerReader } from '../../tasks/people'

/**
 * A partner notification rule (B-W2b-167, PLT-148): which partner people an outbox event concerns and what they are told. One
 * file per source in this folder, one line in ./index.ts (a merge point): a portal step that tells partners of its records
 * adds its rule there. QUIET: a rule names one party and the readers of it who would see the record in their portal; never
 * the actor's own party for what the partner did itself (`byPartner`); never an amount or an office person in `params`.
 */

export interface PartnerDraft {
  readonly partyId: string
  /** The record's company: the readers' roles must reach it (a tenant-wide partner sees each company's portal apart). */
  readonly companyId: string
  readonly record: { readonly type: string; readonly id: string; readonly label: string }
  readonly messageKey: PartnerMessageKey
  /** What the sentence needs (a task's kind, a date): never an amount, never an office person's id. */
  readonly params: Record<string, Prisma.InputJsonValue | null>
  /** The tab or row the notification opens at (`task:<id>`, `message:<id>`), or null. */
  readonly anchor: string | null
  /** Whether this reader of the party is told (their role reaches what the record shows). */
  readonly forReader: (reader: PartnerReader) => boolean
}

export interface PartnerRuleContext {
  readonly tx: CommandTx
  readonly tenantId: string
  readonly now: Date
  readonly event: EventEnvelope
}

export interface PartnerRule {
  /** `<area>.<rule>`, for the audit row. */
  readonly name: string
  readonly events: readonly string[]
  drafts(context: PartnerRuleContext, payload: unknown): Promise<readonly PartnerDraft[]>
}
