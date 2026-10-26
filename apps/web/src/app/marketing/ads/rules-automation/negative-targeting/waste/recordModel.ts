/**
 * Negative Targeting page, the records redone (2026-10-26, RECORD-SPEC R1–R15) — every word and rule the row records
 * show, pure and tested in Node (`recordModel.vitest.test.ts`). `RowDetail.tsx` only draws what these say.
 *
 *   header    "<kind> in <campaign › ad group> · Amazon IT", the state pill (word, tone, its sentence for a screen
 *             reader) and "Looked after by …" (none when nobody looks after it)
 *   banner    the answer in one look, in the state's tone: wasting (danger), protected (info), waiting (warning), a stop
 *             that worked (success), partly (warning), too early (info) — one sentence with the main number, then what
 *             it means and what the main button does
 *   numbers   four tiles with a plain hint under each; never a code word ("Cost against target", "€0.40 a click")
 *   checks    the page's test as three checks (Orders · Clicks · Spend) with a Result each, the verdict, and where the
 *             limits come from (the server's own sentence: the conversion rate and the floor it names)
 *   saving    "How the saving is counted": a day before × the days since − what it spent since (the server's numbers)
 *   history   one sentence per change ("You removed its negative"), the why or the result as its detail, Undo only
 *             when the server says it can be undone
 *   footer    the one primary says what it does ("Add negative exact"); menus say the whole thing
 * Every number, name and day comes from what the record reads (wasteTypes.ts); a fact the API does not give is left out.
 */
import { dayWords, money, relWords, whenWords } from '../../bid/_shared/format'
import { chipOwner, isAsinText, isFinal, matchWord, moneyOr, planWords, plural, savedView, stateSentence, verbLabel, verbSentence } from './wasteModel'
import type {
  HistoryItem, Owner, Place, PreviewStep, RowKind, StoppedRow, VerbAction, WasteAction, WasteRow, Where,
} from './wasteTypes'

export type RecordTone = 'danger' | 'warning' | 'info' | 'success' | 'neutral'

/** A stopped row (the Stopped view) or a wasting one. */
export const isStoppedRow = (r: WasteRow | StoppedRow): r is StoppedRow => 'actions' in r

/** "4.10" from 4.1; "8.1" — a multiple or a rate as the record says it. */
const xNum = (x: number) => (x >= 10 ? String(Math.round(x)) : x.toFixed(1))
const sentence = (s: string) => { const t = s.trim(); return !t ? t : /[.!?]$/.test(t) ? t : `${t}.` }
const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const hasMoney = (c: number | null | undefined): c is number => typeof c === 'number' && Number.isFinite(c)
/** "−€3.00" for a saving below 0 (a real minus sign). */
const signedMoney = (cents: number, currency: string) => (cents < 0 ? `−${money(-cents, currency)}` : money(cents, currency))

// ── header ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the record is, the subtitle's lead: "Shopper's search term", "Your keyword", "Negative". */
export function kindLead(r: { id: string; kind: RowKind; match?: string; text: string }): string {
  if (r.id.startsWith('neg:')) return 'Negative'
  if (r.kind === 'TERM') return r.match === 'ASIN' || isAsinText(r.text) ? 'Product a shopper viewed' : 'Shopper\'s search term'
  if (r.kind === 'TARGET') return 'Your product target'
  return 'Your keyword'
}

/** The noun of the "About this …" card and the History line: term, keyword, target, negative. */
export function recordNoun(r: { id: string; kind: RowKind }): 'term' | 'keyword' | 'target' | 'negative' {
  if (r.id.startsWith('neg:')) return 'negative'
  return r.kind === 'TERM' ? 'term' : r.kind === 'TARGET' ? 'target' : 'keyword'
}

export type PillGlyph = 'play' | 'pause' | 'kept' | 'ban' | 'shield' | 'alert' | 'cloud' | 'hourglass' | 'none'
export interface StatePillView { word: string; tone: RecordTone; sentence: string; glyph: PillGlyph }

