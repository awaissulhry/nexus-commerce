import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import type { AnswerPlan } from '@nexus/factory-domain/purchasing/confirm/answer'
import type { CommandTools } from '../../../core/command'
import type { LinkUse } from '../../../platform/links/use'

/**
 * A supplier's answer with changes (other quantities or dates, a split, a line it cannot deliver) is a PROPOSAL: the buyer
 * decides (Owner question P2, answer A). THE one place it is written.
 */
export interface ProposalInput {
  readonly order: { readonly id: string; readonly number: string; readonly partyId: string; readonly companyId: string; readonly siteId: string }
  readonly plan: AnswerPlan
  readonly use: LinkUse
  readonly linkId: string
}

export async function recordProposal(tools: CommandTools, input: ProposalInput): Promise<void> {
  void tools
  void input
  throw new InvalidStateError('Changes per line cannot be sent yet: confirm the order as asked or decline it, and write to the buyer about the changes.')
}
