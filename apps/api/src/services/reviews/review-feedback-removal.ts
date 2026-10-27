/**
 * Amazon seller feedback — the removal check (2026-10-27, Reviews area PR H, build spec B20 + ruling 5). Pure: it reads
 * one feedback's words and age and says whether asking Amazon to remove it may work, in plain words. It never asks
 * Amazon anything: there is no API for it (Messaging `createNegativeFeedbackRemoval` was removed from Amazon's model on
 * 2025-08-04), so the only actions are "Open Feedback Manager" (a new tab in Seller Central) and "Mark as responded" in
 * Nexus. Nexus only checks; the person asks in Feedback Manager, and Amazon decides.
 *
 * The criteria (docs/reviews/CHANNEL-FACTS.md rows 3c and 3d, per Amazon staff guidance on the Seller Forums):
 * - Amazon removes feedback that is obscene or profane, that holds personal details (e-mail, full name, phone), or
 *   whose ENTIRE comment is a product review. A comment that mixes the product and the seller's service does not qualify.
 * - A complaint only about delivery of an order Amazon fulfilled (FBA), or a late order the seller shipped on time with
 *   Buy Shipping, is struck through ("This item was fulfilled by Amazon…"), not removed.
 * - Ask within 90 days of the feedback, in Feedback Manager.
 *
 * Reading the words: a short list of stems in English, Italian, German, French and Spanish, on the comment and its
 * English translation (when Nexus has one), plus the AI's themes for the row (SHIPPING = delivery, the product themes =
 * product). It is a first look for a person, not Amazon's decision — the words always say so. Tested in
 * review-feedback-removal.vitest.test.ts.
 */

export const REMOVAL_WINDOW_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export type RemovalVerdict = 'may_qualify' | 'struck_through_not_removed' | 'does_not_qualify' | 'too_old'
export type RemovalReason =
  | 'obscene' | 'personal_details' | 'product_only' | 'fba_delivery' | 'delivery_you_shipped' | 'delivery_unknown'
  | 'mixed' | 'service' | 'unclear' | 'too_old'

export interface RemovalCheckInput {
  /** The buyer's comment as Amazon gives it. */
  text: string
  /** The comment in English, when Nexus translated it. */
  english?: string | null
  /** The AI's themes for the row (ReviewSentiment.categories), when read. */
  themes?: readonly string[] | null
  /** When the buyer left the feedback. */
  postedAt: Date | string
  /** Who shipped the order: Amazon (FBA), the seller, or unknown. */
  fulfilment?: 'amazon' | 'seller' | null
  now?: Date
}

export interface RemovalCheck {
  verdict: RemovalVerdict
  /** "May qualify", "Struck through, not removed", "Does not qualify", "Too old to ask". */
  label: string
  tone: 'info' | 'success' | 'neutral' | 'warning'
  /** The short reason ("Entirely about the product, not your service"). */
  why: string
  /** What it means and what to do, in full sentences. */
  words: string
  reasons: RemovalReason[]
  ageDays: number
  /** Days left to ask Amazon (0 when the window closed). */
  daysLeft: number
}

export const REMOVAL_LABEL: Record<RemovalVerdict, string> = {
  may_qualify: 'May qualify',
  struck_through_not_removed: 'Struck through, not removed',
  does_not_qualify: 'Does not qualify',
  too_old: 'Too old to ask',
}

const TONE: Record<RemovalVerdict, RemovalCheck['tone']> = {
  may_qualify: 'info',
  struck_through_not_removed: 'success',
  does_not_qualify: 'neutral',
  too_old: 'warning',
}

/** The last sentence of every check. */
export const REMOVAL_CAVEAT = 'Nexus only checks. You ask in Feedback Manager, and Amazon decides.'

/** The rules as a person reads them (the "How the removal check decides" list). */
export const REMOVAL_RULES: readonly string[] = [
  'You can ask Amazon to remove feedback that is obscene, contains personal details, or is entirely a product review — within 90 days, in Feedback Manager (per Amazon staff guidance).',
  'Complaints only about FBA delivery (or a late order you shipped on time with Buy Shipping) are struck through, not removed.',
  'Reply in Seller Central (Feedback Manager). Public, one reply, can’t be edited; if you delete it you can’t reply again.',
  REMOVAL_CAVEAT,
]

const PRODUCT_THEMES = new Set(['FIT_SIZING', 'DURABILITY', 'VALUE', 'DESIGN', 'QUALITY', 'SAFETY', 'COMFORT'])

/**
 * Stems matched at the start of a word ("deliver" matches "delivery"); a stem ending in "$" must be the whole word.
 * Text is compared without accents and in lower case ("verspätet" → "verspatet", "ß" → "ss").
 */
