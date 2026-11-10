import { classificationOf } from '../../product/compliance/rules'
import type { PpeCategory, ProductType } from '../../product/styles/rules'
import type { LabelQr } from '../labels/render'
import { mmText, type LabelField, type LabelKind, type LabelQrTarget } from '../labels/rules'
import type { LawReference } from '../textile-rules/rules'
import {
  certificateGloveLevel,
  gloveLevelOf,
  gloveLevelText,
  hasElectronicAddress,
  hasPostalAddress,
  localOrigin,
  namesSender,
  suggestedContact,
  WARNING_PHRASE_KEYS,
  WARNING_WORDS,
  warningsAsked,
  type ExpectedSender,
  type GloveLevel,
  type WarningReason,
} from './marking'

/**
 * What a PPE label must say (B-W2b-253; PRD-333, PRD-335, PRD-336, PRD-346, PRD-349; design compliance.labels ›
 * lb-checks "the marking rules, each a sentence with pass or fail", › lb-rule "Why this rule"), per label template and
 * market, pure. The API gathers the facts (modules/compliance/label-rules).
 *
 *   ceMarking      the CE marking on PPE only, at least 5 mm high, the notified body's number after it exactly for category
 *                  III (a body of the directory), and the markings the market lists (PRD-333)
 *   classWarnings  the EN 17092 class B and class C warnings and the removable protectors' warning, from the phrase library
 *                  in every language the label and the market print; drafts until GATE-PPE-TEXTS (PRD-335)
 *   gloveMarking   a glove marked to EN 13594 with its level and KP as its certificate grants (PRD-336)
 *   gpsr           the type and batch, and the contact with a postal and an electronic address, on a consumer line that is
 *                  not PPE (or where the market asks it); it names the brand for a private-label style sold under its own
 *                  name, our company otherwise (Owner 11-09) (PRD-346)
 *   qrCode         the QR to the public DoC page of the batch or the style (B-W2b-166) (PRD-349)
 *
 * Each check is one of B-W2b-254's requirements at label print: `gateKey` is the requirement's checkKey, and `blocks` says
 * whether the label must not print. W1's label rules (compliance/labels styleProblems, contentProblems) still stop
 * activation; these checks say what the law asks beyond them and where the label stands.
 */

export const LABEL_RULE_KEYS = ['ceMarking', 'classWarnings', 'gloveMarking', 'gpsr', 'qrCode'] as const
export type LabelRuleKey = (typeof LABEL_RULE_KEYS)[number]

/** The checkKey of the requirement (ComplianceRequirement, B-W2b-216/254) each check answers. `gpsr.contact` is seeded. */
export const GATE_CHECK_KEYS: Readonly<Record<LabelRuleKey, string>> = Object.freeze({
  ceMarking: 'label.ceMarking',
  classWarnings: 'label.classWarnings',
  gloveMarking: 'label.gloveMarking',
  gpsr: 'gpsr.contact',
  qrCode: 'label.qrCode',
})

export const LABEL_RULE_OUTCOMES = ['PASS', 'FAIL', 'WARN', 'WAITING', 'UNKNOWN', 'NOT_APPLICABLE'] as const
export type LabelRuleOutcome = (typeof LABEL_RULE_OUTCOMES)[number]
/** What stops a label from printing: something to fix, an outside yes still awaited, or a fact not known. */
export const BLOCKING_OUTCOMES: readonly LabelRuleOutcome[] = Object.freeze(['FAIL', 'WAITING', 'UNKNOWN'])

export const FINDING_SEVERITIES = ['FAIL', 'WARN', 'WAITING'] as const
export interface LabelFinding {
  readonly path: string
  readonly message: string
  readonly severity: (typeof FINDING_SEVERITIES)[number]
}

export interface LabelRuleCheck {
  readonly key: LabelRuleKey
  readonly gateKey: string
  readonly title: string
  readonly outcome: LabelRuleOutcome
  /** The label must not print while this is so. */
  readonly blocks: boolean
  /** The check's sentence (with findings: the first of them). */
  readonly words: string
  readonly law: readonly LawReference[]
  readonly findings: readonly LabelFinding[]
}

