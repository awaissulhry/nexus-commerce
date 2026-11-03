import type { Permission } from '../../core/permissions'
import { placerMayReleaseInForce, type HoldSettingSource } from '../holds/rules'
import { DEFAULT_FOUR_EYES_RULE, FOUR_EYES_CONDITIONS, fourEyesConditionsInForce, fourEyesInForce, isFourEyesCondition, type FourEyesCondition, type FourEyesRule, type SettingSource } from '../release/rules'

export { FOUR_EYES_CONDITIONS, fourEyesConditionsInForce, isFourEyesCondition, type FourEyesCondition }

/**
 * Separation of duties and four-eyes (B-W2b-118; QHS-300, Owner answer Q19 (a); design quality.settings qs-sod,
 * qs-loosen), pure. Two kinds of rule:
 *
 *   1. Separations every role template keeps (SEPARATIONS, "as permissions and tests"): a duty family a role holds keeps
 *      another family away from it — an operator signs no quality result, the quality office makes nothing, maintenance
 *      signs no quality result and only maintenance signs a machine safe, the people office signs no quality result and
 *      quality keeps no people records. `separationProblems` reads a role's permissions; the templates are held to zero
 *      by the test, a tenant's custom role is shown on the page when it breaks one.
 *   2. Who may sign what on ONE record (SIGNING_RULES): the commands that sign refuse in words (the releaser made none of
 *      the garments; the second person is not the inspector who signed; the approver is not the author or the decider; the
 *      hold's releaser is not its placer; the lot's releaser is not its receiver). Three are settings of QualitySettings —
 *      who releases garments (releaseFourEyes), when a second person is needed (fourEyesConditions + the customers listed)
 *      and whether the placer may release a hold (placerMayRelease); the others are fixed or locked and only said here.
 *
 * Loosening any of the three (`dutiesLoosenings`) asks for the reason and a fresh code (the step-up); tightening never does.
 * The words are the page's (it/en); the API answers codes.
 */

export type Language = 'it' | 'en'
export interface Words {
  readonly it: string
  readonly en: string
}
const w = (it: string, en: string): Words => Object.freeze({ it, en })
export const wordsIn = (words: Words, language: string): string => (language === 'it' ? words.it : words.en)

// ---- 1. the separations every role keeps ----------------------------------------------------------------------------------

/** The duty families: the permissions that ARE that duty. */
export const DUTY_FAMILIES = Object.freeze({
  /** Signing or deciding a quality result: an inspection, a release or reversal, a lot, a hold's release, an NCR's approval or close, a plan's approval. */
  QUALITY_SIGN: Object.freeze([
    'quality.inspections.record',
    'quality.garments.release',
    'quality.garments.reverse',
    'quality.lots.release',
    'quality.lots.reject',
    'quality.holds.release',
    'quality.incoming.record',
    'quality.inprocess.record',
    'quality.ncr.approve',
    'quality.ncr.close',
    'quality.plans.approve',
  ]) satisfies readonly Permission[],
  /** Making the goods: scanning work, cutting, bundling. */
  MAKING: Object.freeze(['production.scan', 'production.cut', 'production.bundles']) satisfies readonly Permission[],
  /** Signing a machine marked unsafe safe again. */
  MACHINE_SAFE: Object.freeze(['plant.signSafe']) satisfies readonly Permission[],
  /** Keeping people's records: the HR register, attendance closes, pay and the payroll file. */
  PEOPLE_RECORDS: Object.freeze(['people.employees.manage', 'people.attendance.close', 'people.attendance.correct', 'people.payroll.manage', 'people.payroll.records', 'people.leavers.manage']) satisfies readonly Permission[],
})
export type DutyFamily = keyof typeof DUTY_FAMILIES
export const DUTY_FAMILY_KEYS = Object.freeze(Object.keys(DUTY_FAMILIES)) as readonly DutyFamily[]

export const SEPARATION_IDS = ['OPERATOR_SIGNS_NO_QUALITY', 'QUALITY_MAKES_NOTHING', 'MAINTENANCE_SIGNS_NO_QUALITY', 'ONLY_MAINTENANCE_SIGNS_SAFE', 'PEOPLE_SIGNS_NO_QUALITY'] as const
export type SeparationId = (typeof SEPARATION_IDS)[number]

