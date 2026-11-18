import { APPROVAL_DECISIONS, SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD, type ApprovalDecision, type ApprovalKind } from '../approvals-out/kinds'
import { mayReverse } from '../approvals-out/rules'
import type { Words } from '../portal/tasks/kinds'
import { BEFORE_CUT_SAMPLE_KINDS, dayWords, type AskSampleKind, type CutStart } from '../sales/change-requests/rules'

/**
 * B-PR-24 (production plan §3 "Decide for a brand, undo — production.brand.override, step-up; a second person when the
 * brand's switch is on", "Set a customer's order back to Regular, lock, unlock — step-up; no second person", "No silent
 * decisions … Undo is refused in words when the effect cannot be undone (for example a PP approval after cutting)";
 * 08-backend §4.6; lead pick L6; review fixes R-06, R-45): the factory's full control over a customer's production, pure.
 *
 *   who          production.brand.override over the order's company and customer, with step-up (the API's can() and step-up)
 *   decide for   an open approval of a kind the office may decide (approvals-out/rules mayDecideForParty: never a concession,
 *                a revised order, a signature or a proof), never by the person who asked it. With the customer's
 *                second-person switch on (PortalSettings.overrideFourEyes) it is not done at once: it becomes an internal
 *                BRAND_OVERRIDE approval a second person grants (never the person who asked for it); only then is it written
 *   reverse      the same switch and the same second person; and only while the record's effect can still be put back
 *                (reverseVerdict): a sample round back to under review and the gate it passed back to waiting, a swatch back
 *                to undecided — never once cutting started on the lines they are about (a PP or size set approval after
 *                cutting, a material approval after cutting); a new date asked again (it stands either way); a counter-offer
 *                never once carried out; any other answer is marked as put back
 *   urgency      setting a customer's order back to Regular, locking and unlocking it: step-up, never a second person (our own
 *                plan: the customer loses nothing it signed, R-45)
 * Every override is about ONE customer's record (the wall); the customer reads why ("Decided by us for you: …", "Put back by
 * us: …": approvals-out/rules), never who of us.
 */

export const OVERRIDE_ACTS = ['DECIDE_FOR', 'REVERSE', 'URGENCY'] as const
export type OverrideAct = (typeof OVERRIDE_ACTS)[number]

/** The internal approval kind a second person grants (approvals/rules APPROVAL_TASK_KINDS; its kind file is B-PR-38's). */
export const OVERRIDE_TASK_KIND = 'BRAND_OVERRIDE' as const

export type OverridePlan = { readonly outcome: 'AT_ONCE' } | { readonly outcome: 'SECOND_PERSON'; readonly taskKind: typeof OVERRIDE_TASK_KIND; readonly words: Words }

export const SECOND_PERSON_WORDS: Words = Object.freeze({
  it: 'Per questo cliente serve una seconda persona: la decisione parte quando un collega la approva.',
  en: 'This customer needs a second person: it is done once a colleague grants it.',
})

/** How an override goes: at once, or through a second person while the customer's switch is on (never for the urgency). */
export function overridePlan(act: OverrideAct, overrideFourEyes: boolean): OverridePlan {
  if (act === 'URGENCY' || !overrideFourEyes) return { outcome: 'AT_ONCE' }
  return { outcome: 'SECOND_PERSON', taskKind: OVERRIDE_TASK_KIND, words: SECOND_PERSON_WORDS }
}

/** Why this person may not grant the override (null: they may): never the person who asked for it. */
export const grantProblem = (override: { readonly requestedById: string }, granterId: string): string | null =>
  override.requestedById === granterId ? 'You asked for this override: a second person grants it.' : null

// ---- what a reversal puts back ------------------------------------------------------------------------------------------

/** What putting an answer back does to its record (each record adapter's reverse(), B-PR-30b). */
export const REVERSE_EFFECTS = ['ROUND_UNDER_REVIEW', 'GATE_WAITING', 'SWATCH_UNDECIDED', 'ASK_AGAIN', 'MARK_ONLY'] as const
export type ReverseEffect = (typeof REVERSE_EFFECTS)[number]