/** The state pill of a record: the code's state word and tone, its sentence after it for a screen reader. */
export function statePill(r: WasteRow | StoppedRow): StatePillView {
  if (isStoppedRow(r)) {
    switch (r.state) {
      case 'KEPT_PAUSED': return { word: 'Kept paused', tone: 'info', sentence: 'no rule, Brain or plan turns it on', glyph: 'kept' }
      case 'PAUSED': return { word: 'Paused', tone: 'neutral', sentence: 'paused, not kept paused', glyph: 'pause' }
      case 'NEGATED': return { word: 'Negative', tone: 'info', sentence: stateSentence(r), glyph: 'ban' }
      case 'TURNED_ON_ELSEWHERE': return { word: 'Turned on outside Nexus', tone: 'danger', sentence: 'it spends again', glyph: 'alert' }
      case 'NOT_AT_AMAZON': return { word: 'Not at Amazon', tone: 'warning', sentence: 'Amazon never took it: it blocks nothing', glyph: 'cloud' }
    }
  }
  const w = r as WasteRow
  if (w.waiting) {
    return {
      word: `Waiting · asked by ${w.waiting.by.name}`, tone: 'warning', glyph: 'hourglass',
      sentence: `Waiting for you · asked by ${w.waiting.by.name} ${relWords(w.waiting.at)}${w.waiting.expiresAt ? ` · expires ${relWords(w.waiting.expiresAt)}` : ''}`,
    }
  }
  switch (w.state) {
    case 'PROTECTED': {
      const t = w.protection?.terms ?? []
      return { word: 'Protected', tone: 'info', glyph: 'shield', sentence: t.length > 1 ? `${t.length} protected terms keep it safe` : t.length ? `"${t[0].term}" keeps it safe` : 'never negated' }
    }
    case 'TURNED_ON_ELSEWHERE': return { word: 'Turned on outside Nexus', tone: 'danger', sentence: 'kept paused, but it spends again', glyph: 'alert' }
    case 'PAUSED': return { word: 'Paused', tone: 'neutral', sentence: 'it does not spend', glyph: 'pause' }
    case 'KEPT_PAUSED': return { word: 'Kept paused', tone: 'info', sentence: 'no rule, Brain or plan turns it on', glyph: 'kept' }
    case 'NEGATED': return { word: 'Negative', tone: 'info', sentence: stateSentence(w), glyph: 'ban' }
    default:
      if (!w.d) return { word: 'No data', tone: 'neutral', sentence: 'Amazon reported nothing for it in the window', glyph: 'none' }
      return w.test.met
        ? { word: 'Wasting', tone: 'danger', sentence: 'it runs and spends', glyph: 'play' }
        : { word: 'Running', tone: 'neutral', sentence: 'not wasting by this page\'s test', glyph: 'play' }
  }
}

/** Who looks after it, in the About card's words ("Nobody" when no one does). */
export function ownerWords(o: Owner): string {
  const c = chipOwner(o)
  if (c.kind === 'NONE') return 'Nobody'
  if (c.kind === 'RULE') return (o.name ?? '').trim() ? `The rule "${o.name.trim()}"` : 'A rule'
  return c.label
}

/** The header's neutral tag: "Looked after by Brain"; null when nobody looks after it (no tag). */
export function lookedAfter(o: Owner): { label: string; title: string; ruleId: string | null } | null {
  const c = chipOwner(o)
  if (c.kind === 'NONE') return null
  const name = (o.name ?? '').trim()
  switch (c.kind) {
    case 'BRAIN': return { label: 'Looked after by Brain', title: c.locked ? 'The Brain keeps it' : 'Brain looks after the ads of this product', ruleId: null }
    case 'RULE': return { label: name ? `Looked after by the rule "${name}"` : 'Looked after by a rule', title: name ? `The rule "${name}" looks after it` : 'A rule looks after it', ruleId: c.ruleId }
    case 'HARVEST': return { label: 'Looked after by Harvest', title: 'Harvest keeps it', ruleId: null }
    case 'CLAUDE': return { label: 'Looked after by Claude', title: 'Claude looks after it', ruleId: null }
    default: return { label: `Looked after by ${c.label}`, title: `${c.label} ${c.label === 'You' ? 'look' : 'looks'} after it`, ruleId: null }
  }
}

// ── the verbs in words ──────────────────────────────────────────────────────────────────────────────────────────────

const placeWords = (where: Where | null | undefined, adGroup: string | null | undefined) => (where === 'campaign' ? 'the whole campaign' : adGroup || 'this ad group')

/** The footer's primary label for a negative: "Add negative exact" (· whole campaign); other verbs keep the code's. */
export function verbPhrase(action: WasteAction, where: Where | null | undefined, adGroup: string | null | undefined, codeLabel?: string): { label: string; sentence: string } {
  const add = (kind: string) => ({
    label: `Add negative ${kind}${where === 'campaign' && kind !== 'product' ? ' · whole campaign' : ''}`,
    sentence: `Add a negative ${kind} in ${kind === 'product' ? adGroup || 'this ad group' : placeWords(where, adGroup)}`,
  })
  if (action === 'NEGATE_EXACT') return add('exact')
  if (action === 'NEGATE_PHRASE') return add('phrase')
  if (action === 'NEGATE_ASIN') return add('product')
  return { label: codeLabel ?? verbLabel(action, where), sentence: verbSentence(action, where) }
}

/** An item of the "Other negatives" menu, the whole thing: "Negative phrase · in Auto group". */
export function otherNegativeWords(action: WasteAction, where: Where, adGroup: string | null | undefined): string {
  return `${verbLabel(action)} · in ${placeWords(where, adGroup)}`
}

/** What the main verb does, as the banner's last sentence: "A negative exact in Auto group stops it there." */
export function verbStops(action: VerbAction | WasteAction, where: Where | null | undefined, adGroup: string | null | undefined): string {
  switch (action) {
    case 'PAUSE': return 'Pause stops it and keeps it paused.'
    case 'NEGATE_EXACT': return `A negative exact in ${placeWords(where, adGroup)} stops it there.`
    case 'NEGATE_PHRASE': return `A negative phrase in ${placeWords(where, adGroup)} stops it there.`
    case 'NEGATE_ASIN': return `A negative product in ${adGroup || 'this ad group'} stops it there.`
    case 'REMOVE_NEGATIVE': return 'Remove negative… removes the negative that blocks it. Amazon archives a removed negative: it cannot come back.'
    default: return ''
  }
}

