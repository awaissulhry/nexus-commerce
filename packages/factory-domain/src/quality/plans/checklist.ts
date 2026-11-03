import { labelIn } from '../defects/rules'
import { CHECK_TYPE_WORDS, CLASS_WORDS, STAGE_WORDS, VERSION_STATUS_WORDS, samplingWords, specWords, type CheckContent, type PlanStage, type SamplingDraft, type VersionStatus } from './rules'

/**
 * A plan version as a printable checklist (B-W2b-92; design quality.plans new tab `pl-print` "Plan as a printable
 * checklist: a paper fallback for a bench without a tablet"): the page the web prints, laid out here so the words are
 * the same everywhere. Check words in the language asked (a floor language falls back to English, flagged), the fixed
 * words in Italian or English (another language reads English). A version that is not APPROVED says so at the top:
 * paper is never mistaken for the version in force.
 */

export interface ChecklistInput {
  readonly plan: { readonly code: string; readonly name: string; readonly stage: PlanStage }
  readonly version: {
    readonly number: number
    readonly status: VersionStatus
    readonly approvedByName: string | null
    /** UTC ISO instant. */
    readonly approvedAt: string | null
    readonly changeNote: string | null
  }
  readonly sampling: SamplingDraft
  readonly profile: { readonly code: string; readonly name: string } | null
  /** In list order. */
  readonly checks: readonly CheckContent[]
}

export interface ChecklistRow {
  /** 1, 2, 3 … (an instruction takes a number too: it is read in its place). */
  readonly n: number
  readonly code: string
  readonly label: string
  /** True when the language asked has no words of its own for this check (English stands in). */
  readonly missing: boolean
  readonly type: string
  readonly takesResult: boolean
  readonly klass: string | null
  readonly critical: boolean
  readonly mandatory: boolean
  readonly photoRequired: boolean
  /** "58.000 ± 1.000 cm", "From the style's size chart"; null for other types. */
  readonly spec: string | null
  /** What is written or ticked on paper. */
  readonly answer: string
  readonly choices: readonly string[]
}

export interface PrintableChecklist {
  readonly language: string
  readonly title: string
  readonly subtitle: string
  /** A warning at the top when the version is not the approved one; null when it is. */
  readonly notInForce: string | null
  readonly lines: readonly { readonly label: string; readonly value: string }[]
  readonly rows: readonly ChecklistRow[]
  /** Sample columns to tick per unit (a fixed sample up to 10); 0: one answer per check. */
  readonly sampleColumns: number
  readonly signatures: readonly string[]
  readonly legend: string
}

const ANSWERS: Readonly<Record<CheckContent['type'], { it: string; en: string }>> = Object.freeze({
  PASS_FAIL: { it: '☐ Conforme   ☐ Non conforme   ☐ Non applicabile', en: '☐ Pass   ☐ Fail   ☐ Not applicable' },
  MEASUREMENT: { it: 'Misurato: ________', en: 'Measured: ________' },
  COUNT: { it: 'Contati: ________', en: 'Counted: ________' },
  CHOICE: { it: 'Segnare una risposta', en: 'Tick one answer' },
  FREE_TEXT: { it: '______________________________', en: '______________________________' },
  PHOTO: { it: '☐ Foto fatta', en: '☐ Photo taken' },
  SIGNATURE: { it: 'Firma: ________________', en: 'Signature: ________________' },
  INSTRUCTION: { it: 'Da leggere', en: 'To read' },
})

const MAX_COLUMNS = 10

/** The printable checklist of a version, in the language asked. */
export function printableChecklist(input: ChecklistInput, language: string): PrintableChecklist {
  const l = language === 'it' ? 'it' : 'en'
  const it = l === 'it'
  const words = samplingWords(input.sampling, l, input.profile)
  const approved = input.version.status === 'APPROVED'
  const lines = [
    { label: it ? 'Fase' : 'Stage', value: STAGE_WORDS[input.plan.stage][l] },
    { label: it ? 'Versione' : 'Version', value: `v${input.version.number} · ${VERSION_STATUS_WORDS[input.version.status][l]}` },
    ...(input.version.approvedByName || input.version.approvedAt
      ? [{ label: it ? 'Approvata da' : 'Approved by', value: [input.version.approvedByName, input.version.approvedAt?.slice(0, 10)].filter(Boolean).join(' · ') }]
      : []),
    { label: it ? 'Campione' : 'Sample', value: words.sample },
    ...(words.frequency ? [{ label: it ? 'Frequenza' : 'How often', value: words.frequency }] : []),
    { label: it ? 'Al numero di rifiuto' : 'At the reject number', value: words.stop },
    { label: it ? 'Lotto / ordine' : 'Lot / order', value: '________________' },
    { label: it ? 'Quantità del lotto · campione' : 'Lot size · sample', value: '________ · ________' },
  ]
  let n = 0
  const rows = input.checks.map((check): ChecklistRow => {
    n += 1
    const label = labelIn(check, language)
    const missing = language !== 'it' && language !== 'en' && check.labelI18n[language] === undefined
    return {
      n,
      code: check.code,
      label,
      missing,
      type: CHECK_TYPE_WORDS[check.type][l],
      takesResult: CHECK_TYPE_WORDS[check.type].takesResult,
      klass: check.checkClass ? CLASS_WORDS[check.checkClass][l] : null,
      critical: check.checkClass === 'CRITICAL',
      mandatory: check.mandatory,
      photoRequired: check.photoRequired,
      spec: specWords(check, l),
      answer: ANSWERS[check.type][l],
      choices: check.type === 'CHOICE' ? check.choices.map((choice) => `☐ ${choice}`) : [],
    }
  })
  return {
    language,
    title: `${input.plan.code} · ${input.plan.name}`,
    subtitle: it ? `Lista di controllo, versione ${input.version.number}` : `Checklist, version ${input.version.number}`,
    notInForce: approved ? null : it ? `Versione ${VERSION_STATUS_WORDS[input.version.status].it.toLowerCase()}: non è quella in vigore. Non usarla per un controllo.` : `${VERSION_STATUS_WORDS[input.version.status].en} version: not the one in force. Do not use it for an inspection.`,
    lines,
    rows,
    sampleColumns: input.sampling.samplingMethod === 'FIXED' ? Math.min(input.sampling.fixedSampleSize ?? 0, MAX_COLUMNS) : 0,
    signatures: it ? ['Ispettore ________________', 'Data e ora ________________', 'Esito: ☐ Accettato   ☐ Respinto'] : ['Inspector ________________', 'Date and time ________________', 'Result: ☐ Accepted   ☐ Rejected'],
    legend: it
      ? 'Obbligatorio: senza risposta il controllo non è firmato come superato. Critico: se non è conforme, il controllo non passa.'
      : 'Mandatory: without an answer the inspection is not signed as passed. Critical: a fail fails the inspection.',
  }
}