const PPE_REG = 'https://eur-lex.europa.eu/eli/reg/2016/425/oj'
const law = (name: string, plain: string, href: string | null): LawReference => Object.freeze({ law: name, plain, href })

export const LABEL_RULE_WORDS: Readonly<Record<LabelRuleKey, { readonly title: string; readonly law: readonly LawReference[] }>> = Object.freeze({
  ceMarking: {
    title: 'CE marking',
    law: [
      law('Reg. (EU) 2016/425 art. 17', 'The CE marking is affixed visibly, legibly and indelibly to the PPE; on category III PPE it is followed by the identification number of the notified body that checks production (Annex VII or VIII).', PPE_REG),
      law('Reg. (EC) 765/2008 art. 30, Annex II', 'The CE marking keeps its proportions and is at least 5 mm high.', 'https://eur-lex.europa.eu/eli/reg/2008/765/oj'),
    ],
  },
  classWarnings: {
    title: 'Class warnings',
    law: [
      law('EN 17092-1:2020, EN 17092-5:2020, EN 17092-6:2020', 'A class B garment has no impact protectors and a class C garment is made to hold impact protectors, not to resist abrasion: the label says so in words beside the pictogram. A garment whose impact protectors can be taken out says that its class holds only with them in place.', null),
      law('Reg. (EU) 2016/425 Annex II 1.4', 'The information the maker gives with the PPE, in a language the user understands.', PPE_REG),
    ],
  },
  gloveMarking: {
    title: 'Glove marking',
    law: [law('EN 13594:2015', "A motorcycle rider's glove is marked with the standard's pictogram and its level, 1 or 2, with KP when its knuckles are protected.", null)],
  },
  gpsr: {
    title: 'GPSR identifier and contact',
    law: [
      law('Reg. (EU) 2023/988 art. 9(5)', 'A consumer product bears its type and its batch or serial number, or another element that identifies it.', 'https://eur-lex.europa.eu/eli/reg/2023/988/oj'),
      law('Reg. (EU) 2023/988 art. 9(6)', "The maker's name, registered trade name or mark, and its postal and electronic address, on the product or, where that is not possible, on its packaging or a document with it.", 'https://eur-lex.europa.eu/eli/reg/2023/988/oj'),
    ],
  },
  qrCode: {
    title: 'QR to the public DoC',
    law: [law('Reg. (EU) 2016/425 art. 15, Annex II 1.4', 'The EU declaration of conformity goes with the PPE, or the instructions give the internet address where it can be read: the QR leads there.', PPE_REG)],
  },
})

// ---- the facts -----------------------------------------------------------------------------------------------------------------

export interface RuleTemplate {
  readonly id: string
  readonly code: string
  readonly revision: number
  readonly status: string
  readonly kind: LabelKind
  readonly languages: readonly string[]
  readonly makerPartyId: string | null
  readonly makerName: string
  readonly makerAddress: string
  readonly gpsrContact: string | null
  readonly qrTarget: LabelQrTarget
  /** layout.notifiedBodyNumber (W1: category III only). */
  readonly notifiedBodyNumber: string | null
  /** The CE marking's height in the template's preset, hundredths of a millimetre. */
  readonly ceHeight: number
  /** What the label prints for the style (compliance/labels printedFields). */
  readonly printed: readonly LabelField[]
}

export interface RuleStyle {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly productType: ProductType
  readonly ppeCategory: PpeCategory
  readonly ppeStandard: string | null
  readonly ppeClass: string | null
  readonly brandPartyId: string | null
  readonly soldUnderOurName: boolean
  readonly companyId: string | null
}

/** The certificate covering the style (the cell asked, else the base cell), as the label reads it. */
export interface RuleCertificate {
  readonly id: string
  readonly number: string
  readonly standard: string
  readonly ppeClass: string | null
  readonly notifiedBodyNumber: string
  /** B-W2b-216 performanceLevels (`{ "level": "2", "knuckle": "KP" }`); null when not given. */
  readonly levels: Readonly<Record<string, string>> | null
}

/** The notified body directory's entries with the label's number (B-W2b-216 NotifiedBody). */
export interface RuleBody {
  readonly number: string
  readonly name: string
  readonly status: string
}

