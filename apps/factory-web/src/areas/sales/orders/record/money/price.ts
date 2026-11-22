import type { Order } from '../../api'
import { amendHeld } from '../../daily-model'
import type { OrderAbilities, Phrase, Tone } from '../../model'
import { whoName, type PriceCheck, type PriceCheckLine } from '../../price-check/api'
import { isClosedOrder } from '../../price-check/model'
import { customerUnitOf, historyHref, isEmptyCheck, sourceLinesOf, totalPiecesOf, type SourceLine } from '../price-check-card'
import { word, type MoneyWord } from './word'

/**
 * F-OM-301 (order MONEY tab, 10-design §7; 18-lead-settles L3) — section 4, Price check (#price-check), pure: our price beside the
 * customer's own (their PO, their portal, or typed by us), line by line, without VAT, to the cent. The section is HIDDEN without the
 * price grain (the tab's head says the money wall once: no line here, no read).
 *
 *   head      ONE line: "= Prices equal · 4 lines · from the customer's PO" (folded: Show the lines) · "≠ Not equal · 1 line ·
 *             +€ 120.00 we ask more" (the differing lines first, "Show all N lines") · "≠ Not equal · Accepted by hand · …" ·
 *             "— No customer price yet · type the prices from their PO, or they type them in their portal."
 *   doors     ≤ 3: Customer's price… (orders.manage + price — unchanged, L3; the primary while there is none) · Change our price ›
 *             (orders.manage; on the FIRST differing line, held by the amendment's own rule) · ⋯ Accept the difference… / Undo the
 *             acceptance… (orders.moneyPlan + price: the Owner and Finance, L3; only once the server knows acceptance, B-OM-020) ·
 *             History › (audit.read). Hidden without the right; held with words only by the order's state (closed or cancelled).
 *   lines     Line · Pieces · Our amount ("92.00 /pc · From the price list / Set by hand / Changed since the quote", B-OM-006) ·
 *             Customer's amount · Check · Difference ("we ask more")
 */

export type PriceCheckState = 'none' | 'partial' | 'equal' | 'notEqual' | 'accepted'

export interface PriceTag {
  readonly word: MoneyWord
  readonly tone: Tone
}

export interface PriceLineRow {
  readonly id: string
  readonly seq: number
  readonly label: string
  readonly pieces: number
  /** Our line net (minor units) and our unit price (a decimal string). */
  readonly ours: number
  readonly ourUnit: string
  /** Where our price came from (B-OM-006); null: the read does not say. */
  readonly ourSource: MoneyWord | null
  /** The customer's amount for the line (minor units); null: none yet. */
  readonly theirs: number | null
  /** The customer's unit price (a decimal string); null: their line total (`theirLineTotal`), or none. */
  readonly theirUnit: string | null
  readonly theirLineTotal: boolean
  /** null: the line is not checked (no pieces, or free with no customer price). */
  readonly check: PriceTag | null
  /** Ours − the customer's (+ we ask more); null: the customer's is not known. */
  readonly diff: number | null
  readonly differs: boolean
}

/** A door: shown (its right held), held in words only by the order's state. */
export interface PriceDoor {
  readonly held: MoneyWord | null
}

export interface PriceCheckView {
  readonly state: PriceCheckState
  /** The head's tags ("= Prices equal" · "≠ Not equal" + "Accepted by hand"), then its words, one after the other (" · "). */
  readonly tags: readonly PriceTag[]
  readonly answer: readonly MoneyWord[]
  /** Folded at first (equal prices: Show the lines). */
  readonly folded: boolean
  readonly rows: readonly PriceLineRow[]
  /** The rows shown before "Show all N lines": the differing ones while prices differ; every row otherwise. */
  readonly first: readonly PriceLineRow[]
  readonly total: { readonly pieces: number; readonly ours: number; readonly theirs: number | null; readonly check: PriceTag; readonly lines: number; readonly diff: number | null }
  /** "Accepted by Alex Demo, 19 Nov" and its reason (office only: the section is the price grain's). */
  readonly accepted: { readonly words: MoneyWord; readonly reason: string | null } | null
  readonly sources: readonly SourceLine[]
  /** Customer's price… — `primary` while there is none yet. */
  readonly edit: (PriceDoor & { readonly primary: boolean }) | null
  /** Change our price › — Lines at the first differing line, the price box focused. */
  readonly change: (PriceDoor & { readonly lineId: string | null }) | null
  readonly accept: PriceDoor | null
  readonly undoAccept: PriceDoor | null
  /** History ›: the audit of this order's customer prices (audit.read); null: no right. */
  readonly history: string | null
}

