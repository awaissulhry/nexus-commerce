'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Info, Lock, MoreHorizontal, Shirt, X } from 'lucide-react'
import { Banner, KeyValue, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { FileRow, Modal } from '../../../../../lib/i18n/ds-parts'
import type { InquiryView } from '../../api'
import { isOpen, priceText, recordHref, workingTime, type Phrase } from '../../model'
import { isPageKey, NoticeLine, StatusPill, useWords } from '../../parts'
import type { InquiryRecordActions, InquiryRecordModel } from '../../record-model'
import { LinesRead } from '../LinesEditor'
import { PaneActions } from './actions/PaneActions'
import { Closed, fromLine, MadeFrom, MailCard, ProspectFields, RecordDialogs, RequestEditor } from './sections'
// B-TH-228: what was made from it — the order and the style drafts.
import { MadeThings } from './sections'
import './pane.css'

/**
 * B-TH-217 (threads plan TH-1b; O-SAL-INQ-LIST.pane-head, .pane-thread, .pane-facts, PL2): one request beside the Incoming list,
 * read like e-mail — row 1 its identity (picture · customer — subject · the state with its waiting · who keeps it · "3 of 41" ·
 * ⋯ · ×), row 2 its actions (the host's slot: B-TH-218), then the thread as the main column (without its head: row 1 owns state,
 * owner and waiting) with the customer's own words as its first card, nobody may edit them, and Details — folded under row 2,
 * its own 320 px column once the pane is 1100 px or wider (a container query: the pane's width, not the window's). The same
 * parts make the request's full page (B-TH-219: `place="page"`). Draws its model; the container reads and acts.
 */

export interface PaneNav {
  readonly ids: readonly string[]
  readonly onGo: (id: string) => void
}

export interface PaneSlots {
  /** The thread (OfficeRecordThread with Ask for info, areas/sales/inquiries/pane/RequestThread). */
  readonly thread?: ReactNode
  /** Row 2: the actions the API allows now, ONE main button (B-TH-218). */
  readonly actions?: ReactNode
}

export interface RequestPaneProps {
  model: InquiryRecordModel
  actions?: InquiryRecordActions
  slots?: PaneSlots
  /** The list's order (J / K and "3 of 41"); null on the full page. */
  nav?: PaneNav | null
  /** × and Esc (the pane); absent on the full page. */
  onClose?: () => void
  /** The row's small preview (the list read it), when there is one. */
  picture?: string | null
  /** The company's name when the reader sees more than one (the number then carries it). */
  companyName?: string | null
  /** Someone else changed the request meanwhile: when (row 1's "Handled meanwhile" line). */
  handled?: string | null
  onNext?: () => void
  /** The menu's extra rights: privacy requests (erasure) and closing the thread. */
  rights?: { readonly erase: boolean; readonly closeThread: boolean }
  onErase?: () => void
  onCloseThread?: () => void
  place?: 'pane' | 'page'
  /** The full page's address with the list kept (`?back=`), for ⋯ Open full page. */
  fullHref?: string
  /** Design cases: Details folded open, the editor open, the phone's details sheet open. */
  detailsOpen?: boolean
  editing?: boolean
  sheetOpen?: boolean
}

const INTL = { it: 'it-IT', en: 'en-GB' } as const

/** The state pill's waiting ("New · 4 h"): the working time since it came while it waits; closed: the pill alone. */
export function waitingShort(view: Pick<InquiryView, 'waiting'>): Phrase | null {
  return view.waiting.for !== null && view.waiting.workingMinutes !== null ? workingTime(view.waiting.workingMinutes) : null
}

/** "300 pcs · 20 Jan 2027": the facts Details is labelled with (row 2). */
export function detailsLabel(view: Pick<InquiryView, 'pieces' | 'wantedDate'>, say: (phrase: Phrase) => string | null, day: (value: string | null) => string): string | null {
  const parts = [view.pieces > 0 ? say({ key: 'pane.pieces', params: { count: view.pieces } }) : null, view.wantedDate ? day(view.wantedDate) : null].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The first card shows the request's own words unless its thread already opens with them (a request sent from the portal). */
export const wordsInThread = (view: Pick<InquiryView, 'source' | 'createdBy'>): boolean => view.source === 'PORTAL' && view.createdBy === null

export function RequestPane(props: RequestPaneProps) {
  const { model, actions, onClose } = props
  const { t } = useWords()
  const view = model.loaded.status === 'ready' ? model.loaded.value : null
  if (model.loaded.status === 'loading')
    return (
      <div className="fw-rp" aria-busy="true">
        <p className="fw-inq-hint" role="status">
          {t('record.reading')}
        </p>
        <Skeleton height={40} />
        <Skeleton height={32} width="70%" />
        <Skeleton height={320} />
      </div>
    )
  if (!view) {
    const body = model.loaded.status === 'error' ? t(model.loaded.problem) : model.loaded.status === 'notFound' ? t('record.notFoundBody') : t('noAccess.body')
    return (
      <div className="fw-rp">
        <Banner
          tone={model.loaded.status === 'error' ? 'danger' : 'info'}
          title={model.loaded.status === 'notFound' ? t('record.notFoundTitle') : model.loaded.status === 'error' ? t('record.failedTitle') : t('noAccess.title')}
          action={
            <span className="fw-inq-actions">
              {model.loaded.status === 'error' && (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              )}
              {onClose && (
                <Button size="sm" variant="quiet" onClick={onClose}>
                  {t('pane.close')}
                </Button>
              )}
            </span>
          }
        >
          {body}
        </Banner>
      </div>
    )
  }
  return <Loaded {...props} view={view} />
}

function Loaded({ model, actions, slots, nav, onClose, picture, companyName, handled, onNext, rights, onErase, onCloseThread, place = 'pane', fullHref, detailsOpen, editing: editingAtStart, sheetOpen, view }: RequestPaneProps & { view: InquiryView }) {
  const { t, say } = useWords()
  const [folded, setFolded] = useState(!detailsOpen)
  const [editing, setEditing] = useState(!!editingAtStart)
  // B-TH-219: on a phone the full page keeps its details behind "i" (a bottom sheet).
  const [sheet, setSheet] = useState(!!sheetOpen)
  const latest = useRef({ nav, view })
  latest.current = { nav, view }
  useRecordKeys(model, actions)

  // J / K: the next and previous request in the list's order, from anywhere on the page but the thread's feed (its own J / K walk
  // messages), fields, menus and dialogs — they run first (capture), so the list frame's own j / k does not also move its rows.
  // Esc closes the pane from anywhere but a field, a dialog, a menu or a cell being edited (the open row's link included).
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'j' && event.key !== 'k' && event.key !== 'Escape') return
      if (!isPageKey(event)) return
      const target = event.target as HTMLElement | null
      if (target?.closest('.fw-rt-column')) return
      if (event.key === 'Escape') {
        if (place !== 'pane' || !closeRef.current || target?.closest('.ag-cell-inline-editing')) return
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
        return
      }
      const { nav: now, view: current } = latest.current
      if (!now) return
      const index = now.ids.indexOf(current.id)
      const next = event.key === 'j' ? now.ids[index + 1] : now.ids[index - 1]
      if (index < 0 || !next) return
      event.preventDefault()
      event.stopPropagation()
      now.onGo(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [place])

  const index = nav ? nav.ids.indexOf(view.id) : -1
  const label = detailsLabel(view, say, dayWords(say))
  const facts = <Details model={model} view={view} companyName={companyName ?? null} onEdit={model.can.manage && view.actions.edit.allowed ? () => setEditing(true) : undefined} />
  return (
    <div className={`fw-rp is-${place}`} data-place={place}>
      <PaneHead model={model} view={view} nav={nav ?? null} index={index} picture={picture ?? null} onClose={onClose} rights={rights} onErase={onErase} onCloseThread={onCloseThread} onEdit={model.can.manage && view.actions.edit.allowed ? () => setEditing(true) : undefined} place={place} fullHref={fullHref} onInfo={() => setSheet(true)} />
      {handled && (
        <Banner
          tone="warning"
          title={t('pane.handled', { time: handled })}
          action={
            <span className="fw-inq-actions">
              <Button size="sm" variant="quiet" onClick={() => actions?.onReload?.()}>
                {t('record.reload')}
              </Button>
              {onNext && (
                <Button size="sm" variant="quiet" onClick={onNext}>
                  {t('pane.next')}
                </Button>
              )}
            </span>
          }
        />
      )}
      {model.live === 'offline' && <Banner tone="warning" title={t('record.offline')} />}
      <NoticeLine notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <div className="fw-rp-row2">
        {/* B-TH-218: ONE main button that follows the request, the others held with their reasons. */}
        <div className="fw-rp-actions">{slots?.actions ?? <PaneActions model={model} view={view} actions={actions} onEdit={model.can.manage && view.actions.edit.allowed ? () => setEditing(true) : undefined} />}</div>
        <Button size="sm" variant="quiet" className="fw-rp-fold" aria-expanded={!folded} aria-controls={`fw-rp-details-${view.id}`} onClick={() => setFolded((now) => !now)}>
          {label ? t('pane.detailsOf', { facts: label }) : t('pane.details')} <ChevronDown size={13} aria-hidden />
        </Button>
      </div>
      {!isOpen(view.status) && <Closed view={view} />}
      <div className={`fw-rp-body${folded ? ' is-folded' : ''}`}>
        <div className="fw-rp-main">
          {!wordsInThread(view) && <FirstWords model={model} view={view} actions={actions} />}
          <div className="fw-rp-thread">{slots?.thread ?? <p className="fw-inq-hint">{model.can.thread ? t('activity.none') : t('activity.noRight')}</p>}</div>
        </div>
        <aside className="fw-rp-details" id={`fw-rp-details-${view.id}`} aria-label={t('pane.details')}>
          {facts}
        </aside>
      </div>
      {editing && <RequestEditor model={model} view={view} actions={actions} onClose={() => setEditing(false)} />}
      {sheet && (
        <Modal open sheet size="md" onClose={() => setSheet(false)} title={t('pane.details')} subtitle={`${view.number} · ${fromLine(view, t)}`}>
          {facts}
        </Modal>
      )}
      <RecordDialogs model={model} view={view} actions={actions} />
    </div>
  )
}

export type PaneMenuItem = 'full' | 'print' | 'edit' | 'erase' | 'close-thread' | 'copy'

/**
 * Row 1's ⋯ (pane-head-F02): Open full page (the pane only), Print, Edit the request (who may), "Start an erasure request…" only
 * for a privacy admin and a prospect not yet erased (C14: a customer's contact is erased from the contact), "Close thread…" only
 * with threads.manage (C5; never the pane itself: × and Esc do that), Copy number.
 */
export function paneMenu(view: Pick<InquiryView, 'prospect' | 'prospectDetails'>, place: 'pane' | 'page', rights: RequestPaneProps['rights'], canEdit: boolean): PaneMenuItem[] {
  return [
    ...(place === 'pane' ? (['full'] as const) : []),
    'print',
    ...(canEdit ? (['edit'] as const) : []),
    ...(rights?.erase && view.prospect && !view.prospectDetails?.erased ? (['erase'] as const) : []),
    ...(rights?.closeThread ? (['close-thread'] as const) : []),
    'copy',
  ]
}

/** q make quote, d decline, a assign: the open request's verbs (never while typing, in a menu, or under a dialog). */
export function useRecordKeys(model: InquiryRecordModel, actions: InquiryRecordActions | undefined) {
  const act = useRef(actions)
  act.current = actions
  const view = model.loaded.status === 'ready' ? model.loaded.value : null
  const quiet = !!model.dialog || model.busy || model.saving
  useEffect(() => {
    if (!view) return
    const onKey = (event: KeyboardEvent) => {
      if (quiet || !isPageKey(event)) return
      const target = event.target as HTMLElement | null
      if (target?.closest('.fw-rt-column')) return
      const verb = event.key === 'q' ? 'quote' : event.key === 'd' ? 'decline' : event.key === 'a' ? 'assign' : null
      if (!verb) return
      const allowed = verb === 'quote' ? view.actions.quote.allowed : verb === 'decline' ? view.actions.decline.allowed : view.actions.assign.allowed
      if (!allowed || !model.can.manage) return
      event.preventDefault()
      act.current?.onVerb?.(verb)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, quiet, model.can.manage])
}

/** A day in the page's words (through `say`, which formats a YYYY-MM-DD parameter). */
const dayWords = (say: (phrase: Phrase) => string | null) => (value: string | null) => (value ? (say({ key: 'pane.day', params: { day: value } }) ?? value) : '')

// ---- row 1: the request's identity -----------------------------------------------------------------------------------------------

function PaneHead({ model, view, nav, index, picture, onClose, rights, onErase, onCloseThread, onEdit, place, fullHref, onInfo }: { model: InquiryRecordModel; view: InquiryView; nav: PaneNav | null; index: number; picture: string | null; onClose?: () => void; rights?: RequestPaneProps['rights']; onErase?: () => void; onCloseThread?: () => void; onEdit?: () => void; place: 'pane' | 'page'; fullHref?: string; onInfo?: () => void }) {
  const { t, say } = useWords()
  const who = fromLine(view, t)
  const waiting = waitingShort(view)
  const owner = view.assignee ? (view.mine ? t('assignee.nameMe', { name: view.assignee.name }) : view.assignee.name) : t('assignee.nobody')
  const prospectErased = !!view.prospectDetails?.erased
  const make: Record<PaneMenuItem, MenuItemDef> = {
    full: { id: 'full', label: t('pane.openFull'), href: fullHref ?? recordHref(model.prefix, view.id), target: '_blank' as const },
    print: { id: 'print', label: t('pane.print'), onSelect: () => window.print() },
    edit: { id: 'edit', label: t('pane.edit.open'), onSelect: () => onEdit?.() },
    erase: { id: 'erase', label: t('pane.erase'), description: t('pane.eraseHint'), onSelect: () => onErase?.() },
    'close-thread': { id: 'close-thread', label: t('pane.closeThread'), onSelect: () => onCloseThread?.() },
    copy: { id: 'copy', label: t('record.copyNumber'), onSelect: () => void navigator.clipboard?.writeText(view.number).catch(() => undefined) },
  }
  const items = paneMenu(view, place, rights, !!onEdit).map((id) => make[id])
  return (
    <header className="fw-rp-head">
      <span className="fw-rp-pic" aria-hidden>
        {picture ? <img src={picture} alt="" /> : <Shirt size={16} />}
      </span>
      <h2 className="fw-rp-title" title={`${view.number} · ${who} — ${view.summary}`}>
        <span className="fw-rp-who">{who}</span>
        {view.prospect && !prospectErased && (
          <Tag tone="info" title={t('who.newHint')}>
            {t('who.new')}
          </Tag>
        )}
        <span className="fw-rp-sep" aria-hidden>
          —
        </span>
        <span className="fw-rp-subject">{view.summary || view.number}</span>
      </h2>
      <span className="fw-rp-state">
        <StatusPill status={view.status} />
        {waiting && <span className={view.waiting.overdue ? 'fw-rp-wait is-late' : 'fw-rp-wait'}>{say(waiting)}</span>}
      </span>
      <span className="fw-rp-owner" title={t('col.owner')}>
        {owner}
      </span>
      {nav && index >= 0 && nav.ids.length > 1 && (
        <span className="fw-rp-nav">
          <Button size="sm" variant="quiet" aria-label={t('pane.prev')} aria-keyshortcuts="k" heldReason={index === 0 ? t('pane.atFirst') : null} onClick={() => nav.ids[index - 1] && nav.onGo(nav.ids[index - 1]!)}>
            <ChevronLeft size={14} aria-hidden />
          </Button>
          <span className="fw-rp-of">{t('pane.of', { n: index + 1, total: nav.ids.length })}</span>
          <Button size="sm" variant="quiet" aria-label={t('pane.next')} aria-keyshortcuts="j" heldReason={index === nav.ids.length - 1 ? t('pane.nothingElse') : null} onClick={() => nav.ids[index + 1] && nav.onGo(nav.ids[index + 1]!)}>
            <ChevronRight size={14} aria-hidden />
          </Button>
        </span>
      )}
      <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('pane.menu', { number: view.number }) }} items={items} />
      {place === 'pane' && onClose && (
        <Button size="sm" variant="quiet" aria-label={t('pane.close')} aria-keyshortcuts="Escape" onClick={onClose}>
          <X size={16} aria-hidden />
        </Button>
      )}
      {place === 'page' && (
        <Button size="sm" variant="quiet" className="fw-rp-info" aria-label={t('pane.details')} aria-haspopup="dialog" onClick={onInfo}>
          <Info size={16} aria-hidden />
        </Button>
      )}
      {place === 'page' && (
        <Button size="sm" variant="quiet" asChild>
          <a href={recordHref(model.prefix, view.id)} target="_blank" rel="noopener noreferrer" aria-label={t('pane.newTab')}>
            <ExternalLink size={14} aria-hidden />
          </a>
        </Button>
      )}
    </header>
  )
}