export interface RuleMarket {
  readonly code: string
  readonly name: string
  readonly switchedOn: boolean
  readonly labelLanguages: readonly string[]
  readonly markings: readonly string[]
  readonly gpsrContactNeeded: boolean
}

export interface LabelRuleFacts {
  readonly template: RuleTemplate
  readonly style: RuleStyle
  readonly certificate: RuleCertificate | null
  readonly bodies: readonly RuleBody[]
  /** False when the directory was not read (the floor has no grant on it): the number is then not checked against it. */
  readonly bodiesRead?: boolean | undefined
  /** The pockets of the revision's protector placements (a protector in a pocket can be taken out). */
  readonly protectorPockets: readonly string[]
  /** The ACTIVE phrases found among the warning keys. */
  readonly phraseKeys: ReadonlySet<string>
  /** What prints per warning key and language (phrases approvedTexts: null = missing). */
  readonly texts: ReadonlyMap<string, ReadonlyMap<string, string | null>>
  /** Where the QR points, the web origin it carries, and whether the page shows something today (null: not known yet). */
  readonly qr: { readonly qr: LabelQr | null; readonly origin: string; readonly live: boolean | null }
  /**
   * GATE-PPE-TEXTS (Owner 11-09): a PPE consultant's yes to this label's texts. No record holds it yet, so the warnings
   * stay drafts and do not print; the step that records the yes per template sets it.
   */
  readonly ppeTextsApproved: boolean
}

// ---- helpers ------------------------------------------------------------------------------------------------------------------

const CATEGORY_WORDS: Readonly<Record<PpeCategory, string>> = { NOT_PPE: 'not PPE', CATEGORY_I: 'category I PPE', CATEGORY_II: 'category II PPE', CATEGORY_III: 'category III PPE' }
const KIND_WORDS: Readonly<Record<LabelKind, string>> = { PPE_GARMENT: 'PPE garment label', GLOVE_MARKING: 'glove marking', FIBRE_CARE: 'fibre and care label', PACKAGING: 'packaging label' }

function checkOf(key: LabelRuleKey, findings: readonly LabelFinding[], passWords: string): LabelRuleCheck {
  const outcome: LabelRuleOutcome = findings.some((entry) => entry.severity === 'FAIL') ? 'FAIL' : findings.some((entry) => entry.severity === 'WAITING') ? 'WAITING' : findings.some((entry) => entry.severity === 'WARN') ? 'WARN' : 'PASS'
  const first = findings.find((entry) => entry.severity === (outcome === 'PASS' ? 'WARN' : outcome)) ?? findings[0]
  const more = findings.length > 1 ? ` (${findings.length - 1} more below)` : ''
  return {
    key,
    gateKey: GATE_CHECK_KEYS[key],
    title: LABEL_RULE_WORDS[key].title,
    outcome,
    blocks: BLOCKING_OUTCOMES.includes(outcome),
    words: outcome === 'PASS' || !first ? passWords : `${first.message}${more}`,
    law: LABEL_RULE_WORDS[key].law,
    findings,
  }
}

const notApplicable = (key: LabelRuleKey, words: string): LabelRuleCheck => ({
  key,
  gateKey: GATE_CHECK_KEYS[key],
  title: LABEL_RULE_WORDS[key].title,
  outcome: 'NOT_APPLICABLE',
  blocks: false,
  words,
  law: LABEL_RULE_WORDS[key].law,
  findings: [],
})

const fail = (path: string, message: string): LabelFinding => ({ path, message, severity: 'FAIL' })
const warn = (path: string, message: string): LabelFinding => ({ path, message, severity: 'WARN' })

/** The languages a check covers: the label's, then those the market adds. */
export const languagesOf = (template: Pick<RuleTemplate, 'languages'>, market: Pick<RuleMarket, 'labelLanguages'> | null): string[] => [...new Set([...template.languages, ...(market?.labelLanguages ?? [])])]

/** The class the label prints: the covering certificate's, else the style's (as compliance/labels render). */
export function printedClass(style: RuleStyle, certificate: RuleCertificate | null): string | null {
  const classification = classificationOf(style)
  return certificate?.ppeClass ?? classification.ppeClass ?? classification.partClass
}

// ---- CE marking (PRD-333) -----------------------------------------------------------------------------------------------------