export interface Separation {
  readonly id: SeparationId
  /** The role templates whose duty this is (a custom role copied from one of them inherits it). */
  readonly roles: readonly string[]
  /** What such a role must not hold. */
  readonly mustNotHold: readonly DutyFamily[]
  /** Who it is said of (the page's group). */
  readonly who: 'INSPECTOR' | 'OPERATOR' | 'MAINTENANCE' | 'PEOPLE'
  readonly words: Words
  /** Also said of every other role (true: no role but these may hold the family named in `onlyThese`). */
  readonly onlyThese?: DutyFamily
}

/**
 * The separations, as the design and the plan name them ("Inspector, operator, maintenance and HR separation"). A floor
 * inspector scans at the bench (production.scan): the maker check of each release keeps them off the garments they made, so
 * the template rule is about the office's quality role.
 */
export const SEPARATIONS: readonly Separation[] = Object.freeze([
  {
    id: 'OPERATOR_SIGNS_NO_QUALITY',
    who: 'OPERATOR',
    roles: ['operator', 'cutting_operator'],
    mustNotHold: ['QUALITY_SIGN'],
    words: w('Chi produce non firma la qualità: un operatore non registra ispezioni, non rilascia capi o lotti e non approva.', 'Who makes the goods does not sign their quality: an operator records no inspection, releases no garment or lot and approves nothing.'),
  },
  {
    id: 'QUALITY_MAKES_NOTHING',
    who: 'INSPECTOR',
    roles: ['quality_inspector'],
    mustNotHold: ['MAKING'],
    words: w("La qualità non produce: l'ispettore d'ufficio non registra lavorazioni, tagli o mazzetti. Al banco, il controllo di chi ha prodotto tiene ogni ispettore lontano dai capi che ha fatto.", 'Quality makes nothing: the office inspector records no work, cut or bundle. At the bench, the maker check keeps every inspector off the garments they made.'),
  },
  {
    id: 'MAINTENANCE_SIGNS_NO_QUALITY',
    who: 'MAINTENANCE',
    roles: ['maintenance', 'technician'],
    mustNotHold: ['QUALITY_SIGN', 'MAKING'],
    words: w('La manutenzione non firma la qualità e non produce: ripara le macchine e le dichiara sicure.', 'Maintenance signs no quality result and makes nothing: it repairs the machines and signs them safe.'),
  },
  {
    id: 'ONLY_MAINTENANCE_SIGNS_SAFE',
    who: 'MAINTENANCE',
    roles: ['maintenance', 'technician'],
    mustNotHold: [],
    onlyThese: 'MACHINE_SAFE',
    words: w('Solo la manutenzione dichiara sicura una macchina segnalata non sicura: né la produzione né la qualità.', 'Only maintenance signs a machine marked unsafe safe again: neither production nor quality does.'),
  },
  {
    id: 'PEOPLE_SIGNS_NO_QUALITY',
    who: 'PEOPLE',
    roles: ['admin'],
    mustNotHold: ['QUALITY_SIGN'],
    words: w('Chi tiene i registri del personale non firma la qualità, e la qualità non tiene i registri del personale né la paga.', 'Who keeps the people records signs no quality result, and quality keeps no people records and sees no pay.'),
  },
])

export interface SeparationProblem {
  readonly id: SeparationId
  readonly role: string
  readonly permissions: readonly string[]
}

/** The roles the owner template's "everything" exempts: the owner holds every permission by design (one person may run it all). */
export const SEPARATION_EXEMPT: readonly string[] = Object.freeze(['owner'])

/**
 * The quality roles that must keep no people records (PEOPLE_SIGNS_NO_QUALITY's other half), and the office one that sees no
 * pay (a floor inspector's `pay` grain is their own piece-rate pay only, as every floor role's).
 */
const QUALITY_ROLES: readonly string[] = Object.freeze(['quality_inspector', 'floor_inspector'])
const QUALITY_OFFICE_ROLES: readonly string[] = Object.freeze(['quality_inspector'])
const PAY_GRAINS: readonly string[] = Object.freeze(['wages', 'pay'])

/**
 * What one role breaks. `templateKey`: the template it is (a system role) or was copied from (a custom role, null when
 * unknown: then only the "only these" rules apply, by its permissions).
 */