const OBSCENE = [
  'fuck', 'shit$', 'bullshit', 'asshole', 'bastard', 'bitch', 'cunt', 'wanker',
  'cazz', 'merd', 'stronz', 'vaffancul', 'fancul', 'coglion', 'puttan',
  'scheiss', 'arschloch', 'fick', 'wichser', 'hurensohn',
  'putain', 'connard', 'salope', 'encule',
  'mierda', 'joder', 'cabron', 'gilipollas', 'puta$',
]
// "Arrived" alone is not a delivery complaint ("arrived with an open seam" is about the product): only words about the
// delivery itself, or about it not arriving, count.
const DELIVERY = [
  'deliver', 'shipping', 'shipped', 'shipment', 'late$', 'delay', 'courier', 'parcel', 'package', 'tracking',
  'never received', 'not received', 'never arrived', 'not arrived', 'never came', 'lost in', 'postman', 'dispatch',
  'consegn', 'spedi', 'ritard', 'corrier', 'pacco', 'tracciament', 'mai ricevut', 'non ricevut', 'non e arrivat', 'mai arrivat',
  'liefer', 'versand', 'verschickt', 'verspatet', 'zustell', 'paket', 'nicht angekommen', 'nie angekommen', 'nie erhalten',
  'nicht erhalten', 'post$',
  'livraison', 'livre$', 'livree', 'expedi', 'colis', 'retard', 'jamais recu', 'pas recu', 'pas arrive', 'transporteur',
  'entrega', 'envio', 'enviad', 'retras', 'no llego', 'nunca llego', 'paquete', 'mensajer', 'no recibid', 'nunca recib',
]
const PRODUCT = [
  'quality', 'size', 'fit$', 'fits', 'small$', 'large$', 'broke', 'defect', 'faulty', 'material', 'seam', 'stitch',
  'zip', 'colour', 'color', 'product', 'item', 'fabric', 'leather', 'ripped', 'torn', 'cheap', 'flimsy', 'waterproof',
  'qualita', 'taglia', 'misur', 'piccol', 'grand', 'rott', 'difett', 'materiale', 'cucitur', 'cerniera', 'colore',
  'prodott', 'articol', 'tessut', 'pelle$', 'strappat', 'impermeabil',
  'qualitat', 'grosse$', 'passform', 'klein', 'gross$', 'kaputt', 'defekt', 'naht', 'reissverschluss', 'farbe', 'produkt',
  'artikel', 'stoff', 'leder', 'wasserdicht',
  'qualite', 'taille', 'petit', 'casse', 'defectueu', 'materiau', 'couture', 'fermeture', 'couleur', 'produit', 'article',
  'tissu', 'cuir', 'impermeable',
  'calidad', 'talla', 'pequen', 'roto', 'defectuos', 'costura', 'cremallera', 'producto', 'articulo', 'tela$', 'cuero',
]
const SERVICE = [
  'seller', 'vendor', 'customer service', 'refund', 'return', 'reply', 'replied', 'response', 'contact', 'rude', 'scam',
  'wrong item', 'communication', 'unhelpful', 'ignored',
  'venditor', 'rimbors', 'reso$', 'risposta', 'rispost', 'assistenza', 'truffa', 'sbagliat', 'contatt',
  'verkaufer', 'handler', 'erstattung', 'ruckgabe', 'antwort', 'kundenservice', 'kundendienst', 'betrug', 'falsch',
  'vendeur', 'rembourse', 'retour', 'reponse', 'service client', 'arnaque', 'mauvais article',
  'vendedor', 'reembolso', 'devolucion', 'respuesta', 'atencion al cliente', 'estafa', 'equivocad',
]

/** Lower case, no accents, ß as ss. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss')
}

function stemRegex(stems: readonly string[]): RegExp {
  const parts = stems.map((s) => (s.endsWith('$') ? `${escape(s.slice(0, -1))}(?![a-z])` : escape(s)))
  return new RegExp(`(?<![a-z])(?:${parts.join('|')})`, 'i')
}
function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const OBSCENE_RE = stemRegex(OBSCENE)
const DELIVERY_RE = stemRegex(DELIVERY)
const PRODUCT_RE = stemRegex(PRODUCT)
const SERVICE_RE = stemRegex(SERVICE)
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i
/** Amazon order ids ("028-1234567-1234567") are not phone numbers. */
const ORDER_ID_RE = /\b\d{3}-\d{7}-\d{7}\b/g
/** Eight or more digits, allowing spaces, dots, dashes, brackets and a leading +. */
const PHONE_RE = /(?:\+|\b)\d(?:[\s().-]?\d){7,}\b/