export const REVERSE_EFFECT_WORDS: Readonly<Record<ReverseEffect, Words>> = Object.freeze({
  ROUND_UNDER_REVIEW: { it: 'Il giro di campionatura torna in revisione.', en: 'The sample round is back under review.' },
  GATE_WAITING: { it: 'La tappa che aveva superato torna in attesa.', en: 'The gate it passed waits again.' },
  SWATCH_UNDECIDED: { it: 'Il campione di materiale torna da decidere.', en: 'The swatch is undecided again.' },
  ASK_AGAIN: { it: 'La nuova data resta: lo chiediamo di nuovo al cliente.', en: 'The new date stands: the customer is asked again.' },
  MARK_ONLY: { it: 'La risposta resta, segnata come revocata.', en: 'The answer stays, marked as put back.' },
})

export interface ReverseFacts {
  readonly kind: ApprovalKind
  readonly recordType: string
  /** A sample round's kind (record SampleRound). */
  readonly sampleKind?: string | null | undefined
  /** The first cut, read live, of the order lines the record is about (a cut of leather logged or a bundle made); null: none. */
  readonly cut: CutStart | null
  /** The round passed a gate (a PP or size set gate): the gate goes back to waiting too. */
  readonly passedGate: boolean
  /** COUNTER_OFFER: the request was carried out with it (ACCEPTED). */
  readonly applied: boolean
}

export type ReverseVerdict =
  | { readonly possible: true; readonly effects: readonly ReverseEffect[]; readonly words: Words }
  | { readonly possible: false; readonly code: 'OWN_WORD' | 'CUT' | 'LEATHER_CUT' | 'APPLIED'; readonly words: Words }

const possible = (effects: readonly ReverseEffect[]): ReverseVerdict => ({
  possible: true,
  effects: Object.freeze([...effects]),
  words: { it: effects.map((effect) => REVERSE_EFFECT_WORDS[effect].it).join(' '), en: effects.map((effect) => REVERSE_EFFECT_WORDS[effect].en).join(' ') },
})

function cutRefusal(cut: CutStart, what: Words): ReverseVerdict {
  const day = { it: dayWords(cut.day, 'it'), en: dayWords(cut.day, 'en') }
  return cut.leather
    ? { possible: false, code: 'LEATHER_CUT', words: { it: `La pelle è stata tagliata il ${day.it}: ${what.it} non si può più revocare.`, en: `The leather was cut on ${day.en}: ${what.en} can no longer be put back.` } }
    : { possible: false, code: 'CUT', words: { it: `Il taglio è iniziato il ${day.it}: ${what.it} non si può più revocare.`, en: `Cutting started on ${day.en}: ${what.en} can no longer be put back.` } }
}

/** Whether a customer's answer can still be put back, and what that does — or why not, in words. */
export function reverseVerdict(facts: ReverseFacts): ReverseVerdict {
  if (!mayReverse(facts.kind)) {
    return { possible: false, code: 'OWN_WORD', words: { it: 'È la parola del cliente: non la revochiamo noi per lui.', en: "It is the customer's own word: we never put it back for them." } }
  }
  if (facts.recordType === SAMPLE_ROUND_RECORD) {
    const beforeCut = typeof facts.sampleKind === 'string' && BEFORE_CUT_SAMPLE_KINDS.includes(facts.sampleKind as AskSampleKind)
    if ((beforeCut || facts.passedGate) && facts.cut) return cutRefusal(facts.cut, { it: "l'approvazione di questo campione", en: 'the approval of this sample' })
    return possible(facts.passedGate ? ['ROUND_UNDER_REVIEW', 'GATE_WAITING'] : ['ROUND_UNDER_REVIEW'])
  }
  if (facts.recordType === SAMPLE_SWATCH_RECORD) {
    if (facts.cut) return cutRefusal(facts.cut, { it: "l'approvazione di questo materiale", en: 'the approval of this material' })
    return possible(['SWATCH_UNDECIDED'])
  }
  if (facts.kind === 'REPROMISE') return possible(['ASK_AGAIN'])
  if (facts.kind === 'COUNTER_OFFER' && facts.applied) {
    return { possible: false, code: 'APPLIED', words: { it: 'La controproposta è già stata eseguita: non si può più revocare.', en: 'The counter-offer was carried out already: it can no longer be put back.' } }
  }
  return possible(['MARK_ONLY'])
}

// ---- B-PR-30a / B-PR-30b (production plan §3 "Decide for a brand, undo — … a second person when the brand's switch is on";
// 07-control §6.5; review fix R-06): the act a second person grants, and who may grant it ------------------------------------