export function separationProblems(role: { readonly key: string; readonly templateKey: string | null; readonly permissions: readonly string[]; readonly grains?: readonly string[] }): SeparationProblem[] {
  if (SEPARATION_EXEMPT.includes(role.key) || (role.templateKey !== null && SEPARATION_EXEMPT.includes(role.templateKey))) return []
  const held = new Set(role.permissions)
  const of = (family: DutyFamily) => DUTY_FAMILIES[family].filter((permission) => held.has(permission))
  const problems: SeparationProblem[] = []
  for (const rule of SEPARATIONS) {
    const own = role.templateKey !== null && rule.roles.includes(role.templateKey)
    if (own) {
      const found = rule.mustNotHold.flatMap(of)
      if (found.length > 0) problems.push({ id: rule.id, role: role.key, permissions: found })
    }
    if (rule.onlyThese && !own) {
      const found = of(rule.onlyThese)
      if (found.length > 0) problems.push({ id: rule.id, role: role.key, permissions: found })
    }
  }
  // Quality keeps no people records and sees no pay.
  if (role.templateKey !== null && QUALITY_ROLES.includes(role.templateKey)) {
    const pay = QUALITY_OFFICE_ROLES.includes(role.templateKey) ? (role.grains ?? []).filter((grain) => PAY_GRAINS.includes(grain)).map((grain) => `money.${grain}`) : []
    const found = [...of('PEOPLE_RECORDS'), ...pay]
    if (found.length > 0) problems.push({ id: 'PEOPLE_SIGNS_NO_QUALITY', role: role.key, permissions: found })
  }
  return problems
}

// ---- 2. who may sign what on one record ---------------------------------------------------------------------------------

export const SIGNING_RULE_IDS = ['RESULT_SIGNED', 'RELEASE_NOT_MAKER', 'RELEASE_ALONE', 'FOUR_EYES_FOR', 'AMENDMENT_SECOND_SIGNATURE', 'HOLD_RELEASE', 'REVERSAL', 'LOT_RELEASE', 'PLAN_APPROVAL', 'NCR_APPROVAL'] as const
export type SigningRuleId = (typeof SIGNING_RULE_IDS)[number]

export interface SigningRule {
  readonly id: SigningRuleId
  /** SETTING: changed on the page; LOCKED: always on (said with its law); FIXED: how the factory works (said with its why). */
  readonly kind: 'SETTING' | 'LOCKED' | 'FIXED'
  readonly words: Words
  /** LOCKED: the law it stands on. */
  readonly law?: { readonly name: string; readonly plain: Words }
}

/** The amendment's law (design qs-sod "always on (locked, LawRef)"). */
export const AMENDMENT_LAW = Object.freeze({
  name: 'Reg. (EU) 2016/425 art. 8(4)',
  plain: w(
    'Il fabbricante tiene la produzione in serie conforme e i suoi registri veritieri: un risultato firmato si corregge solo con una seconda firma, mai sovrascrivendolo.',
    'The manufacturer keeps series production in conformity and its records true: a signed result is corrected only with a second signature, never overwritten.',
  ),
})