/** The quiet line of every record's footer. */
export const REVIEW_FIRST = 'Each button shows a review first. Nothing changes until you save it.'
/** The Skip menu's items. */
export const skipWords = (days: number) => `Skip ${days} days`
/** The Keep until menu's items: "Keep paused 7 days, to 2 Nov"; "Keep paused always". */
export function keepUntilWords(days: number | null, now: number = Date.now()): string {
  if (days == null) return 'Keep paused always'
  return `Keep paused ${days} days, to ${dayWords(new Date(now + days * 86_400_000).toISOString())}`
}

// ── the banner ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BannerView { tone: RecordTone; title: string; desc: string | null }

/** The most orders a row may have and still waste: the bar's ("at most 2 orders" in the server's sentence), else 0. */
export function orderLimitOf(test: Pick<WasteRow['test'], 'sentence'>): number {
  const m = /at most (\d+) orders?/.exec(test.sentence ?? '')
  return m ? Number(m[1]) : 0
}

/** Which checks are not true, in words: "the clicks are still under the limit". */
function notTrueWords(checks: readonly CheckRow[]): string | null {
  const parts = checks.filter((c) => c.holds === false).map((c) => (c.id === 'orders' ? 'it sold' : c.id === 'clicks' ? 'the clicks are still under the limit' : 'the spend is still under the limit'))
  return parts.length ? parts.join(' and ') : null
}

/** The main number in a sentence: "It spent €160.00 in 60 days and sold nothing". */
function spentTitle(r: WasteRow): string {
  const d = r.d!
  const days = r.test.windowDays
  const sold = d.orders === 0 ? 'sold nothing' : `sold only ${plural(d.orders, 'order')}`
  return hasMoney(d.spendCents) ? `It spent ${money(d.spendCents, r.currency)} in ${days} days and ${sold}` : `It got ${plural(d.clicks, 'click')} in ${days} days and ${sold}`
}

/** The ask that waits, in words: "Brain asks to add a negative phrase “rain cover” in 2 ad groups". */
export function askWords(r: WasteRow): string {
  const w = r.waiting!
  const rows = Math.max(1, w.rows ?? 1)
  const known = !(r.verb.action === 'REMOVE_NEGATIVE' && !r.askOnly)
  const a = r.verb.action
  const where = rows > 1 ? (a.startsWith('NEGATE') && r.verb.where !== 'campaign' ? `in ${plural(rows, 'ad group')}` : `in ${plural(rows, 'place')}`)
    : a.startsWith('NEGATE') ? `in ${placeWords(r.verb.where, r.adGroup?.name)}` : ''
  const what = !known ? `asks for a change to "${r.text}"`
    : a === 'PAUSE' ? `asks to pause "${r.text}"`
      : a === 'REMOVE_NEGATIVE' ? `asks to remove the negative "${r.text}"`
        : `asks to add a ${verbLabel(a).toLowerCase()} "${r.text}"`
  return [`${w.by.name} ${what}`, where].filter(Boolean).join(' ')
}

/** A Wasting-view row's banner (RECORD-SPEC R4): the answer in one look, in the state's tone. */
export function wasteBanner(r: WasteRow, mainVerb?: { action: WasteAction; where: Where | null; held: string | null } | null): BannerView {
  const days = r.test.windowDays
  if (r.waiting) {
    const w = r.waiting
    const rows = Math.max(1, w.rows ?? 1)
    return {
      tone: 'warning', title: askWords(r),
      desc: `It waits for your answer: asked ${relWords(w.at)}${w.expiresAt ? `, it expires ${relWords(w.expiresAt)}` : ''}.${rows > 1 ? ` One answer covers ${rows === 2 ? 'both places' : `all ${rows} places`}.` : ''}`,
    }
  }
  if (r.state === 'PROTECTED') {
    const n = r.protection?.terms.length ?? 0
    const noun = r.kind === 'TERM' ? 'term' : 'keyword'
    const facts = r.d ? `${hasMoney(r.d.spendCents) ? `${money(r.d.spendCents, r.currency)} in ${days} days, ` : `in ${days} days: `}${plural(r.d.clicks, 'click')}, ${plural(r.d.orders, 'order')}` : null
    const test = facts ? `By the page's test it ${r.test.met ? 'would count as wasting' : 'does not count as wasting'}: ${facts}. ` : ''
    const keeps = n > 1 ? `${n} protected terms keep it safe` : n === 1 ? `"${r.protection!.terms[0].term}" keeps it safe` : 'A protected term keeps it safe'
    const follow = r.followUp ? ` ${sentence(r.followUp.status === 'WAITING' ? 'Its protection is being removed: Nexus sends its negative once it is' : `Not stopped after the protection was removed: ${(r.followUp.why ?? 'refused').replace(/\.$/, '')}`)}` : ''
    return { tone: 'info', title: `Protected: Nexus never blocks or pauses this ${noun}`, desc: `${test}${keeps}, so to stop it the protection goes first.${follow}` }
  }
  if (r.followUp?.status === 'REFUSED') {
    return { tone: 'danger', title: 'Not stopped after the protection was removed', desc: sentence(capital((r.followUp.why ?? 'It was refused').replace(/\.$/, ''))) }
  }
  if (r.followUp?.status === 'WAITING') {
    return { tone: 'info', title: 'Its protection is being removed', desc: 'Nexus sends its negative once it is.' }
  }
  if (r.state === 'TURNED_ON_ELSEWHERE') {
    const spent = r.d && hasMoney(r.d.spendCents) ? ` In the last ${days} days it spent ${money(r.d.spendCents, r.currency)} with ${plural(r.d.orders, 'order')}.` : ''
    return { tone: 'danger', title: 'It was kept paused, but someone turned it on outside Nexus', desc: `Amazon serves it again.${spent} Pause again pauses it and keeps it paused.` }
  }
  if (r.state !== 'RUNNING') return { tone: 'info', title: capital(stateSentence(r)), desc: null }
  if (!r.d) return { tone: 'info', title: `No data in the last ${days} days`, desc: 'Amazon reported nothing for it in the window, so it is not judged.' }
  const verb = mainVerb ? (mainVerb.held ? `${verbPhrase(mainVerb.action, mainVerb.where, r.adGroup?.name).label} is held: ${sentence(mainVerb.held)}` : verbStops(mainVerb.action, mainVerb.where, r.adGroup?.name)) : ''
  const ownClash = r.clash?.kind === 'NEG_OVER_OWN_KEYWORD'
  if (r.test.met) {
    const x = r.d.xCpa
    const parts = [
      typeof x === 'number' && Number.isFinite(x) ? `That is ${xNum(x)} × your target cost per order.` : null,
      verb || null,
      r.clash ? sentence(r.clash.label) : null,
    ]
    return { tone: 'danger', title: spentTitle(r), desc: parts.filter(Boolean).join(' ') || null }
  }
  if (ownClash) return { tone: 'warning', title: capital(r.clash!.label.replace(/\.$/, '')), desc: verbStops('REMOVE_NEGATIVE', null, null) }
  const why = notTrueWords(wasteChecks(r)?.rows ?? [])
  return {
    tone: 'info', title: 'Not wasting by this page\'s test',
    desc: [why ? `In the last ${days} days ${why}, so it does not count as wasting yet.` : null, r.clash ? sentence(r.clash.label) : null].filter(Boolean).join(' ') || null,
  }
}