// ---- the customer's own words: the thread's first card --------------------------------------------------------------------------

/**
 * The request as written (pane-thread-F01, L2-G02): the customer's words — the mail as received (the original behind "Show
 * original e-mail", sandboxed), or what the office typed from a call, a visit or a fair, marked so. Nobody edits it here: the
 * office's own changes go to the request's details, never over these words.
 */
function FirstWords({ model, view, actions }: { model: InquiryRecordModel; view: InquiryView; actions?: InquiryRecordActions }) {
  const { t, when } = useWords()
  const [original, setOriginal] = useState(false)
  const who = view.party?.name ?? view.prospectDetails?.company ?? view.prospectDetails?.name ?? view.fromWords
  const by =
    view.source === 'MAIL' || view.source === 'PORTAL'
      ? t(`pane.first.from.${view.source}`, { who })
      : view.createdBy
        ? t('pane.first.typed', { name: view.createdBy.name, source: t(`source.${view.source}`) })
        : t('pane.first.typedNobody', { source: t(`source.${view.source}`) })
  return (
    <article className="fw-rp-first" aria-label={t('pane.first.label')}>
      <header className="fw-rp-first-head">
        <span className="fw-rp-first-who">{by}</span>
        <time className="fw-rp-first-at" dateTime={view.receivedAt}>
          {when(view.receivedAt)}
        </time>
        <span className="fw-rp-first-lock" title={t('pane.first.locked')}>
          <Lock size={12} aria-hidden /> {t('pane.first.lockedShort')}
        </span>
      </header>
      <p className="fw-rp-first-text">{view.request || '—'}</p>
      {view.mail && (
        <Button size="sm" variant="link" aria-expanded={original} onClick={() => setOriginal((now) => !now)}>
          {original ? t('pane.first.hideOriginal') : t('pane.first.original')}
        </Button>
      )}
      {original && view.mail && <MailCard model={model} view={view} actions={actions} />}
    </article>
  )
}