/** What the words of one feedback are about. Pure. */
export function readFeedbackWords(text: string, english?: string | null, themes?: readonly string[] | null): {
  obscene: boolean; personal: boolean; delivery: boolean; product: boolean; service: boolean
} {
  const raw = [text, english ?? ''].join('\n')
  const folded = foldText(raw)
  const withoutOrders = raw.replace(ORDER_ID_RE, ' ')
  const t = themes ?? []
  return {
    obscene: OBSCENE_RE.test(folded),
    personal: EMAIL_RE.test(raw) || PHONE_RE.test(withoutOrders),
    delivery: DELIVERY_RE.test(folded) || t.includes('SHIPPING'),
    product: PRODUCT_RE.test(folded) || t.some((x) => PRODUCT_THEMES.has(x)),
    service: SERVICE_RE.test(folded),
  }
}

function ageInDays(postedAt: Date | string, now: Date): number {
  const at = postedAt instanceof Date ? postedAt : new Date(postedAt)
  if (Number.isNaN(at.getTime())) return 0
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / DAY_MS))
}

function left(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`
}

/** The removal check for one Amazon seller feedback. Pure. */
export function feedbackRemovalCheck(input: RemovalCheckInput): RemovalCheck {
  const now = input.now ?? new Date()
  const ageDays = ageInDays(input.postedAt, now)
  const daysLeft = Math.max(0, REMOVAL_WINDOW_DAYS - ageDays)
  const make = (verdict: RemovalVerdict, reasons: RemovalReason[], why: string, then: string): RemovalCheck => ({
    verdict, label: REMOVAL_LABEL[verdict], tone: TONE[verdict], why, words: `${why}. ${then} ${REMOVAL_CAVEAT}`, reasons, ageDays, daysLeft,
  })

  if (ageDays > REMOVAL_WINDOW_DAYS) {
    return make('too_old', ['too_old'], `${ageDays} days old: removal requests go within ${REMOVAL_WINDOW_DAYS} days (per Amazon staff guidance)`,
      'You can still reply in Feedback Manager.')
  }
  const askWithin = `Ask Amazon in Feedback Manager within ${left(daysLeft)}.`
  const w = readFeedbackWords(input.text, input.english, input.themes)
  if (w.obscene) return make('may_qualify', ['obscene'], 'Has obscene or profane words', askWithin)
  if (w.personal) return make('may_qualify', ['personal_details'], 'Contains personal details (an e-mail address or a phone number)', askWithin)

  if (w.delivery && !w.product && !w.service) {
    if (input.fulfilment === 'amazon') {
      return make('struck_through_not_removed', ['fba_delivery'], 'Only about FBA delivery: Amazon strikes it through',
        `It stays visible, crossed out, and does not count against you. If it is not struck through yet, ask in Feedback Manager within ${left(daysLeft)}.`)
    }
    if (input.fulfilment === 'seller') {
      return make('does_not_qualify', ['delivery_you_shipped'], 'Only about the delivery of an order you shipped',
        'Amazon strikes it through only if you shipped on time with Buy Shipping; check the order in Seller Central.')
    }
    return make('does_not_qualify', ['delivery_unknown'], 'Only about delivery, and Nexus does not know who shipped the order',
      'If Amazon shipped it (FBA), or you shipped on time with Buy Shipping, Amazon strikes it through; check the order in Seller Central.')
  }
  if (w.product && !w.delivery && !w.service) {
    return make('may_qualify', ['product_only'], 'Entirely about the product, not your service', askWithin)
  }
  if (w.product && (w.delivery || w.service)) {
    return make('does_not_qualify', ['mixed'], 'Mixes the product with your service',
      'Only feedback that is entirely a product review qualifies. Reply in Feedback Manager instead.')
  }
  if (w.service) {
    return make('does_not_qualify', ['service'], 'About your service', 'Feedback about the seller stays. Reply in Feedback Manager instead.')
  }
  return make('does_not_qualify', ['unclear'], 'Nexus found nothing in it that Amazon removes',
    'Read it yourself: if it is obscene, holds personal details or is only about the product, you can still ask.')
}

/** "FBA" / "AFN" → Amazon shipped it; "FBM" / "MFN" → the seller did; anything else unknown. */
export function fulfilmentOf(method: string | null | undefined): RemovalCheckInput['fulfilment'] {
  const m = (method ?? '').trim().toUpperCase()
  if (m === 'FBA' || m === 'AFN' || m === 'AMAZON') return 'amazon'
  if (m === 'FBM' || m === 'MFN' || m === 'MERCHANT' || m === 'SELLER') return 'seller'
  return null
}
