import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { isFinal, type GoodsOutcome, type ReturnDisposition, type ReturnStatus } from '../returns/rules'

/**
 * Remakes, exchanges and closing a return (B-W2b-346; SAL-298 a remake asked with photos, SAL-350 split lines on a partial
 * receipt, SAL-351 a size exchange, SAL-355 back unchanged after inspection with a return shipment, SAL-360 close with a
 * finish reason), pure. apps/factory-api's modules/sales/returns-outcomes says these rules in words before the
 * …_service_safety_w2b_guards triggers would refuse the same, and builds its answers from them.
 *
 *   split        once part of a line arrived (the RMA RECEIVED or INSPECTED), the line keeps what arrived (its pieces cut
 *                down to its received pieces) and a NEW line split from it takes the rest, still expected: the same order
 *                and invoice line, size, reason and price, nothing received, no decision. Never a line credited without
 *                the goods (nothing is expected of it), nor one of which nothing or everything arrived. The new line sits
 *                right after its parent (seq + 1 … + 9, else after the last line).
 *   exchange     SIZE_EXCHANGE: the same garment in another size of the style's size range (never the size that came
 *                back), on the replacement order's line in that size (W2a's replacement order takes Replace and Size
 *                exchange lines); the returned goods go where a Replace's go.
 *   send back    the goods go back to the customer as they came (RETURN_UNCHANGED, BACK_TO_CUSTOMER, no credit) after the
 *                inspection: each line received and graded, not decided otherwise, with ONE live return DDT (shipping's
 *                source DDT of the RMA, reason RETURN) that carries it. Never a protective garment returned for a defect
 *                (it goes back only after a safety check: repair, quarantine or scrap; W2a's rule).
 *   finish       an RMA closes with a finish reason (ReturnFinishReason), required, in the same update as CLOSED: every
 *                received line decided first; each reason only where the RMA's facts carry it (credited without a return
 *                needs such a line, returned unchanged a line sent back, goods not received a piece that never came,
 *                completed a decided line, the customer withdrew no credit given); OTHER says why in words.
 *   remake       a remake asked with photos (made-to-measure fit): one item of what the customer received, what is wrong
 *                with the fit in words, a front and a back photo (the page holds the send until both are there; they go
 *                onto the line after the request exists). From the office (on an RMA it made), the portal or a claim
 *                link (a REQUESTED RMA the office authorises). The office decides the line as it sees fit (W2a's REMAKE
 *                disposition is the made-to-measure remake order of B-W2b-360).
 */

export interface Words {
  readonly it: string
  readonly en: string
}

// ---- split (SAL-350) ------------------------------------------------------------------------------------------------

/** A line is split once goods arrived, before the RMA closes (the guard's RECEIVED / INSPECTED). */
export const SPLIT_STATUSES: readonly ReturnStatus[] = Object.freeze(['RECEIVED', 'INSPECTED'])

export interface SplitFacts {
  readonly status: ReturnStatus
  readonly seq: number
  readonly quantity: number
  readonly received: number
  readonly creditWithoutReturn: boolean
}

/** Why the line may not be split now (null: it may), in words. */
export function splitHeld(facts: SplitFacts): string | null {
  if (isFinal(facts.status)) return `The return is ${facts.status.toLowerCase()}: its lines change no more.`
  if (!SPLIT_STATUSES.includes(facts.status)) return `Nothing arrived yet: before the goods, change line ${facts.seq}'s pieces instead.`
  if (facts.creditWithoutReturn) return `Line ${facts.seq} was credited without the goods: nothing more is expected of it.`
  if (facts.received < 1) return `Nothing of line ${facts.seq} arrived yet: it waits for its goods as it is.`
  if (facts.received >= facts.quantity) return `Every piece of line ${facts.seq} arrived: there is nothing to split off.`
  return null
}

/** The pieces the line split off takes (what did not arrive). */
export const restOf = (facts: Pick<SplitFacts, 'quantity' | 'received'>): number => Math.max(0, facts.quantity - facts.received)

/**
 * The place of the new line: the first free number after its parent and below the next line (10 → 11), else after the
 * last line (the next ten). Seqs are unique on an RMA.
 */
export function splitSeqOf(seqs: readonly number[], parentSeq: number): number {
  const taken = new Set(seqs)
  const above = seqs.filter((seq) => seq > parentSeq).sort((a, b) => a - b)[0] ?? Number.POSITIVE_INFINITY
  for (let seq = parentSeq + 1; seq < Math.min(above, parentSeq + 10); seq += 1) if (!taken.has(seq)) return seq
  const last = Math.max(parentSeq, ...seqs)
  return (Math.floor(last / 10) + 1) * 10
}