export function ceMarking(facts: LabelRuleFacts, market: RuleMarket | null): LabelRuleCheck {
  const { template, style, certificate } = facts
  const classification = classificationOf(style)
  if (template.kind === 'FIBRE_CARE') return notApplicable('ceMarking', 'A fibre and care label carries no CE marking: the PPE garment label does.')
  if (template.kind === 'PACKAGING') return notApplicable('ceMarking', 'A packaging label carries the CE marking only where the PPE itself cannot (Reg. (EU) 2016/425 art. 17): the PPE label is checked for it.')
  if (!classification.isPpe) {
    return template.notifiedBodyNumber === null
      ? notApplicable('ceMarking', `Style ${style.code} is not PPE: its label carries no CE marking.`)
      : checkOf('ceMarking', [fail('layout/notifiedBodyNumber', `Style ${style.code} is not PPE: its label carries no CE marking and no notified-body number. Remove it.`)], '')
  }
  const findings: LabelFinding[] = []
  const said: string[] = []
  if (!template.printed.includes('ceMark')) findings.push(fail('layout/fields', `Label ${template.code} does not print the CE marking: PPE carries it (Reg. (EU) 2016/425 art. 17).`))
  if (template.ceHeight < 500) findings.push(fail('layout/preset', `The CE marking prints ${mmText(template.ceHeight)} mm high: at least 5 mm (Reg. (EC) 765/2008 Annex II).`))
  else said.push(`prints ${mmText(template.ceHeight)} mm high (at least 5 mm)`)

  const nb = template.notifiedBodyNumber
  if (style.ppeCategory === 'CATEGORY_III') {
    if (nb === null) {
      findings.push(fail('layout/notifiedBodyNumber', `Style ${style.code} is category III PPE: the CE marking is followed by the number of the notified body that checks production (Annex VII or VIII). Type it in the label.`))
    } else if (!/^\d{4}$/.test(nb)) {
      findings.push(fail('layout/notifiedBodyNumber', "A notified body's identification number has four digits (NANDO)."))
    } else {
      const active = facts.bodies.find((body) => body.number === nb && body.status === 'ACTIVE')
      const known = facts.bodies.find((body) => body.number === nb)
      if (active) said.push(`is followed by ${nb}, ${active.name} in the notified body directory`)
      else if (known) findings.push(fail('layout/notifiedBodyNumber', `Notified body ${nb} is in the directory only as archived (no longer notified): the CE marking names the body that checks production now.`))
      else if (facts.bodiesRead === false) said.push(`is followed by ${nb}`)
      else {
        said.push(`is followed by ${nb}`)
        findings.push(warn('layout/notifiedBodyNumber', `Notified body ${nb} is not in the notified body directory: add it there (with its NANDO entry) so the number after the CE marking is checked.`))
      }
      if (certificate && certificate.notifiedBodyNumber !== nb) said.push(`(the type was examined by ${certificate.notifiedBodyNumber}; the number after the CE marking is the body that checks production)`)
    }
  } else if (nb !== null) {
    findings.push(fail('layout/notifiedBodyNumber', `No notified-body number after the CE mark: style ${style.code} is ${CATEGORY_WORDS[style.ppeCategory]}, and only category III carries one (Reg. (EU) 2016/425 art. 17). Remove it.`))
  } else {
    said.push(`has no notified-body number after it (${CATEGORY_WORDS[style.ppeCategory]}: only category III carries one)`)
  }

  if (market) {
    for (const mark of market.markings.filter((entry) => entry !== 'CE')) {
      findings.push(fail(`markets/${market.code}/markings/${mark}`, `Market ${market.code} asks for the ${mark} marking (Rules & markets › Markets); this label prints the CE marking only: a label with ${mark} is a template of its own.`))
    }
  }
  return checkOf('ceMarking', findings, `Style ${style.code} is ${CATEGORY_WORDS[style.ppeCategory]}: the CE marking ${said.join(', ')}.`)
}

// ---- class warnings (PRD-335) ---------------------------------------------------------------------------------------------------