export const SIGNING_RULES: readonly SigningRule[] = Object.freeze([
  { id: 'RESULT_SIGNED', kind: 'FIXED', words: w("L'ispettore firma il risultato: con il PIN al banco, con il codice in ufficio.", 'The inspector signs the result: with the PIN at the bench, with the code in the office.') },
  {
    id: 'RELEASE_NOT_MAKER',
    kind: 'FIXED',
    words: w(
      'Chi rilascia non ha prodotto nessuno dei capi: lo dicono le scansioni; dove le scansioni registrano solo la postazione, è una dichiarazione firmata.',
      'Whoever releases made none of the garments: the scans say so; where scans record the station only, it is a signed statement.',
    ),
  },
  { id: 'RELEASE_ALONE', kind: 'SETTING', words: w("L'ispettore che non ha prodotto nessuno dei capi può rilasciare da solo l'ispezione che ha firmato.", 'An inspector who made none of the garments may release the inspection they signed alone.') },
  { id: 'FOUR_EYES_FOR', kind: 'SETTING', words: w('Quando serve una seconda persona al rilascio.', 'When a release needs a second person.') },
  {
    id: 'AMENDMENT_SECOND_SIGNATURE',
    kind: 'LOCKED',
    words: w('Una correzione a un risultato firmato richiede la firma di una seconda persona: sempre.', 'A correction of a signed result needs a second person to sign it: always.'),
    law: AMENDMENT_LAW,
  },
  { id: 'HOLD_RELEASE', kind: 'SETTING', words: w('Un blocco è rilasciato da una persona diversa da chi lo ha messo.', 'A hold is released by someone other than the person who placed it.') },
  {
    id: 'REVERSAL',
    kind: 'FIXED',
    words: w(
      "L'annullamento di un rilascio: una persona qualificata con un motivo scritto. Protegge soltanto, quindi non viene mai rallentato.",
      'A release reversal: one qualified person with a written reason. It only protects, so it is never slowed.',
    ),
  },
  { id: 'LOT_RELEASE', kind: 'FIXED', words: w('Un lotto è rilasciato da una persona diversa da chi lo ha ricevuto, digitando il suo codice.', 'A lot is released by someone other than the person who received it, typing its code.') },
  { id: 'PLAN_APPROVAL', kind: 'FIXED', words: w('Una versione di un piano di ispezione è approvata da una persona diversa da chi l’ha scritta o modificata.', 'A version of an inspection plan is approved by someone other than whoever wrote or changed it.') },
  { id: 'NCR_APPROVAL', kind: 'FIXED', words: w('La decisione su una non conformità è approvata da una persona diversa da chi l’ha presa.', 'A nonconformance decision is approved by someone other than whoever made it.') },
])

/** The result rules that are locked (design qs-results "Result override needs a reason: always (locked)"). */
export const OVERRIDE_REASON_WORDS = w('Cambiare il risultato calcolato richiede sempre un motivo scritto (e una seconda persona al rilascio).', 'Overriding the computed result always needs a written reason (and a second person at release).')

// ---- the settings and what is in force ------------------------------------------------------------------------------------


/** One QualitySettings row's part this card keeps (a company's, or the tenant-wide row). */
export interface DutiesRow {
  readonly releaseFourEyes: FourEyesRule | null
  readonly fourEyesConditions: readonly FourEyesCondition[]
  readonly secondPersonPartyIds: readonly string[]
  readonly placerMayRelease: boolean | null
}

export interface DutiesInForce {
  readonly releaseFourEyes: { readonly rule: FourEyesRule; readonly source: SettingSource }
  /** The conditions in force: the company's list and the tenant-wide one together; no row at all: both (the database's rule). */
  readonly conditions: readonly FourEyesCondition[]
  /** Of those, the ones the tenant-wide row asks (a company cannot drop them on its own). */
  readonly conditionsFromTenant: readonly FourEyesCondition[]
  readonly customers: readonly string[]
  readonly placerMayRelease: { readonly value: boolean; readonly source: HoldSettingSource }
}

const sorted = <T extends string>(values: Iterable<T>): T[] => [...new Set(values)].sort()

/**
 * What is in force for a company (`company` its own row or null) or tenant-wide (`company` undefined: the tenant row
 * alone, as a company with no row of its own sees it).
 */
export function dutiesInForce(company: DutiesRow | null | undefined, tenant: DutiesRow | null): DutiesInForce {
  const own = company ?? null
  const rule = fourEyesInForce(own, tenant)
  return {
    releaseFourEyes: { rule: rule.rule, source: rule.source },
    conditions: rule.conditions,
    conditionsFromTenant: company === undefined || !tenant ? [] : sorted(tenant.fourEyesConditions),
    customers: [...rule.partyIds],
    placerMayRelease: (() => {
      const found = placerMayReleaseInForce(own?.placerMayRelease, tenant?.placerMayRelease)
      return { value: found.placerMayRelease, source: found.source }
    })(),
  }
}

/** Why the second person is needed at a release, by the settings in force (the database writes the same reasons). */
export function secondPersonNeeded(input: { readonly overridden: boolean; readonly customerListed: boolean; readonly inForce: Pick<DutiesInForce, 'releaseFourEyes' | 'conditions'> }): ('OVERRIDE' | 'CUSTOMER' | 'ALWAYS')[] {
  const reasons: ('OVERRIDE' | 'CUSTOMER' | 'ALWAYS')[] = []
  if (input.overridden && input.inForce.conditions.includes('OVERRIDE')) reasons.push('OVERRIDE')
  if (input.customerListed && input.inForce.conditions.includes('CUSTOMER')) reasons.push('CUSTOMER')
  if (input.inForce.releaseFourEyes.rule === 'ALWAYS') reasons.push('ALWAYS')
  return reasons
}