// ---- size exchange (SAL-351) ----------------------------------------------------------------------------------------

export const EXCHANGE_SIZE_MAX = 20

export interface ExchangeFacts {
  readonly seq: number
  /** The size that came back (null: the line names none). */
  readonly size: string | null
  /** The style's size range (null: the line names no style). */
  readonly sizes: readonly string[] | null
}

/** The sizes the line may be exchanged for: the style's others, in the range's order. */
export const exchangeSizesOf = (facts: Pick<ExchangeFacts, 'size' | 'sizes'>): string[] => (facts.sizes && facts.size ? facts.sizes.filter((size) => size !== facts.size) : [])

/** Why a size exchange does not fit the line (null: it may be one), in words. */
export function exchangeHeld(facts: ExchangeFacts): string | null {
  if (!facts.sizes || !facts.size) return `Line ${facts.seq} names no style and size: replace it instead.`
  if (exchangeSizesOf(facts).length === 0) return `The style has no other size than ${facts.size}: replace or credit it instead.`
  return null
}

/** The problems of the size asked, at `path` (the decision's `…/exchangeSize`). */
export function exchangeSizeProblems(facts: ExchangeFacts, exchangeSize: string | null | undefined, path: string): Issue[] {
  const held = exchangeHeld(facts)
  if (held) return [{ path, message: held }]
  const size = (exchangeSize ?? '').trim()
  if (size === '') return [{ path, message: `Name the size the customer gets instead of ${facts.size}.` }]
  if (size.length > EXCHANGE_SIZE_MAX) return [{ path, message: `At most ${EXCHANGE_SIZE_MAX} characters.` }]
  if (size === facts.size) return [{ path, message: `Another size than the one that came back (${facts.size}).` }]
  if (!facts.sizes!.includes(size)) return [{ path, message: `Size ${size} is not one of the style's sizes (${facts.sizes!.join(', ')}).` }]
  return []
}

// ---- back unchanged, with a return shipment (SAL-355) ---------------------------------------------------------------

export interface SendBackLine {
  readonly id: string
  readonly seq: number
  readonly received: number
  readonly graded: boolean
  readonly disposition: ReturnDisposition | null
  readonly goodsOutcome: GoodsOutcome | null
  /** A protective garment returned for a defect (or found defective or misused): never back as it came. */
  readonly safety: boolean
  /** The live return DDT that carries it already, if any. */
  readonly onDdt: string | null
}

/** Whether the line goes (or went) back as it came. */
export const goesBackUnchanged = (line: Pick<SendBackLine, 'disposition' | 'goodsOutcome'>): boolean => line.disposition === 'RETURN_UNCHANGED' || line.goodsOutcome === 'BACK_TO_CUSTOMER'

/** Why the line cannot go back unchanged now (null: it can), in words. */
export function sendBackHeld(line: SendBackLine): string | null {
  if (line.received < 1) return `Nothing of line ${line.seq} arrived: there is nothing to send back.`
  if (line.onDdt) return `Line ${line.seq} travels back with DDT ${line.onDdt} already.`
  if (line.disposition !== null && !goesBackUnchanged(line)) return `Line ${line.seq} is decided otherwise.`
  if (line.disposition === null && !line.graded) return `Line ${line.seq} is not inspected yet: grade it first.`
  if (line.disposition === null && line.safety) return 'A protective garment returned for a defect goes back on the market only after a safety check: repair it (the repair checks it), hold it in quarantine or scrap it.'
  return null
}

/** The lines a send-back takes when none are named: every received line that may go back now. */
export const sendBackLinesOf = (lines: readonly SendBackLine[]): SendBackLine[] => lines.filter((line) => sendBackHeld(line) === null)

// ---- close with a finish reason (SAL-360) ---------------------------------------------------------------------------

export const FINISH_REASONS = ['COMPLETED', 'CREDITED_WITHOUT_RETURN', 'RETURNED_UNCHANGED', 'GOODS_NOT_RECEIVED', 'CUSTOMER_WITHDREW', 'OTHER'] as const
export type FinishReason = (typeof FINISH_REASONS)[number]