// ── the numbers ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MetricView { id: string; label: string; value: string; hint?: string; tone?: 'bad' | 'ok' | 'warn' }

const NO_SPEND = 'You cannot see ad spend'

/** A Wasting-view row's four tiles: Spend · Clicks · Orders · Cost against target (a waiting ask over places: Places). */
export function wasteMetrics(r: WasteRow): MetricView[] {
  const d = r.d
  const days = r.test.windowDays
  const spendKnown = !!d && hasMoney(d.spendCents)
  const stock = r.stockOutDays ? `, ${plural(r.stockOutDays, 'day')} out of stock left out` : ''
  const rows = Math.max(1, r.waiting?.rows ?? 1)
  const x = d?.xCpa
  const fourth: MetricView = r.waiting && rows > 1
    ? { id: 'places', label: 'Places', value: String(rows), hint: rows === 2 ? 'one answer for both' : `one answer for all ${rows}` }
    : {
      id: 'xcpa', label: 'Cost against target', value: typeof x === 'number' && Number.isFinite(x) ? `${xNum(x)}×` : '—',
      hint: !d ? 'nothing reported' : typeof x === 'number' && Number.isFinite(x) ? (r.test.xCpaBar ? `the limit is ${xNum(r.test.xCpaBar)}×` : undefined)
        : !spendKnown ? NO_SPEND : 'no target cost per order set',
      ...(typeof x === 'number' && r.test.xCpaBar != null && x >= r.test.xCpaBar ? { tone: 'bad' as const } : {}),
    }
  return [
    { id: 'spend', label: 'Spend', value: d ? moneyOr(d.spendCents, r.currency) : '—', hint: !d ? 'nothing reported' : spendKnown ? `last ${days} days${stock}` : NO_SPEND },
    { id: 'clicks', label: 'Clicks', value: d ? d.clicks.toLocaleString('en-IE') : '—', hint: d && hasMoney(d.cpcCents) ? `${money(d.cpcCents, r.currency)} a click` : undefined },
    { id: 'orders', label: 'Orders', value: d ? d.orders.toLocaleString('en-IE') : '—', hint: 'up to today' },
    fourth,
  ]
}

// ── the checks (the page's test) ────────────────────────────────────────────────────────────────────────────────────

export interface CheckRow {
  id: 'orders' | 'clicks' | 'spend'
  check: string
  value: string
  limit: string
  result: { tone: RecordTone; word: string }
  /** The check is true (it counts toward wasting); null when it is not known (no ad-spend permission). */
  holds: boolean | null
}
/** `column`: the table's second column, the row's own ("This term", "This keyword"). */
export interface ChecksView { title: string; verdict: string; column: string; rows: CheckRow[]; note: string }