const SOURCE_WORD = { LIST: 'moneyTab.price.source.LIST', MANUAL: 'moneyTab.price.source.MANUAL', UNKNOWN: 'moneyTab.price.source.UNKNOWN' } as const

const phraseWord = (phrase: Phrase): MoneyWord => (phrase.params ? word(phrase.key, { params: phrase.params }) : word(phrase.key))

/** A check in words and tone (never colour alone: the words carry the mark, "=" or "≠"). */
export function checkTagOf(match: PriceCheckLine['priceMatch']): PriceTag | null {
  if (match === 'EQUAL') return { word: word('moneyTab.price.check.EQUAL'), tone: 'success' }
  if (match === 'NOT_EQUAL') return { word: word('moneyTab.price.check.NOT_EQUAL'), tone: 'warning' }
  if (match === 'NO_BRAND_PRICE') return { word: word('priceCheck.NO_BRAND_PRICE'), tone: 'neutral' }
  return null
}

/** "+€ 120.00 we ask more" / "−€ 10.00 we ask less"; null: the same, or not known. */
export function diffWordOf(diff: number | null | undefined): MoneyWord | null {
  if (diff === null || diff === undefined || diff === 0) return null
  return diff > 0 ? word('moneyTab.price.answer.more', { money: { amount: diff } }) : word('moneyTab.price.answer.less', { money: { amount: -diff } })
}

/** Where the customer's prices came from, said in the head when ONE source gave them all ("from the customer's PO"). */
function fromWordOf(sources: readonly SourceLine[]): MoneyWord | null {
  if (sources.length !== 1) return null
  const source = sources[0]!
  if (source.source === 'CUSTOMER_PO') return source.file ? word('moneyTab.price.from.CUSTOMER_PO_FILE', { params: { file: source.file.name } }) : word('moneyTab.price.from.CUSTOMER_PO')
  return word(`moneyTab.price.from.${source.source}`)
}