export const FINISH_REASON_WORDS: Readonly<Record<FinishReason, Words>> = Object.freeze({
  COMPLETED: { en: 'Completed: every line decided and done', it: 'Completato: ogni riga decisa ed eseguita' },
  CREDITED_WITHOUT_RETURN: { en: 'Credited without the goods coming back', it: 'Accreditato senza rientro della merce' },
  RETURNED_UNCHANGED: { en: 'Sent back to the customer as it came', it: 'Restituito al cliente tal quale' },
  GOODS_NOT_RECEIVED: { en: 'The goods never arrived', it: 'La merce non è mai arrivata' },
  CUSTOMER_WITHDREW: { en: 'The customer no longer wants the return', it: 'Il cliente ha rinunciato al reso' },
  OTHER: { en: 'Other (said in words)', it: 'Altro (spiegato a parole)' },
})

export const FINISH_LIMITS = Object.freeze({
  /** The words kept as the RMA's close reason (ReturnAuthorisation.statusReason). */
  words: 500,
})

/** The RMA may be closed from these (W2a's moves). */
export const FINISH_STATUSES: readonly ReturnStatus[] = Object.freeze(['AUTHORISED', 'RECEIVED', 'INSPECTED'])

export interface FinishLine {
  readonly seq: number
  readonly quantity: number
  readonly received: number
  readonly disposition: ReturnDisposition | null
  readonly goodsOutcome: GoodsOutcome | null
  readonly creditWithoutReturn: boolean
  /** The decided credit (minor units), null: not decided. */
  readonly creditAmount: number | null
}

export interface FinishFacts {
  readonly status: ReturnStatus
  readonly goodsDueBy: BusinessDate | null
  readonly today: BusinessDate
  readonly lines: readonly FinishLine[]
}

/** Why the RMA cannot be closed now at all (null: it can), in words. */
export function finishStateHeld(facts: FinishFacts): string | null {
  if (isFinal(facts.status)) return `The return is ${facts.status.toLowerCase()} already.`
  if (facts.status === 'REQUESTED') return 'Authorise or reject the request first.'
  const undecided = facts.lines.filter((line) => line.received > 0 && line.disposition === null)
  if (undecided.length > 0) return `Decide every received line first (line${undecided.length === 1 ? '' : 's'} ${undecided.map((line) => line.seq).join(', ')}).`
  return null
}

/** The pieces that never arrived (of lines still expecting goods: not credited without them). */
export const missingPiecesOf = (lines: readonly FinishLine[]): number => lines.reduce((sum, line) => sum + (line.creditWithoutReturn ? 0 : Math.max(0, line.quantity - line.received)), 0)

/** Why each reason does not fit the RMA's facts (null: it fits), in words. */
export function finishReasonHeld(reason: FinishReason, facts: FinishFacts): string | null {
  const decided = facts.lines.filter((line) => line.disposition !== null)
  switch (reason) {
    case 'COMPLETED':
      return decided.length > 0 ? null : 'No line is decided: nothing was done to complete.'
    case 'CREDITED_WITHOUT_RETURN':
      return facts.lines.some((line) => line.creditWithoutReturn) ? null : 'No line was credited without the goods coming back.'
    case 'RETURNED_UNCHANGED':
      return facts.lines.some((line) => goesBackUnchanged(line)) ? null : 'No line goes back to the customer as it came.'
    case 'GOODS_NOT_RECEIVED':
      return missingPiecesOf(facts.lines) > 0 ? null : 'Every piece expected arrived (or was credited without the goods).'
    case 'CUSTOMER_WITHDREW':
      return facts.lines.some((line) => (line.creditAmount ?? 0) > 0) ? 'A credit was given: the return was carried out, not withdrawn.' : null
    case 'OTHER':
      return null
  }
}

/** The reason the facts point to (the close dialog's first choice), or null when none stands out. */
export function suggestedFinish(facts: FinishFacts): FinishReason | null {
  if (finishStateHeld(facts) !== null) return null
  const decided = facts.lines.filter((line) => line.disposition !== null)
  const received = facts.lines.some((line) => line.received > 0)
  if (decided.length > 0 && decided.every((line) => line.creditWithoutReturn)) return 'CREDITED_WITHOUT_RETURN'
  if (decided.length > 0 && decided.every((line) => goesBackUnchanged(line))) return 'RETURNED_UNCHANGED'
  if (decided.length > 0) return 'COMPLETED'
  if (!received && facts.goodsDueBy !== null && facts.goodsDueBy < facts.today) return 'GOODS_NOT_RECEIVED'
  return null
}

export interface FinishOption {
  readonly reason: FinishReason
  readonly allowed: boolean
  readonly held: string | null
  readonly words: Words
}