// ---- loosening (design qs-loosen) -----------------------------------------------------------------------------------------

export const LOOSENINGS = ['RELEASE_ALONE', 'OVERRIDE_ALONE', 'CUSTOMER_ALONE', 'CUSTOMERS_REMOVED', 'PLACER_RELEASES'] as const
export type Loosening = (typeof LOOSENINGS)[number]

/** "From now on …" in words, per loosening (the ActionConfirm's sentence). `{count}` = customers taken off. */
export const LOOSENING_WORDS: Readonly<Record<Loosening, Words>> = Object.freeze({
  RELEASE_ALONE: w("D'ora in poi un ispettore che non ha prodotto nessuno dei capi rilascia da solo.", 'From now on an inspector who made none of the garments releases alone.'),
  OVERRIDE_ALONE: w('D’ora in poi una sola persona può rilasciare i risultati forzati e i rilasci condizionati.', 'From now on one person can release overridden results and conditional releases.'),
  CUSTOMER_ALONE: w('D’ora in poi i capi dei clienti elencati non richiedono più una seconda persona.', "From now on the listed customers' garments no longer need a second person."),
  CUSTOMERS_REMOVED: w("D'ora in poi i capi di {count} clienti tolti dall'elenco non richiedono più una seconda persona.", "From now on the garments of {count} customer(s) taken off the list no longer need a second person."),
  PLACER_RELEASES: w("D'ora in poi chi ha messo un blocco può anche rilasciarlo.", 'From now on the person who placed a hold may release it too.'),
})

/** What a change loosens, comparing what is in force before and after (never the rows alone: a company also follows the tenant). */
export function dutiesLoosenings(before: DutiesInForce, after: DutiesInForce): Loosening[] {
  const out: Loosening[] = []
  if (before.releaseFourEyes.rule === 'ALWAYS' && after.releaseFourEyes.rule !== 'ALWAYS') out.push('RELEASE_ALONE')
  if (before.conditions.includes('OVERRIDE') && !after.conditions.includes('OVERRIDE')) out.push('OVERRIDE_ALONE')
  if (before.conditions.includes('CUSTOMER') && !after.conditions.includes('CUSTOMER') && before.customers.length > 0) out.push('CUSTOMER_ALONE')
  const kept = new Set(after.customers)
  if (after.conditions.includes('CUSTOMER') && before.customers.some((partyId) => !kept.has(partyId))) out.push('CUSTOMERS_REMOVED')
  if (!before.placerMayRelease.value && after.placerMayRelease.value) out.push('PLACER_RELEASES')
  return out
}

/** The fields a duties save changed on its row (the event's `fields`). */
export const DUTIES_FIELDS = ['releaseFourEyes', 'fourEyesConditions', 'secondPersonPartyIds', 'placerMayRelease'] as const
export type DutiesField = (typeof DUTIES_FIELDS)[number]

export function dutiesChanged(before: DutiesRow, after: DutiesRow): DutiesField[] {
  const same = (a: readonly string[], b: readonly string[]) => sorted(a).join(',') === sorted(b).join(',')
  const out: DutiesField[] = []
  if ((before.releaseFourEyes ?? null) !== (after.releaseFourEyes ?? null)) out.push('releaseFourEyes')
  if (!same(before.fourEyesConditions, after.fourEyesConditions)) out.push('fourEyesConditions')
  if (!same(before.secondPersonPartyIds, after.secondPersonPartyIds)) out.push('secondPersonPartyIds')
  if ((before.placerMayRelease ?? null) !== (after.placerMayRelease ?? null)) out.push('placerMayRelease')
  return out
}

/** A row nobody saved (the defaults it reads as). */
export const EMPTY_DUTIES_ROW: DutiesRow = Object.freeze({ releaseFourEyes: null, fourEyesConditions: [...FOUR_EYES_CONDITIONS], secondPersonPartyIds: [], placerMayRelease: null })

/** The default rule (Owner answer Q19 (a)) in force with no row at all. */
export const DEFAULT_RELEASE_RULE: FourEyesRule = DEFAULT_FOUR_EYES_RULE
