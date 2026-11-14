import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { DUAL_APPROVAL, dualThresholdMinor } from '@nexus/factory-domain/payables/proposal/approvals'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { STEP_UP_ACTION_BY_KEY } from '../../../platform/auth/office/step-up-policy'
import { kindOf } from '../../../platform/approvals/kinds'
import { MONEY_NOTIFICATIONS } from '../../../platform/notifications/rules/money'
import { officeOf } from '../store'
import { remittanceOf } from './remittance'

/**
 * Approvals and notifications of money (B-W2b-403; FIN-142, FIN-167, FIN-169; design finance.settings card "Approvals &
 * notifications": "Credit notes, write-offs, price overrides, manual payments above an amount · Payment received, SDI
 * rejection, overdue, deposit received, difference"), read only:
 *
 *   GET /payables/money-controls?companyId   payables.view: per risky money action what asks a yes or a fresh code today —
 *        the approval kind and how many of its rules are switched on for the company (none: no yes is asked: "no rule active
 *        until you set one"), the step-up action and whether the company keeps it on, the dual approval's amount (cost
 *        grain) — and, where the schema has no approval kind for it yet, the gap in words; then each money notification with
 *        its rule and who hears it, and the remittance switch.
 * Rules are made and switched in Admin › Approval rules (approvals.rules.manage), step-up actions in Admin › Security: this
 * read changes nothing (the amounts and audiences have no settings column yet: the step's schema need).
 */

export const MONEY_ACTIONS = ['SUPPLIER_INVOICE', 'PAYMENT_PROPOSAL', 'MANUAL_PAYMENT', 'CREDIT_NOTE', 'WRITE_OFF', 'PRICE_OVERRIDE'] as const
export type MoneyAction = (typeof MONEY_ACTIONS)[number]

const ACTION_FACTS: Readonly<Record<MoneyAction, { readonly kind: string | null; readonly stepUp: string | null; readonly dual: boolean; readonly words: { readonly en: string; readonly it: string } }>> = Object.freeze({
  SUPPLIER_INVOICE: { kind: null, stepUp: null, dual: true, words: { en: 'The person who entered a supplier invoice never approves it; above the amount a second person approves too.', it: "Chi ha registrato una fattura fornitore non la approva; sopra l'importo approva anche una seconda persona." } },
  PAYMENT_PROPOSAL: { kind: null, stepUp: 'payments.approve', dual: true, words: { en: 'The weekly payment proposal is approved by someone who did not make it, with a fresh code; above the amount a second person approves too. Payments go only to verified bank accounts.', it: "La proposta di pagamento settimanale la approva chi non l'ha preparata, con un codice nuovo; sopra l'importo approva anche una seconda persona. Si paga solo su conti verificati." } },
  MANUAL_PAYMENT: { kind: null, stepUp: null, dual: false, words: { en: 'A payment recorded by hand on one invoice (outside the proposal) asks no yes yet: the schema has no approval kind for it.', it: 'Un pagamento registrato a mano su una fattura (fuori dalla proposta) non chiede ancora un sì: lo schema non ha un tipo di approvazione.' } },
  CREDIT_NOTE: { kind: 'CREDIT_WITHOUT_RETURN', stepUp: 'invoices.issue', dual: false, words: { en: 'A credit note without the goods coming back asks a yes when a rule of its kind is on; issuing any invoice or credit note asks a fresh code.', it: 'Una nota di credito senza reso chiede un sì quando una regola del suo tipo è accesa; emettere fatture e note di credito chiede un codice nuovo.' } },
  WRITE_OFF: { kind: null, stepUp: null, dual: false, words: { en: "A write-off stays within the company's write-off tolerance (refused above it); a yes above an amount needs an approval kind the schema does not have yet.", it: "Uno storno resta entro la tolleranza della società (rifiutato oltre); un sì sopra un importo richiede un tipo di approvazione che lo schema non ha ancora." } },
  PRICE_OVERRIDE: { kind: 'PRICE_CHANGE', stepUp: null, dual: false, words: { en: 'A price override asks a yes once a step registers the price change kind (the schema has it; no module asks it yet).', it: 'Una modifica di prezzo chiederà un sì quando un passo registrerà il suo tipo (lo schema lo ha; nessun modulo lo chiede ancora).' } },
})

/** GET /payables/money-controls */
export async function moneyControls(caller: CommandCaller, query: { readonly companyId: string }) {
  const context = officeOf(caller)
  if (!can(actorOf(context), PAYABLES_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    const company = await client.company.findUnique({ where: { id: query.companyId }, select: { id: true, currency: true } })
    if (!company) throw new NotFoundError('Company not found.')
    const rules = await client.approvalRule.findMany({ where: { OR: [{ companyId: null }, { companyId: company.id }] }, select: { kind: true, active: true } })
    const security = await client.securitySettings.findUnique({ where: { id: context.tenantId }, select: { stepUpOff: true } })
    const off = new Set(security?.stepUpOff ?? [])
    return {
      companyId: company.id,
      currency: company.currency,
      actions: MONEY_ACTIONS.map((code) => {
        const facts = ACTION_FACTS[code]
        const ofKind = facts.kind ? rules.filter((rule) => rule.kind === facts.kind) : []
        const action = facts.stepUp ? STEP_UP_ACTION_BY_KEY.get(facts.stepUp) : undefined
        return {
          code,
          kind: facts.kind ? { code: facts.kind, registered: kindOf(facts.kind) !== undefined, rules: ofKind.length, active: ofKind.filter((rule) => rule.active).length } : null,
          stepUp: action ? { action: action.key, on: !action.canSwitchOff || !off.has(action.key) } : null,
          dual: facts.dual ? { amount: asMoney('cost', dualThresholdMinor(company.currency)), decided: DUAL_APPROVAL.decided } : null,
          words: facts.words,
        }
      }),
      notifications: MONEY_NOTIFICATIONS.map((entry) => ({ code: entry.code, rule: entry.rule, audience: entry.audience })),
      remittance: await remittanceOf(client, company.id),
    }
  })
}