// ---- Details ----------------------------------------------------------------------------------------------------------------------

/**
 * Details (pane-facts): their PO and ship-to, the wanted date, the quantity and the lines, the tech pack in force (picked in "Edit
 * the request", moved there from the old Files & specs tab), the target price (price grain only: absent, never empty), what was
 * made from it (the quote with ITS own status), the prospect block with its lawful basis (e-mail and phone only for who answers
 * requests, PR-30), the request note.
 */
function Details({ model, view, companyName, onEdit }: { model: InquiryRecordModel; view: InquiryView; companyName: string | null; onEdit?: () => void }) {
  const { t, day, when, locale } = useWords()
  const target = view.targetUnitPrice as string | null | undefined
  const ship = view.shipTo ?? null
  const items: { label: string; value: ReactNode }[] = [
    { label: t('pane.facts.number'), value: companyName ? `${view.number} · ${companyName}` : view.number },
    { label: t('pane.facts.received'), value: when(view.receivedAt) },
    { label: t('pane.facts.source'), value: t(`source.${view.source}`) },
    { label: t('pane.facts.wanted'), value: day(view.wantedDate) },
    { label: t('pane.facts.quantity'), value: view.pieces > 0 ? (view.sizes ? `${view.pieces} · ${view.sizes}` : String(view.pieces)) : '—' },
    ...(view.customerRef !== undefined ? [{ label: t('pane.facts.po'), value: view.customerRef ?? '—' }] : []),
    ...(view.shipTo !== undefined
      ? [
          {
            label: t('pane.facts.shipTo'),
            value: ship ? (
              <span className="fw-inq-row">
                <span>{[ship.name, ship.line1, `${ship.postalCode} ${ship.city}`, ship.country].filter(Boolean).join(', ')}</span>
                {ship.waiting && <Tag tone="warning">{t('pane.facts.shipToWaiting')}</Tag>}
              </span>
            ) : (
              '—'
            ),
          },
        ]
      : []),
    ...(model.can.price ? [{ label: t('pane.facts.target'), value: target ? priceText(target, view.currency, INTL[locale]) : '—' }] : []),
    ...(view.party ? [{ label: t('pane.facts.contact'), value: view.contact ? (view.contact.email ? `${view.contact.name} · ${view.contact.email}` : view.contact.name) : '—' }] : []),
  ]
  const draft = { request: view.request, wantedDate: view.wantedDate, targetPrice: '', currency: view.currency, note: view.note ?? '', contactId: view.contact?.id ?? null, prospect: { name: '', company: '', email: '', phone: '' }, lines: [], techPackFileIds: [], techPackVersion: '' }
  return (
    <div className="fw-rp-facts">
      <section className="fw-rp-sec">
        <div className="fw-rp-sec-head">
          <h3 className="fw-rp-h3">{t('pane.details')}</h3>
          {onEdit && (
            <Button size="sm" variant="quiet" onClick={onEdit}>
              {t('pane.edit.open')}
            </Button>
          )}
        </div>
        <KeyValue items={items} labelCase="sentence" />
      </section>
      {!view.party && (
        <section className="fw-rp-sec">
          <h3 className="fw-rp-h3">{t('pane.facts.prospect')}</h3>
          <ProspectFields model={model} view={view} draft={draft} editable={false} />
        </section>
      )}
      <section className="fw-rp-sec">
        <h3 className="fw-rp-h3">{t('pane.facts.lines')}</h3>
        <LinesRead lines={view.lines} />
      </section>
      <section className="fw-rp-sec">
        <h3 className="fw-rp-h3">{t('pack.title')}</h3>
        {view.techPack.files.length === 0 ? (
          <p className="fw-inq-hint">{t('pack.none')}</p>
        ) : (
          <div className="fw-inq-files">
            {view.techPack.version && <p className="fw-inq-hint">{t('pane.facts.packVersion', { version: view.techPack.version })}</p>}
            {view.techPack.files.map((file) => (
              <FileRow
                key={file.named.id}
                name={file.named.originalName}
                size={file.named.sizeBytes}
                status={file.current === null ? t('pack.gone') : file.newer ? t('pack.newer', { named: file.named.versionNo, current: file.current.versionNo }) : t('pack.inForce', { version: file.named.versionNo })}
                tone={file.current === null ? 'danger' : 'neutral'}
              />
            ))}
          </div>
        )}
      </section>
      <section className="fw-rp-sec">
        <h3 className="fw-rp-h3">{t('pane.facts.madeFrom')}</h3>
        {view.quote && <MadeFrom model={model} view={view} />}
        {/* B-TH-228 (pane-facts-F03): the order made straight from it and the style drafts, each with ITS own status, each opens. */}
        <MadeThings model={model} view={view} />
        {!view.quote && !view.order && (view.styleDrafts ?? []).length === 0 && <p className="fw-inq-hint">{t('pane.facts.nothingMade')}</p>}
      </section>
      {view.note && (
        <section className="fw-rp-sec">
          <h3 className="fw-rp-h3">{t('request.note')}</h3>
          <p className="fw-inq-text">{view.note}</p>
        </section>
      )}
    </div>
  )
}