export function priceCheckOf(input: { readonly check: PriceCheck; readonly order: Order; readonly can: OrderAbilities; readonly prefix: string; readonly canHistory: boolean; readonly taking?: boolean }): PriceCheckView {
  const { check, order, can, prefix, canHistory } = input
  const total = check.total
  const rows: PriceLineRow[] = [...check.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({
      id: line.lineId,
      seq: line.seq,
      label: line.label,
      pieces: line.pieces,
      ours: line.ourAmount,
      ourUnit: line.ourUnitPrice,
      ourSource: line.ourPriceSource ? word(SOURCE_WORD[line.ourPriceSource]) : null,
      theirs: line.brandAmount,
      theirUnit: customerUnitOf(line),
      theirLineTotal: !!line.row && customerUnitOf(line) === null,
      check: checkTagOf(line.priceMatch),
      diff: line.priceDiff,
      differs: line.priceMatch === 'NOT_EQUAL',
    }))
  const checked = rows.filter((row) => row.check !== null).length
  const accepted = check.accepted ?? null
  const empty = isEmptyCheck(check)
  const state: PriceCheckState = empty ? 'none' : total.priceMatch === 'EQUAL' ? 'equal' : total.priceMatch === 'NOT_EQUAL' ? (accepted ? 'accepted' : 'notEqual') : 'partial'
  const sources = sourceLinesOf(check)

  // ---- the head's one line ----
  const tags: PriceTag[] = []
  const answer: MoneyWord[] = []
  if (state === 'none') {
    tags.push({ word: word('moneyTab.price.tag.none'), tone: 'neutral' })
    answer.push(word('moneyTab.price.answer.none'))
  } else if (state === 'equal') {
    tags.push({ word: word('moneyTab.price.tag.equal'), tone: 'success' })
    answer.push(word('priceCheck.lines', { params: { count: checked } }))
    const from = fromWordOf(sources)
    if (from) answer.push(from)
  } else if (state === 'partial') {
    tags.push({ word: word('moneyTab.price.tag.partial'), tone: 'neutral' })
    answer.push(word('priceCheck.card.missing', { params: { missing: total.priceMissingLines, lines: check.lines.length } }))
    if (total.priceNotEqualLines > 0) answer.push(word('moneyTab.price.answer.differ', { params: { count: total.priceNotEqualLines } }))
  } else {
    tags.push({ word: word('moneyTab.price.tag.notEqual'), tone: 'warning' })
    if (state === 'accepted') tags.push({ word: word('moneyTab.price.tag.accepted'), tone: 'info' })
    answer.push(word('priceCheck.lines', { params: { count: total.priceNotEqualLines } }))
    const diff = diffWordOf(total.priceDiff)
    if (diff) answer.push(diff)
  }

  // ---- the doors: each only with its right; held only by the order's state ----
  const closed = isClosedOrder(check.status)
  const closedWords = closed ? word('priceCheck.closed') : null
  const edit: PriceCheckView['edit'] = can.manage
    ? { primary: state === 'none', held: closedWords ?? (input.taking ? word('priceCheck.card.taking') : !check.mayWrite.allowed ? word('held.noManage') : null) }
    : null
  const firstDiffering = rows.find((row) => row.differs) ?? null
  const changeHeld = amendHeld(order, can)
  const change: PriceCheckView['change'] = can.manage && firstDiffering ? { lineId: firstDiffering.id, held: changeHeld ? phraseWord(changeHeld) : null } : null
  // B-OM-020: only once the read names acceptance (`accepted` present, null or a row); a difference needs both nets known.
  const knowsAccept = check.accepted !== undefined && !!can.moneyPlan && can.price
  const accept: PriceCheckView['accept'] = knowsAccept && state === 'notEqual' && total.brandPrice !== null ? { held: closedWords } : null
  const undoAccept: PriceCheckView['undoAccept'] = knowsAccept && state === 'accepted' ? { held: closedWords } : null

  const by = accepted ? whoName(accepted.by) : null
  return {
    state,
    tags,
    answer,
    folded: state === 'equal',
    rows,
    first: state === 'notEqual' || state === 'accepted' ? rows.filter((row) => row.differs) : rows,
    total: { pieces: totalPiecesOf(check), ours: total.ourPrice, theirs: total.brandPrice, check: checkTagOf(total.priceMatch) ?? { word: word('priceCheck.NO_BRAND_PRICE'), tone: 'neutral' }, lines: total.priceNotEqualLines, diff: total.priceDiff },
    accepted: accepted ? { words: by ? word('moneyTab.price.acceptedBy', { params: { name: by }, instants: { date: accepted.at } }) : word('moneyTab.price.acceptedOn', { instants: { date: accepted.at } }), reason: accepted.reason ?? null } : null,
    sources,
    edit,
    change,
    accept,
    undoAccept,
    history: canHistory ? historyHref(prefix, order.id) : null,
  }
}

/** What Accept the difference… sends: the nets as read (a check that moved meanwhile is refused and read again). */
export function acceptBodyOf(check: Pick<PriceCheck, 'total'>, reason: string): { readonly ourNet: number; readonly brandNet: number; readonly reason: string } | null {
  if (check.total.brandPrice === null) return null
  return { ourNet: check.total.ourPrice, brandNet: check.total.brandPrice, reason: reason.trim() }
}