/** Where the limits come from, then what the server's own sentence says about them. */
function limitsNote(r: WasteRow): string {
  const t = r.test
  const by = t.by
  const out = [by ? (by.id === 'strategy' ? `The limits come from ${by.name}.` : `The limits come from the rule "${by.name}".`) : 'The limits come from this page\'s default test.']
  const cr = /pooled ([\d.]+ ?%) conversion, never under (\d+)/.exec(t.sentence ?? '')
  const noCr = /no conversion rate known, never under (\d+)/.exec(t.sentence ?? '')
  if (cr) out.push(`${plural(t.clicksNeeded, 'click')} is enough for 1 order at the product's ${cr[1]} conversion (never under ${cr[2]}).`)
  else if (noCr) out.push(`${plural(t.clicksNeeded, 'click')} is the floor: no conversion rate is known for the product.`)
  if (hasMoney(t.spendBarCents)) {
    if (t.xCpaBar) out.push(`${money(t.spendBarCents, r.currency)} is ${xNum(t.xCpaBar)} × the target cost per order.`)
    else if (/fixed bar/.test(t.sentence ?? '')) out.push(`${money(t.spendBarCents, r.currency)} is a fixed limit, as there is no target cost per order for ${r.product?.name ?? 'this product'}.`)
  }
  const sold = /(\d+ search terms?) under it sold/.exec(t.sentence ?? '')
  if (sold) out.push(`${capital(sold[1])} under it sold: the wasting terms are negated instead.`)
  if (r.stockOutDays) out.push(`${capital(plural(r.stockOutDays, 'day'))} out of stock ${r.stockOutDays === 1 ? 'is' : 'are'} left out.`)
  return out.join(' ')
}

/** The page's test as three checks (RECORD-SPEC R6); null when there are no numbers (no data). */
export function wasteChecks(r: WasteRow): ChecksView | null {
  const d = r.d
  if (!d) return null
  const t = r.test
  const maxOrders = orderLimitOf(t)
  const ordersOk = d.orders <= maxOrders
  const clicksOk = d.clicks >= t.clicksNeeded
  const spendKnown = hasMoney(d.spendCents)
  const barKnown = hasMoney(t.spendBarCents)
  // Not known without the ad-spend permission (the money keys are left out); no bar at all: the spend check holds.
  const spendOk: boolean | null = !spendKnown ? null : t.spendBarCents === null ? true : !barKnown ? null : d.spendCents! >= t.spendBarCents!
  const column = r.kind === 'TERM' ? 'This term' : r.kind === 'TARGET' ? 'This target' : 'This keyword'
  const rows: CheckRow[] = [
    {
      id: 'orders', check: 'Orders', value: d.orders.toLocaleString('en-IE'), limit: plural(maxOrders, 'order'), holds: ordersOk,
      result: d.orders === 0 ? { tone: 'danger', word: 'No orders' } : ordersOk ? { tone: 'danger', word: 'Within the limit' } : { tone: 'success', word: 'Sold' },
    },
    {
      id: 'clicks', check: 'Clicks', value: d.clicks.toLocaleString('en-IE'), limit: `${plural(t.clicksNeeded, 'click')} or more`, holds: clicksOk,
      result: clicksOk ? { tone: 'danger', word: 'Past the limit' } : { tone: 'neutral', word: 'Under the limit' },
    },
    {
      id: 'spend', check: 'Spend', value: moneyOr(d.spendCents, r.currency), limit: barKnown ? `${money(t.spendBarCents!, r.currency)} or more` : '—', holds: spendOk,
      result: spendOk === null ? { tone: 'neutral', word: 'Not shown' } : spendOk ? { tone: 'danger', word: 'Past the limit' } : { tone: 'neutral', word: 'Under the limit' },
    },
  ]
  const trueCount = rows.filter((c) => c.holds === true).length
  const sold = /(\d+ search terms?) under it sold/.exec(t.sentence ?? '')
  const verdict = t.met ? `All 3 checks are true in the last ${t.windowDays} days`
    : trueCount === 3 && sold ? `All 3 checks are true, but ${sold[1]} under it sold: not wasting`
      : r.waiting ? `${trueCount} of 3 checks are true: not wasting by this page's test`
        : `${trueCount} of 3 checks are true: not wasting yet`
  const title = t.met ? (r.state === 'PROTECTED' ? 'Why it would count as wasting' : 'Why it counts as wasting') : 'This page\'s test'
  const lead = r.waiting && !t.met ? `${r.waiting.by.name} asked by its own test, not by this page's${notTrueWords(rows) ? `: here ${notTrueWords(rows)}` : ''}. ` : ''
  return { title, verdict, column, rows, note: `${lead}${limitsNote(r)}` }
}

// ── a waiting ask: what Approve does ────────────────────────────────────────────────────────────────────────────────

