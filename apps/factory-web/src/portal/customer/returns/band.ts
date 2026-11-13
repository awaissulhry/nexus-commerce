import type { MenuItemDef } from '@nexus/ui/components'
import type { PortalBand, PortalBandAction } from '../../shell/frame'
import type { ComplaintRecord, ReturnRecord } from './api'
import { caseHref, offersCancel, stateTone, stateWords, threadTypeOf, type RecordTab } from './model'
import type { ReturnWords } from './words'

/**
 * The frame's band of each Returns & claims page (design portal.customer.returns h, rec "Return"): one builder per page,
 * used by the live page and its design cases alike. At most two actions, the primary last; the ⋯ items (the frame ends
 * them with "Ask a question"); the record's link tabs.
 */

export function listBandOf(input: {
  words: ReturnWords
  asOf: string | null
  startHeld: string | null
  onStart?: () => void
  /** B-W2b-357 (design h.more "Report a safety incident"): its words, why it waits (closed until the privacy notice), the dialog. */
  safety?: { label: string; held: string | null; onOpen: () => void } | null
}): PortalBand {
  const { t, time } = input.words
  const start: PortalBandAction = { id: 'start', label: t('band.start'), variant: 'primary', heldReason: input.startHeld, onClick: () => input.onStart?.() }
  // B-W2b-357: ⋯ › Report a safety incident (held with why while its door is closed).
  const safety = input.safety ? [{ id: 'safety', label: input.safety.label, disabled: input.safety.held !== null, ...(input.safety.held ? { description: input.safety.held } : {}), onSelect: () => input.safety?.onOpen() } as MenuItemDef] : []
  return {
    title: t('list.title'),
    status: input.asOf ? { label: t('band.updated', { time: time(input.asOf) }), tone: 'neutral' } : null,
    actions: [start],
    more: [...safety],
    keys: [
      { keys: ['/'], words: t('keys.search') },
      { keys: ['↵'], words: t('keys.open') },
    ],
  }
}

export interface ReturnBandFacts {
  /** Why "Add photos" waits (a key of the catalogue), or null. */
  photosHeld: string | null
  /** Why "Cancel this request…" waits (a key), or null. */
  cancelHeld: string | null
  /** The return instructions can be printed (tab:return-label). */
  labelHref: string | null
  /** The credit notes' PDFs (tab:credit-note). */
  creditNotes: readonly { id: string; label: string }[]
}

/** A return takes photos until we decided (design rec Request "Add photos or information while not yet decided"). */
const TAKES_PHOTOS = ['REQUESTED', 'AUTHORISED', 'RECEIVED']

/**
 * The band's references: their own first (our number is the title already). On a phone the band holds the title only —
 * the frame's RefPair would wrap letter by letter beside it; their reference stays on the Request tab and in the list.
 */
const refsOf = (yourRef: string | null, narrow: boolean) => (narrow || !yourRef ? null : { theirs: yourRef, ours: null })

const tabsOf = (words: ReturnWords, prefix: string, type: 'RETURN' | 'COMPLAINT', id: string, tab: RecordTab, photos: number) => ({
  label: words.t('tabs.label'),
  active: tab,
  items: [
    { id: 'request', label: words.t('tabs.request'), href: caseHref(prefix, type, id, 'request'), ...(photos > 0 ? { count: photos } : {}) },
    { id: 'status', label: words.t('tabs.status'), href: caseHref(prefix, type, id, 'status') },
    { id: 'messages', label: words.t('tabs.messages'), href: caseHref(prefix, type, id, 'messages') },
  ],
})

export function returnBandOf(input: {
  words: ReturnWords
  record: ReturnRecord
  tab: RecordTab
  prefix: string
  facts: ReturnBandFacts
  /** A phone-width screen (the DS's one breakpoint). */
  narrow?: boolean
  onPhotos?: () => void
  onCancel?: () => void
  onCreditNote?: (id: string) => void
}): PortalBand {
  const { t, locale } = input.words
  const { record, facts } = input
  const photos = record.request.photos.length + record.request.lines.reduce((sum, line) => sum + line.photos.length, 0)
  // The return label is the customer's move once we approved (primary); Add photos while we have not decided.
  const actions: PortalBandAction[] = [
    ...(TAKES_PHOTOS.includes(record.status)
      ? [{ id: 'photos', label: t('band.photos'), variant: facts.labelHref ? ('secondary' as const) : ('primary' as const), heldReason: facts.photosHeld ? t(facts.photosHeld) : null, onClick: () => input.onPhotos?.() }]
      : []),
    ...(facts.labelHref ? [{ id: 'label', label: t('band.label'), variant: 'primary' as const, onClick: () => window.open(facts.labelHref!, '_blank', 'noopener') }] : []),
  ]
  const more: MenuItemDef[] = [
    ...(facts.labelHref ? [{ id: 'label-tab', label: t('band.labelTab'), href: facts.labelHref, target: '_blank' as const }] : []),
    ...facts.creditNotes.map((note) => ({ id: `credit-${note.id}`, label: t('band.creditNote', { number: note.label }), onSelect: () => input.onCreditNote?.(note.id) })),
    ...(offersCancel(record) ? [{ id: 'cancel', label: t('band.cancel'), tone: 'danger' as const, disabled: facts.cancelHeld !== null, description: facts.cancelHeld ? t(facts.cancelHeld) : undefined, onSelect: () => input.onCancel?.() }] : []),
  ]
  return {
    title: t('record.titleReturn', { number: record.number }),
    back: { href: `${input.prefix}/returns`, label: t('list.title') },
    refs: refsOf(record.yourRef, input.narrow ?? false),
    status: { label: stateWords(t, locale, 'RETURN', record.state, record.words), tone: stateTone('RETURN', record.state) },
    actions,
    more,
    tabs: tabsOf(input.words, input.prefix, 'RETURN', record.id, input.tab, photos),
    ask: { type: threadTypeOf('RETURN'), id: record.id, label: record.number },
    keys: [
      { keys: ['←', '→'], words: t('keys.tabs') },
      { keys: ['Esc'], words: t('keys.close') },
    ],
  }
}

export function complaintBandOf(input: { words: ReturnWords; record: ComplaintRecord; tab: RecordTab; prefix: string; photosHeld: string | null; narrow?: boolean; onPhotos?: () => void }): PortalBand {
  const { t, locale } = input.words
  const { record } = input
  const open = record.status === 'NEW' || record.status === 'TRIAGED' || record.status === 'INVESTIGATING'
  return {
    title: t('record.titleComplaint', { number: record.number }),
    back: { href: `${input.prefix}/returns`, label: t('list.title') },
    refs: refsOf(record.yourRef, input.narrow ?? false),
    status: { label: stateWords(t, locale, 'COMPLAINT', record.state, record.words), tone: stateTone('COMPLAINT', record.state) },
    actions: open ? [{ id: 'photos', label: t('band.photos'), variant: 'primary', heldReason: input.photosHeld ? t(input.photosHeld) : null, onClick: () => input.onPhotos?.() }] : [],
    more: [],
    tabs: tabsOf(input.words, input.prefix, 'COMPLAINT', record.id, input.tab, record.request.photos.length),
    ask: { type: threadTypeOf('COMPLAINT'), id: record.id, label: record.number },
    keys: [
      { keys: ['←', '→'], words: t('keys.tabs') },
      { keys: ['Esc'], words: t('keys.close') },
    ],
  }
}