export function classWarnings(facts: LabelRuleFacts, market: RuleMarket | null): LabelRuleCheck {
  const { template, style, certificate } = facts
  const classification = classificationOf(style)
  if (template.kind !== 'PPE_GARMENT') return notApplicable('classWarnings', `A ${KIND_WORDS[template.kind]} carries no EN 17092 class warning: the PPE garment label does.`)
  if (!classification.isPpe || classification.standardCode !== 'EN 17092') return notApplicable('classWarnings', `Style ${style.code} is not made to EN 17092: no class warning.`)
  const ppeClass = printedClass(style, certificate)
  const asked = warningsAsked({ standardCode: classification.standardCode, ppeClass, protectorPockets: facts.protectorPockets })
  if (asked.length === 0) return notApplicable('classWarnings', `Style ${style.code} is class ${ppeClass ?? '(none)'} with no impact protector in a pocket: no class warning.`)

  const languages = languagesOf(template, market)
  const findings: LabelFinding[] = []
  for (const reason of asked) {
    const key = WARNING_PHRASE_KEYS[reason]
    if (!facts.phraseKeys.has(key)) {
      findings.push(fail(`phrases/${key}`, `Add the phrase ${key} (a warning) to the phrase library: the label prints ${WARNING_WORDS[reason]}.`))
      continue
    }
    for (const language of languages) {
      if ((facts.texts.get(key)?.get(language) ?? null) === null) {
        const who = template.languages.includes(language) ? `the label prints ${language}` : `market ${market?.code ?? ''} needs ${language}`
        findings.push(fail(`phrases/${key}/${language}`, `The phrase ${key} has no approved ${language} text: ${who}.`))
      }
    }
  }
  const words = asked.map((reason) => WARNING_WORDS[reason]).join('; ')
  if (findings.length === 0 && !facts.ppeTextsApproved) {
    findings.push({
      path: 'gate/GATE-PPE-TEXTS',
      message: `The texts of ${words} are ready in ${languages.join(', ')}; they print once a PPE consultant has said yes to this label's texts (GATE-PPE-TEXTS). Until then the label does not carry them.`,
      severity: 'WAITING',
    })
  }
  return checkOf('classWarnings', findings, `The label carries ${words}, in ${languages.join(', ')}.`)
}

// ---- glove marking (PRD-336) ------------------------------------------------------------------------------------------------------

export function gloveMarking(facts: LabelRuleFacts): LabelRuleCheck {
  const { template, style, certificate } = facts
  const classification = classificationOf(style)
  const glove = style.productType === 'GLOVES' || classification.standardCode === 'EN 13594'
  if (!glove) {
    return template.kind === 'GLOVE_MARKING'
      ? checkOf('gloveMarking', [fail('kind', `A glove marking on style ${style.code}, which is not a glove: choose the kind of label the garment carries.`)], '')
      : notApplicable('gloveMarking', `Style ${style.code} is not a glove.`)
  }
  if (!classification.isPpe) return notApplicable('gloveMarking', `Glove ${style.code} is not PPE: no EN 13594 marking.`)
  const findings: LabelFinding[] = []
  if (template.kind !== 'GLOVE_MARKING') findings.push(warn('kind', `Style ${style.code} is a glove: its label is a glove marking, not a ${KIND_WORDS[template.kind]}.`))
  if (classification.standardCode !== 'EN 13594') findings.push(fail('style/ppeStandard', `A motorcycle rider's glove is marked to EN 13594: style ${style.code} names ${style.ppeStandard ?? 'no standard'}.`))
  const level: GloveLevel | null = gloveLevelOf(printedClass(style, certificate))
  if (level === null) {
    findings.push(fail('style/ppeClass', `Style ${style.code} names no EN 13594 level (1, 2, 1KP or 2KP): the glove's pictogram prints it.`))
  } else if (certificate) {
    const granted = certificateGloveLevel(certificate.levels)
    if (granted === null) findings.push(warn('certificate/performanceLevels', `Certificate ${certificate.number} gives no EN 13594 levels: record them (Compliance › Certificates) so the marking is checked against what it grants.`))
    else if (granted.level !== level.level || granted.knuckle !== level.knuckle) {
      findings.push(fail('style/ppeClass', `Certificate ${certificate.number} grants level ${gloveLevelText(granted)}; the label prints ${gloveLevelText(level)}: it prints what the certificate grants, so correct the style or the certificate first.`))
    }
  }
  if (!template.printed.includes('pictogram')) findings.push(fail('layout/fields', `Label ${template.code} does not print the glove's pictogram with its level.`))
  return checkOf('gloveMarking', findings, `The glove's pictogram prints EN 13594 level ${level ? gloveLevelText(level) : ''}${certificate ? `, as certificate ${certificate.number} grants` : ''}.`)
}