/** "What Approve does": the ask's change at this row, and what Approve and Reject do (the decide review's own rules). */
export function approveView(r: WasteRow): { desc: string; change: string; now: string; after: string; others: number; foot: string } | null {
  const w = r.waiting
  if (!w) return null
  const rows = Math.max(1, w.rows ?? 1)
  const a = r.verb.action
  const known = !(a === 'REMOVE_NEGATIVE' && !r.askOnly)
  const noun = r.kind === 'TERM' ? 'term' : r.kind === 'TARGET' ? 'target' : 'keyword'
  const places = rows === 1 ? `in ${placeWords(r.verb.where, r.adGroup?.name)}` : rows === 2 ? 'in both places' : `in all ${rows} places`
  const desc = !known ? `It runs the change ${w.by.name} asked for` : a === 'PAUSE' ? `It pauses "${r.text}" and keeps it paused`
    : a === 'REMOVE_NEGATIVE' ? `It removes the negative "${r.text}": Amazon archives it, final`
      : `It adds the ${verbLabel(a).toLowerCase()} "${r.text}" ${places}, so the ${noun} stops there`
  const card = w.approvalId.startsWith('suggestion:')
  return {
    desc,
    change: known ? `${verbLabel(a, a === 'PAUSE' || a === 'NEGATE_ASIN' || a === 'REMOVE_NEGATIVE' ? null : r.verb.where)} · ${r.text}` : r.text,
    now: r.state === 'RUNNING' ? 'Running' : capital(stateSentence(r)),
    after: !known ? 'Approved' : a === 'PAUSE' ? 'Kept paused' : a === 'REMOVE_NEGATIVE' ? 'Removed' : 'Blocked',
    others: rows - 1,
    foot: `Approve shows the review first. After you approve, you can undo it for a short time. ${card ? 'Reject sends nothing; its Undo brings it back to waiting.' : 'Reject sends nothing, and the request does not come back.'}${w.plan ? ` ${planWords(w.plan)}: Approve and Reject decide every step together.` : ''}`,
  }
}

// ── a stop: did it work? ────────────────────────────────────────────────────────────────────────────────────────────

/** The places where a stopped row's words still spend (Where it runs, not this row). */
export const stillSpendsPlaces = (r: Pick<StoppedRow, 'id'>, runsIn: readonly Place[] | null | undefined): Place[] =>
  (runsIn ?? []).filter((p) => p.rowId !== r.id && p.state === 'RUNNING')

/** A stopped row's banner: "Did it work?" — success when it saved, warning when part still spends, info too early. */
export function stoppedBanner(r: StoppedRow, others: readonly Place[] = []): BannerView {
  if (r.state === 'TURNED_ON_ELSEWHERE') return { tone: 'danger', title: 'Someone turned it on outside Nexus', desc: 'It was kept paused, but Amazon serves it again. Pause again pauses it and keeps it paused.' }
  if (r.state === 'NOT_AT_AMAZON') return { tone: 'warning', title: 'Amazon never took it: it blocks nothing', desc: r.sinceWhy ? sentence(r.sinceWhy) : null }
  const e = r.effect
  if (!e) return { tone: 'info', title: 'Not known yet whether it worked', desc: sentence(savedView(r).hint) }
  if (e.verdict === 'TOO_EARLY') return { tone: 'info', title: 'Too early to tell', desc: sentence(e.words) }
  if (!hasMoney(e.savedCents)) return { tone: 'info', title: capital(e.words), desc: null }
  const saved = e.savedCents
  const facts = hasMoney(e.beforePerDayCents) && hasMoney(e.afterCents) ? `Before the stop it cost ${money(e.beforePerDayCents, r.currency)} a day here, and ${money(e.afterCents, r.currency)} since.` : null
  if (e.verdict === 'STILL_SPENDS') {
    const n = r.stillServesIn || others.length
    const where = n ? `in ${plural(n, 'other ad group')}` : 'elsewhere'
    const first = others[0]
    const there = first?.d ? `The same words still spend in ${first.adGroup?.name ?? first.campaign.name}: ${moneyOr(first.d.spendCents, r.currency)} and ${plural(first.d.orders, 'order')}.` : null
    const fix = others.some((p) => p.rowId?.startsWith('term:')) ? 'A negative exact there stops the rest; its button is on the Where it runs tab.' : null
    return {
      tone: 'warning',
      title: saved > 0 ? `It saved ${money(saved, r.currency)} so far, but its words still spend ${where}` : `It saved nothing so far, and its words still spend ${where}`,
      desc: [facts, there, fix].filter(Boolean).join(' ') || null,
    }
  }
  if (saved > 0) return { tone: 'success', title: `It saved ${money(saved, r.currency)} so far`, desc: facts }
  if (saved < 0) return { tone: 'warning', title: `It spends more here than before: ${signedMoney(saved, r.currency)}`, desc: [sentence(e.words), facts].filter(Boolean).join(' ') }
  return { tone: 'warning', title: 'It saved nothing so far', desc: sentence(e.words) }
}

/** A stopped row's four tiles: Saved so far · Before the stop · After the stop · Stopped since. */
export function stoppedMetrics(r: StoppedRow): MetricView[] {
  const e = r.effect
  const v = savedView(r)
  const counted = e && e.verdict !== 'TOO_EARLY'
  const here = r.level === 'CAMPAIGN' ? 'in the whole campaign' : 'in this ad group'
  return [
    { id: 'saved', label: 'Saved so far', value: v.text, hint: !e ? 'not known' : e.verdict === 'TOO_EARLY' ? e.words : here, ...(v.tone === 'ok' ? { tone: 'ok' as const } : v.tone === 'warn' ? { tone: 'warn' as const } : {}) },
    // Before a saving is counted, the tile still says what it spent before the stop (the row's own 30 days), never "not known".
    counted
      ? { id: 'before', label: 'Before the stop', value: moneyOr(e!.beforePerDayCents, r.currency), hint: hasMoney(e!.beforePerDayCents) ? 'a day, before the stop' : 'not known yet' }
      : { id: 'before', label: 'Before the stop', value: moneyOr(r.spendBeforeCents, r.currency), hint: hasMoney(r.spendBeforeCents) ? 'in the 30 days before the stop' : 'not known yet' },
    { id: 'after', label: 'After the stop', value: counted ? moneyOr(e!.afterCents, r.currency) : '—', hint: counted && hasMoney(e!.afterCents) ? 'spent here since the stop' : 'not known yet' },
    { id: 'since', label: 'Stopped since', value: dayWords(r.since), hint: r.since ? relWords(r.since) : r.sinceWhy ?? 'not on record' },
  ]
}

