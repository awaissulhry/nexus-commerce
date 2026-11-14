import type { Permission } from '@nexus/factory-domain/core/permissions'

/**
 * The risky office actions that ask for a fresh code (B-W2b-404; PLT-063; design admin.security "Actions that ask for a
 * fresh code": "Change bank details · give admin · approve above a limit · export everything · delete · worker PIN reset",
 * with the permission behind each). ONE LINE PER ACTION: a step that adds a step-up permission adds it to an action here
 * (step-up-actions.vitest.test.ts holds every office permission with the stepUp risk to exactly one action).
 *
 * An action is the permissions of the routes it covers: `requireStepUp` finds the action of a request by its route's
 * manifest permission. The company may switch an action off (SecuritySettings.stepUpOff, Admin › Security) unless it is
 * fixed:
 *   ACCESS     it changes who can do what (A1 §3.10: user and role changes always ask; a stolen session must not hand out
 *              rights)
 *   SIGNATURE  the fresh code is part of a signed act (an e-signature's evidence)
 *   LEGAL      a legal record or a word to an authority made in the company's name
 *   RULE       it asks when its own rule says so (an approval rule's "ask for a fresh code"), switched there
 *   SECURITY   it changes these settings themselves (a wider change always asks)
 * A route that asks a fresh code on a condition of its own (naming workers again, a looser hold rule…) and whose
 * permission is in no action keeps asking as before.
 */

export const STEP_UP_FIXED = ['ACCESS', 'SIGNATURE', 'LEGAL', 'RULE', 'SECURITY'] as const
export type StepUpFixed = (typeof STEP_UP_FIXED)[number]

export interface StepUpAction {
  /** Dotted lower camel case words, at most 80 characters (SecuritySettings.stepUpOff keeps these keys). */
  readonly key: string
  readonly permissions: readonly Permission[]
  /** Why it can never be switched off; null: the company may switch it off. */
  readonly fixed: StepUpFixed | null
}

const action = (key: string, permissions: readonly Permission[], fixed: StepUpFixed | null = null): StepUpAction =>
  Object.freeze({ key, permissions: Object.freeze([...permissions]), fixed })

export const STEP_UP_ACTIONS: readonly StepUpAction[] = Object.freeze([
  // The design's list.
  action('bankDetails.change', ['companies.bank.manage', 'purchasing.bank.propose', 'purchasing.bank.verify', 'purchasing.bank.reveal']),
  action('access.change', ['roles.assign', 'roles.manage', 'users.invite', 'users.suspend', 'users.reactivate', 'users.deactivate', 'users.resetPassword', 'workers.roles', 'partners.invite', 'partners.manage', 'accounting.accountants.manage'], 'ACCESS'),
  action('approvals.aboveLimit', ['approvals.decide'], 'RULE'),
  action('records.erase', ['parties.erase']),
  action('workers.credentials', ['workers.credentials']),
  // The other risky actions.
  action('invoices.issue', ['invoices.issue']),
  action('money.settings', ['costing.method.manage', 'costing.actuals.manage', 'invoices.tax.switch', 'accounting.unlock', 'orders.waive']),
  action('reminders.switch', ['receivables.reminders.switch', 'purchasing.reminders.switch']),
  action('email.identities', ['email.manage']),
  action('branding.change', ['documents.branding.manage']),
  action('signatures.sign', ['quality.amendments.sign', 'safety.risk.sign', 'compliance.techfiles.sign', 'compliance.claims.approve', 'compliance.ppeTexts.manage', 'purchasing.compliance.override'], 'SIGNATURE'),
  action('legal.outward', ['compliance.techfiles.share', 'compliance.recall.send', 'people.privacy.manage', 'people.piecerates.switch', 'invoices.testMode.manage'], 'LEGAL'),
  action('security.settings', ['security.settings.manage'], 'SECURITY'),
])