/** Every finish reason, allowed or held with why (the close dialog's list). */
export function finishOptions(facts: FinishFacts): FinishOption[] {
  const state = finishStateHeld(facts)
  return FINISH_REASONS.map((reason) => {
    const held = state ?? finishReasonHeld(reason, facts)
    return { reason, allowed: held === null, held, words: FINISH_REASON_WORDS[reason] }
  })
}

/** The problems of a close as asked, each at its field (`body/finishReason`, `body/reason`). */
export function finishProblems(reason: FinishReason, words: string | null | undefined, facts: FinishFacts): Issue[] {
  const problems: Issue[] = []
  const held = finishReasonHeld(reason, facts)
  if (held) problems.push({ path: 'body/finishReason', message: held })
  const text = (words ?? '').trim()
  if (reason === 'OTHER' && text === '') problems.push({ path: 'body/reason', message: 'Other: say why the return is closed.' })
  if (text.length > FINISH_LIMITS.words) problems.push({ path: 'body/reason', message: `At most ${FINISH_LIMITS.words} characters.` })
  return problems
}

/** The words kept as the close reason: what was typed, else the reason's own words. */
export const finishWordsOf = (reason: FinishReason, words: string | null | undefined): string => (words ?? '').trim() || FINISH_REASON_WORDS[reason].en

// ---- a remake asked with photos (SAL-298) ---------------------------------------------------------------------------

/** The photos a remake asks for, in this order: the garment worn from the front and from the back. */
export const REMAKE_PHOTOS = ['FRONT', 'BACK'] as const
export type RemakePhoto = (typeof REMAKE_PHOTOS)[number]

export const REMAKE_LIMITS = Object.freeze({
  /** What is wrong with the fit, in the customer's words. */
  fit: 2000,
  /** The part of it kept as the line's reason words (ReturnLine.reasonNote). */
  reasonNote: 500,
})

/** The RETURN reasons a remake line takes, the first active one: the fit is a size problem, else "other" with the words. */
export const REMAKE_REASON_CODES: readonly string[] = Object.freeze(['WRONG_SIZE', 'OTHER'])

/** Where a remake may be asked on an RMA the office made (its goods not decided yet). */
export const REMAKE_STATUSES: readonly ReturnStatus[] = Object.freeze(['REQUESTED', 'AUTHORISED', 'RECEIVED'])

export const REMAKE_CHANNELS = ['OFFICE', 'PORTAL', 'LINK'] as const
export type RemakeChannel = (typeof REMAKE_CHANNELS)[number]

/** What is wrong with the fit: needed, at most REMAKE_LIMITS.fit (at `path`). */
export function fitProblems(fit: string | null | undefined, path: string): Issue[] {
  const words = (fit ?? '').trim()
  if (words === '') return [{ path, message: 'Say what is wrong with the fit.' }]
  if (words.length > REMAKE_LIMITS.fit) return [{ path, message: `At most ${REMAKE_LIMITS.fit} characters.` }]
  return []
}

/** The reason words a remake line keeps (the start of the fit words, one line). */
export const remakeReasonNote = (fit: string): string => fit.trim().replace(/\s+/g, ' ').slice(0, REMAKE_LIMITS.reasonNote)

/** The first of REMAKE_REASON_CODES the reason list holds active, or null (the office switches one on). */
export const remakeReasonOf = (active: ReadonlySet<string>): string | null => REMAKE_REASON_CODES.find((code) => active.has(code)) ?? null

const dayWords = (day: BusinessDate, locale: 'it' | 'en'): string => (locale === 'it' ? day.split('-').reverse().join('/') : day)

/** The end state's words of a remake request ("Remake request RMA-… opened. We answer by …"). */
export function remakeSentWords(number: string, answerBy: BusinessDate | null): Words {
  return answerBy
    ? { en: `Remake request ${number} opened. We answer by ${dayWords(answerBy, 'en')}.`, it: `Richiesta di rifacimento ${number} aperta. Rispondiamo entro il ${dayWords(answerBy, 'it')}.` }
    : { en: `Remake request ${number} opened. We answer within 2 working days.`, it: `Richiesta di rifacimento ${number} aperta. Rispondiamo entro 2 giorni lavorativi.` }
}

/** Why a remake may not be asked on this RMA now (null: it may), in words. */
export function remakeHeld(facts: { readonly status: ReturnStatus; readonly asked: boolean }): string | null {
  if (facts.asked) return 'A remake was asked on this return already.'
  if (!REMAKE_STATUSES.includes(facts.status)) return `The return is ${facts.status.toLowerCase()}: a remake is asked before its lines are decided.`
  return null
}