/** "How the saving is counted" — the server's numbers in their sum; null until there is a saving to count. */
export function savingSum(r: StoppedRow): { rows: Array<{ id: string; part: string; value: string; how: string }>; note: string } | null {
  const e = r.effect
  if (!e || e.verdict === 'TOO_EARLY' || !hasMoney(e.savedCents) || !hasMoney(e.beforePerDayCents) || !hasMoney(e.afterCents)) return null
  const day = dayWords(e.since)
  const place = r.level === 'CAMPAIGN' ? 'this campaign' : 'this ad group'
  return {
    rows: [
      { id: 'before', part: 'A day before the stop', value: money(e.beforePerDayCents, r.currency), how: `Its spend in ${place} in the days before ${day}, a day` },
      { id: 'after', part: 'Spent since the stop', value: money(e.afterCents, r.currency), how: `In ${place}, since ${day}` },
      { id: 'saved', part: 'Saved', value: signedMoney(e.savedCents, r.currency), how: `${money(e.beforePerDayCents, r.currency)} a day × the days since − ${money(e.afterCents, r.currency)}` },
    ],
    note: `It counts ${place} only.${e.verdict === 'STILL_SPENDS' ? ' Its words still spend elsewhere, so the answer is amber, not green.' : ''} ${sentence(e.words)}`,
  }
}

// ── the spend per week ──────────────────────────────────────────────────────────────────────────────────────────────

/** The trend card's line: "Last 8 weeks · up from €14.20 to €21.80"; this week's spend. */
export function sparkWords(values: readonly number[], currency: string): { desc: string; thisWeek: string } | null {
  const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n))
  if (!v.length) return null
  const first = v[0]
  const last = v[v.length - 1]
  // "Flat" only when every week is the same; the same first and last week with a change between them says the range.
  const move = v.every((n) => n === first) ? `flat at ${money(last, currency)}`
    : first === last ? `between ${money(Math.min(...v), currency)} and ${money(Math.max(...v), currency)}`
      : `${last > first ? 'up' : 'down'} from ${money(first, currency)} to ${money(last, currency)}`
  return { desc: `Last ${plural(values.length, 'week')} · ${move}`, thisWeek: money(last, currency) }
}

// ── History (the DS Timeline) ───────────────────────────────────────────────────────────────────────────────────────

export interface HistoryStepView {
  key: string
  /** Who did what, one sentence: "You removed its negative". */
  label: string
  tone: RecordTone
  /** The why or the result, in a sentence; null when there is nothing to add. */
  detail: string | null
  undo: boolean
  /** The Undo button's accessible name. */
  undoLabel: string
}

/** Who, as the sentence starts: You · Brain · Claude · Harvest · a rule's name; "Someone" when not known. */
const whoOf = (by: { name: string }) => { const n = (by.name ?? '').trim(); return !n || /^unknown$/i.test(n) ? 'Someone' : n }

const DELIVERY_NOTE: Readonly<Record<string, string>> = {
  WAITING: 'It waits for approval.', SENT: 'Sent to Amazon.', UNDONE: 'Undone since.', FAILED: 'It did not go through.', CANCELLED: 'Cancelled before it ran.',
}

/** What a change did, after its who: "removed its negative", "skipped it until 26 Oct", "could not turn it on". */
function changeWhat(action: string, kind: RowKind, why: string | null): string {
  switch (action) {
    case 'paused': return 'paused it'
    case 'kept': return 'kept it paused'
    case 'released': return 'released the lock'
    case 'turned_on': return 'turned it on'
    case 'archived': return 'archived it'
    case 'negated': return 'added a negative'
    case 'removed': return 'removed its negative'
    case 'skipped': { const m = SKIP_WHY.exec((why ?? '').trim()); return m ? `skipped it until ${m[1]}` : 'skipped it' }
    case 'refused': return /not turned on/i.test(why ?? '') ? 'could not turn it on' : kind === 'TERM' ? 'could not add a negative' : 'could not make the change'
    default: return action.replace(/_/g, ' ')
  }
}
/** The server's skip words: "Skipped until 26 Oct; unskipped 21 Oct, 09:30 by You." */
const SKIP_WHY = /^Skipped until ([^;:]+?)\s*[;:]\s*(.*)$/s