/**
 * What the office person asked to do for the customer, carried on the BRAND_OVERRIDE task's preview (its `changes`, which the
 * fingerprint covers: the second person grants exactly this, and nothing is written before the yes):
 *
 *   DECIDE_FOR  the decision (approve, approve with changes, refuse), its words, the typed name of the person who decided and
 *               why (the customer reads it)
 *   REVERSE     why the answer is put back (the customer reads it)
 */
export type OverrideOrder =
  | { readonly act: 'DECIDE_FOR'; readonly decision: ApprovalDecision; readonly answer: string | null; readonly typedName: string; readonly reason: string }
  | { readonly act: 'REVERSE'; readonly reason: string }

/** A change as the approvals engine's preview keeps it (approvals/rules PreviewChange, no money in any of them). */
export interface OverrideChange {
  readonly field: string
  readonly from: unknown
  readonly to: unknown
}

/** The order as the task's preview changes (the second person reads them on the request). */
export function overrideChanges(order: OverrideOrder): OverrideChange[] {
  if (order.act === 'REVERSE') {
    return [
      { field: 'act', from: null, to: 'REVERSE' },
      { field: 'reversed', from: false, to: true },
      { field: 'reason', from: null, to: order.reason },
    ]
  }
  return [
    { field: 'act', from: null, to: 'DECIDE_FOR' },
    { field: 'status', from: 'OPEN', to: order.decision },
    { field: 'answer', from: null, to: order.answer },
    { field: 'typedName', from: null, to: order.typedName },
    { field: 'reason', from: null, to: order.reason },
  ]
}

/** The order back from a task's preview changes (null: not one this module wrote — the yes then carries out nothing). */
export function overrideOrderOf(changes: readonly OverrideChange[]): OverrideOrder | null {
  const value = (field: string): unknown => changes.find((change) => change.field === field)?.to
  const text = (field: string): string | null => {
    const found = value(field)
    return typeof found === 'string' && found.trim() !== '' ? found : null
  }
  const reason = text('reason')
  if (reason === null) return null
  const act = value('act')
  if (act === 'REVERSE') return value('reversed') === true ? { act: 'REVERSE', reason } : null
  if (act !== 'DECIDE_FOR') return null
  const decision = value('status')
  const typedName = text('typedName')
  if (typeof decision !== 'string' || !(APPROVAL_DECISIONS as readonly string[]).includes(decision) || typedName === null) return null
  return { act: 'DECIDE_FOR', decision: decision as ApprovalDecision, answer: text('answer'), typedName, reason }
}

/**
 * Who may grant the override (null: they may): never the person who asked for it (grantProblem), and never the person who asked
 * the customer for this approval (the same rule as deciding it: "never the asker").
 */
export function overrideGrantProblem(override: { readonly requestedById: string; readonly askedById: string | null }, granterId: string): string | null {
  return grantProblem(override, granterId) ?? (override.askedById !== null && override.askedById === granterId ? 'You asked the customer for this approval: someone else grants what we do for them.' : null)
}

/**
 * B-PR-30b / B-PR-40 (schema wave 5/5 lets the reversal through: factory_sample_round_guard, factory_sample_swatch_guard,
 * factory_order_gate_guard): the customer's decision on a sample round or a material swatch is put back — the round back under
 * review and the gate it passed waiting again, the swatch undecided — only while it is still the answer being put back (the
 * record decided by that request, at its time). A record decided another way or cancelled meanwhile holds nothing of the answer:
 * the office reads why (code HELD) and nothing is marked put back.
 */
export const ANSWER_NOT_ON_RECORD_WORDS: Readonly<Record<'SampleRound' | 'SampleSwatch', Words>> = Object.freeze({
  SampleRound: {
    it: "Il giro di campionatura non porta più questa risposta (è stato deciso in altro modo o annullato): non c'è nulla da revocare.",
    en: 'The sample round no longer holds this answer (it was decided another way or cancelled): there is nothing to put back.',
  },
  SampleSwatch: {
    it: "Il campione di materiale non porta più questa risposta (è stato deciso in altro modo): non c'è nulla da revocare.",
    en: 'The swatch no longer holds this answer (it was decided another way): there is nothing to put back.',
  },
})