// ---- GPSR identifier and contact (PRD-346) -------------------------------------------------------------------------------------------

export function gpsrContact(facts: LabelRuleFacts, market: RuleMarket | null, sender: ExpectedSender): LabelRuleCheck {
  const { template, style } = facts
  const classification = classificationOf(style)
  if (classification.isPpe && !(market?.gpsrContactNeeded ?? false)) {
    return notApplicable(
      'gpsr',
      `Style ${style.code} is ${CATEGORY_WORDS[style.ppeCategory]}: its label names the maker with the postal address, the type and the batch (Reg. (EU) 2016/425 art. 8(5)(6)). Whether the GPSR contact applies to PPE too is Owner question Q37${market ? `; market ${market.code} does not ask for it` : ''}.`,
    )
  }
  const findings: LabelFinding[] = []
  const said: string[] = []
  if (template.printed.includes('model') && template.printed.includes('batchOrSerial')) said.push('the type (the style code) and the batch or serial number')
  else findings.push(fail('layout/fields', 'The label prints the type and the batch or serial number of the product (Reg. (EU) 2023/988 art. 9(5)).'))

  const whoWords = sender.who === 'BRAND' ? 'the brand, which sells the style under its own name' : 'our company'
  const contact = template.gpsrContact?.trim() ?? ''
  if (contact === '') {
    findings.push(fail('gpsrContact', `Type the GPSR contact: the name of ${whoWords}, its postal address and an electronic address (an e-mail or a web address) (Reg. (EU) 2023/988 art. 9(6)).`))
  } else {
    if (!hasPostalAddress(contact)) findings.push(fail('gpsrContact', 'The GPSR contact gives no postal address: street and number, postal code and town (Reg. (EU) 2023/988 art. 9(6)).'))
    if (!hasElectronicAddress(contact)) findings.push(fail('gpsrContact', 'The GPSR contact gives no electronic address: an e-mail or a web address (Reg. (EU) 2023/988 art. 9(6)).'))
    if (sender.name !== null && !namesSender(contact, sender.name) && !namesSender(template.makerName, sender.name)) {
      findings.push(warn('gpsrContact', `For style ${style.code} the GPSR contact names ${whoWords}, "${sender.name}" (Owner 11-09); the label names "${contact.split(/\r?\n/)[0]}".`))
    }
    said.push(`the contact with a postal and an electronic address`)
  }
  if (sender.operatorId === null) findings.push(warn('operators', `No manufacturer is named for style ${style.code}${market ? ` in market ${market.code}` : ''} (Rules & markets › Operators): the contact is not checked against it.`))
  if (sender.who === 'COMPANY' && style.brandPartyId !== null && template.makerPartyId === style.brandPartyId) {
    findings.push(warn('makerPartyId', `Style ${style.code} is sold under our name: the label names our company as the maker and the contact, not the brand (Owner 11-09).`))
  }
  return checkOf('gpsr', findings, `The label prints ${said.join(', and ')} of ${whoWords}.`)
}

// ---- the QR to the public DoC (PRD-349) ---------------------------------------------------------------------------------------------