/** One change as a Timeline step (RECORD-SPEC R9). */
export function historyStep(it: HistoryItem, index = 0): HistoryStepView {
  const label = `${whoOf(it.by)} ${changeWhat(it.action, it.kind, it.why)}`
  const skip = it.action === 'skipped' ? SKIP_WHY.exec((it.why ?? '').trim()) : null
  const notOn = it.action === 'refused' && /not turned on/i.test(it.why ?? '')
  const why = it.action === 'skipped' ? (skip ? (skip[2].trim() ? sentence(capital(skip[2].trim())) : null) : it.why ? sentence(it.why) : null)
    : notOn ? null : it.why ? sentence(capital(it.why)) : null
  const delivery = it.action === 'refused' ? null : DELIVERY_NOTE[it.delivery] ?? null
  const undoNote = !it.undo.available && it.action !== 'skipped' && it.undo.why ? sentence(it.undo.why) : null
  const failed = it.action === 'refused' || it.delivery === 'FAILED' || it.delivery === 'REFUSED'
  const tone: RecordTone = failed ? 'danger' : it.delivery === 'WAITING' ? 'warning'
    : it.action === 'negated' && (it.delivery === 'LIVE' || it.delivery === 'SENT') ? 'success'
      : it.action === 'removed' || it.action === 'turned_on' ? 'info' : 'neutral'
  return {
    key: `${index}:${it.changeId ?? it.changeSetId ?? it.at}`,
    label, tone,
    detail: [why, delivery, undoNote].filter(Boolean).join(' ') || null,
    undo: it.undo.available,
    undoLabel: `Undo: ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
  }
}

/** The About card's "Last change": who did what, and when ("2 Oct · 23 d ago"). */
export function lastChangeWords(c: { action: string; at: string; by: { name: string } } | null | undefined, kind: RowKind, now: number = Date.now()): { value: string; hint: string } | null {
  if (!c) return null
  return { value: `${whoOf(c.by)} ${changeWhat(c.action, kind, null)}`, hint: `${dayWords(c.at)} · ${relWords(c.at, now)}` }
}

/** "26 Oct, 07:00" and "2 h ago" — an ask's time. */
export const askedWords = (iso: string, now: number = Date.now()) => ({ value: whenWords(iso), hint: relWords(iso, now) })

/** The intro line of History. */
export const historyIntro = (noun: string, undoable: boolean) =>
  `Every change to this ${noun} in the last 90 days, newest first.${undoable ? ' A change you can still undo has an Undo button.' : ''}`

// ── Where it runs ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A place's state pill: Wasting for this record when it wastes, else the place's own state (Running is neutral). */
export function placePill(p: Pick<Place, 'state' | 'rowId'>, current: WasteRow | StoppedRow): { word: string; tone: RecordTone } {
  if (p.rowId === current.id && !isStoppedRow(current) && current.state === 'RUNNING' && current.test.met && current.d) return { word: 'Wasting', tone: 'danger' }
  switch (p.state) {
    case 'RUNNING': return { word: 'Running', tone: 'neutral' }
    case 'PAUSED': return { word: 'Paused', tone: 'neutral' }
    case 'KEPT_PAUSED': return { word: 'Kept paused', tone: 'info' }
    case 'PROTECTED': return { word: 'Protected', tone: 'info' }
    case 'NEGATED': return { word: 'Negative', tone: 'info' }
    default: return { word: 'Not at Amazon', tone: 'neutral' }
  }
}

/** A blocking negative in words: "Negative exact", "Negative phrase", "Negative product". */
export const negativeWords = (match: Place['match']) => `Negative ${matchWord(match).toLowerCase()}`

/** Who added a negative (the Blocked here table): Brain, You, the rule's name; a dash when nobody is known. */
export function addedByWords(o: Owner): string {
  const c = chipOwner(o)
  if (c.kind === 'NONE') return '—'
  return c.kind === 'RULE' ? ((o.name ?? '').trim() || 'A rule') : c.label
}

/** Where it runs: the intro line and each list's line. */
export function whereWords(r: WasteRow | StoppedRow): { intro: string; spends: string; blocked: string } {
  const term = r.kind === 'TERM' && !r.id.startsWith('neg:')
  const days = isStoppedRow(r) ? null : r.test.windowDays
  const tail = days ? ` Last ${days} days.` : ''
  return term
    ? { intro: `Where this search term spends, and where a negative already blocks it.${tail}`, spends: 'Shoppers who searched it saw your ad here', blocked: 'A negative stops your ad for this search here' }
    : { intro: `Where the words of this ${recordNoun(r)} still spend, and where a negative blocks them.${tail}`, spends: 'Shoppers who search these words still see your ad here', blocked: 'A negative stops your ad for these words here' }
}

// ── the review's Done, once a removal's 20 s window ended ──────────────────────────────────────────────────────────

/** The DS review's result of one step (`ReviewResult`). */
export interface StepResult { ok: boolean; words: string; verb?: string }

/**
 * A removed negative is final once its 20 s window ends (the approved words fix, 2026-10-26): the line says so, and so
 * do the rows and the count — "Archived at Amazon" ("1 archived"), a step sent with it "Sent", never "1 sending" or
 * "Archiving at Amazon" any more. A result that is not sending (saved in Nexus, left out, stopped) stays as it is.
 */
export function ranResult(step: Pick<PreviewStep, 'action' | 'final' | 'lands' | 'refusal'>, cur: StepResult | undefined): StepResult | undefined {
  if (!cur || !cur.ok || step.refusal || cur.verb !== 'sending') return cur
  return isFinal(step) ? { ok: true, words: 'Archived at Amazon', verb: 'archived' } : { ok: true, words: 'Sent', verb: 'sent' }
}