export function qrCode(facts: LabelRuleFacts): LabelRuleCheck {
  const { template, style } = facts
  const classification = classificationOf(style)
  if (template.qrTarget === 'NONE') {
    return notApplicable(
      'qrCode',
      classification.isPpe
        ? 'The label carries no QR: the declaration of conformity travels with the goods. A QR to the batch’s public DoC page can be added (QR target: the batch).'
        : `Style ${style.code} is not PPE: no public DoC page, no QR.`,
    )
  }
  if (!classification.isPpe) return checkOf('qrCode', [fail('qrTarget', `Style ${style.code} is not PPE: it has no public DoC page, so its label carries no QR to one. Set the QR target to none.`)], '')
  const findings: LabelFinding[] = []
  const qr = facts.qr.qr
  if (template.qrTarget === 'STYLE_DOC' && (template.kind === 'PPE_GARMENT' || template.kind === 'GLOVE_MARKING')) {
    findings.push(warn('qrTarget', "A garment's QR names its batch (QR target: the batch): the style's page shows its newest declaration, which may be of a later revision than the garment."))
  }
  if (localOrigin(facts.qr.origin)) {
    findings.push(warn('qr/origin', `The QR leads to ${facts.qr.origin}: a printed QR is read for ten years, so the public web address is set before the first live label (B-W2b-166).`))
  }
  if (!template.printed.includes('qr')) findings.push(fail('layout/fields', `Label ${template.code} does not print its QR.`))
  if (qr !== null && qr.address !== null && facts.qr.live === false) {
    findings.push(
      warn(
        'qr/live',
        qr.kind === 'BATCH'
          ? `The page of ${qr.reference ? `work order ${qr.reference}'s` : 'this'} batch answers once the work order is released.`
          : `Style ${style.code} has no published declaration yet: its page says it is not published here yet.`,
      ),
    )
  }
  const where = qr?.address ? `${qr.address}, with the code ${qr.printed} printed under it` : "each garment's batch page, given at the work order's release, with its code printed under it"
  return checkOf('qrCode', findings, `The QR leads to the public DoC page: ${where}.`)
}

// ---- all of them -------------------------------------------------------------------------------------------------------------------

/** The five checks of the label for a market (null: the label's own languages, no market's markings or GPSR ask). */
export function labelRuleChecks(facts: LabelRuleFacts, market: RuleMarket | null, sender: ExpectedSender): LabelRuleCheck[] {
  return [ceMarking(facts, market), classWarnings(facts, market), gloveMarking(facts), gpsrContact(facts, market, sender), qrCode(facts)]
}

/** One line per check for a gate's explanation: blocking or not, in words. */
export const blocking = (checks: readonly LabelRuleCheck[]): LabelRuleCheck[] => checks.filter((check) => check.blocks)

// ---- what the label must print (for the builder, the proof and the artwork) ------------------------------------------------------------

export interface LabelMarking {
  readonly qr: (LabelQr & { readonly target: LabelQrTarget; readonly origin: string; readonly live: boolean | null }) | null
  readonly warnings: readonly {
    readonly reason: WarningReason
    readonly key: string
    readonly texts: readonly { readonly language: string; readonly text: string | null }[]
    /** GATE-PPE-TEXTS: a draft until a PPE consultant says yes to this label's texts. */
    readonly draft: boolean
  }[]
  readonly glove: { readonly level: GloveLevel; readonly text: string; readonly granted: GloveLevel | null } | null
  readonly gpsr: { readonly typed: string | null; readonly expected: ExpectedSender; readonly suggested: string | null }
}

/** What the label must print beyond W1's fields, in the label's languages (and the market's, when given). */
export function labelMarking(facts: LabelRuleFacts, market: RuleMarket | null, sender: ExpectedSender): LabelMarking {
  const { template, style, certificate } = facts
  const classification = classificationOf(style)
  const ppeClass = printedClass(style, certificate)
  const languages = languagesOf(template, market)
  const asked = template.kind === 'PPE_GARMENT' && classification.isPpe ? warningsAsked({ standardCode: classification.standardCode, ppeClass, protectorPockets: facts.protectorPockets }) : []
  const level = classification.standardCode === 'EN 13594' || style.productType === 'GLOVES' ? gloveLevelOf(ppeClass) : null
  return {
    qr: facts.qr.qr ? { ...facts.qr.qr, target: template.qrTarget, origin: facts.qr.origin, live: facts.qr.live } : null,
    warnings: asked.map((reason) => {
      const key = WARNING_PHRASE_KEYS[reason]
      return { reason, key, texts: languages.map((language) => ({ language, text: facts.texts.get(key)?.get(language) ?? null })), draft: !facts.ppeTextsApproved }
    }),
    glove: level ? { level, text: gloveLevelText(level), granted: certificate ? certificateGloveLevel(certificate.levels) : null } : null,
    gpsr: { typed: template.gpsrContact, expected: sender, suggested: suggestedContact(sender) },
  }
}
