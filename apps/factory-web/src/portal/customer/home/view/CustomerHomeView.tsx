'use client'

import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { AlertCircle, Clock, FilePen, FileText, History, Lock, MessageSquare, PackageOpen, PenLine, Search, Sparkles } from 'lucide-react'
// B-TH-253: a project row's mark.
import { FolderKanban } from 'lucide-react'
import { Banner, Card, DetailPopover, MetricStrip, ProgressBar, type Metric } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { Button, Input, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { FileRow, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { SearchGroupRow } from '../../../shell/view/SearchView'
import type { DocumentRow, NextOrderRow, Tile } from '../model'
// B-TH-238: the Messages card.
import { messagesEmpty, type MessageRow, type MessagesCard } from '../model'
import { useHomeWords } from '../words'
import { ApproveDialog, type ApproveActions, type ApproveDialogModel } from './ApproveDialog'
import { DocumentPreview, type DocumentPreviewActions, type DocumentPreviewModel } from '../../documents/preview/view/DocumentPreview'
import '../customer-home.css'

/**
 * SCR-183 — the customer's Home (design portal.customer.home; SAL-063, SAL-084, SAL-086): Find anything first (on a phone
 * too, never behind an icon), What waits for you (the frame's one task list, passed in as `tasks`, the verb in the row),
 * five numbers at a glance that are links to their lists, the next five deliveries by promise, the documents new since
 * the last visit, the Messages card (B-TH-238: what needs the customer first, then new messages, the account's conversation) — or,
 * for a new customer with nothing yet, a clear first step. Two columns on a
 * desktop (what waits and the deliveries; the numbers, documents and messages), one column in the design's order on a
 * phone. Draws one view model and fetches nothing; the pop-ups are Approve (its own) and the document pop-up (lifted to
 * documents/preview by B-W2b-195: Home and the Documents page open a document the same way).
 */

type Async = 'loading' | 'error' | 'ready'

export interface HomeSearchModel {
  query: string
  state: 'idle' | 'tooShort' | 'searching' | 'error' | 'ready'
  groups: readonly SearchGroupRow[]
  found: number
  capped: boolean
  /** This device's last searches (empty field only). */
  recent: readonly string[]
}

export interface WelcomeModel {
  name: string
  company: string
  /** The person orders (a buyer): the first step is an order. */
  buyer: boolean
  newOrderHref: string | null
  catalogueHref: string | null
  /** Their organisation's admins, for "can give you more access". */
  admins: readonly string[]
}

export type PromiseWhy = { state: Async; words: string | null }

// B-TH-223 (P-HOME.actions): the two doors — an order like an e-mail, or a question — and the draft kept on this device.
export interface StartModel {
  /** New order's address (a buyer, the page built, not in a preview), else null. */
  newOrderHref: string | null
  /** The person may order (portal.orderRequests.manage). */
  buyer: boolean
  /** Who can give the right to order (their admins). */
  admins: readonly string[]
  /** The unsent New order kept on this device: its subject (or first line) and when it was kept (written). */
  // ---- B-TH-287: `where` — saved on the server ("saved 10:42"), or kept on this device only (absent: this device).
  draft: { subject: string; at: string; where?: 'server' | 'device' } | null
  // ---- end B-TH-287
}

export interface CustomerHomeViewModel {
  prefix: string
  /** null: the person cannot search. */
  search: HomeSearchModel | null
  /** A first visit: the first step instead of empty panels. */
  welcome: WelcomeModel | null
  // B-TH-223
  start?: StartModel | null
  tiles: { state: Async; items: readonly Tile[] } | null
  orders: { state: Async; items: readonly NextOrderRow[]; open: number | null; seeAllHref: string | null; newOrderHref: string | null; why: Readonly<Record<string, PromiseWhy>> } | null
  documents: { state: Async; items: readonly DocumentRow[]; seeAllHref: string | null; busy: string | null; problem: string | null; held: string | null } | null
  /** B-TH-238: the Messages card (the session's own reads); `company` the factory's name ("from <company>"); null: no right. */
  messages: { state: Async; company: string; card: MessagesCard | null; needsYouHref: string | null } | null
  /** A read takes longer than a second: "Still loading…". */
  slow?: boolean
  approve: ApproveDialogModel | null
  document: DocumentPreviewModel | null
}

export interface CustomerHomeActions {
  search?: {
    onQuery?: (query: string) => void
    onSubmit?: () => void
    onRecent?: (query: string) => void
    onClearRecent?: () => void
    onOpen?: (href: string, event?: MouseEvent<HTMLAnchorElement>) => void
    onRetry?: () => void
  }
  onRetryTiles?: () => void
  onRetryOrders?: () => void
  onRetryDocuments?: () => void
  onRetryMessages?: () => void
  /** The moved date's popover opened: read why. */
  onWhy?: (orderId: string) => void
  onPreview?: (documentId: string) => void
  onDownload?: (documentId: string) => void
  onAsk?: () => void
  approve?: ApproveActions
  document?: DocumentPreviewActions
}

export function CustomerHomeView({ model, actions, tasks }: { model: CustomerHomeViewModel; actions?: CustomerHomeActions; tasks: ReactNode }) {
  const words = useHomeWords()
  const { t } = words
  const failed = (text: string, onRetry?: () => void) => (
    <div className="fw-pstate" role="alert">
      <AlertCircle size={18} aria-hidden />
      <span>{text}</span>
      {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
    </div>
  )
  const loading = (height: number, rows = 3) => (
    <div className="fw-pch-stack" role="status" aria-label={model.slow ? t('state.slow') : t('state.loading')}>
      {Array.from({ length: rows }, (_, row) => (
        <Skeleton key={row} height={height} />
      ))}
      {model.slow ? <span className="fw-pch-sub">{t('state.slow')}</span> : null}
    </div>
  )

  return (
    <div className="fw-pch">
      {model.search ? <SearchHero model={model.search} actions={actions?.search} /> : null}
      {model.start && !model.welcome ? <StartCard model={model.start} onAsk={actions?.onAsk} /> : null}
      {model.welcome ? (
        // The first step fills the page; our messages beside it only when there are some (no empty column).
        model.messages?.card && !messagesEmpty(model.messages.card) ? (
          <div className="fw-pch-cols">
            <div className="fw-pch-col">
              <WelcomeHero model={model.welcome} onAsk={actions?.onAsk} />
            </div>
            <div className="fw-pch-col">
              <Messages model={model.messages} loading={loading} failed={failed} onRetry={actions?.onRetryMessages} />
            </div>
          </div>
        ) : (
          <WelcomeHero model={model.welcome} onAsk={actions?.onAsk} />
        )
      ) : (
        <div className="fw-pch-cols">
          <div className="fw-pch-col">
            <div className="fw-pch-tasks">{tasks}</div>
            {model.orders ? <NextOrders model={model.orders} loading={loading} failed={failed} actions={actions} /> : null}
          </div>
          <div className="fw-pch-col">
            {model.tiles ? (
              <section className="fw-pch-section fw-pch-tiles" aria-labelledby="fw-pch-glance">
                <h2 id="fw-pch-glance" className="fw-pch-title">
                  {t('tiles.title')}
                </h2>
                {model.tiles.state === 'error' ? failed(t('tiles.failed'), actions?.onRetryTiles) : <MetricStrip metrics={metricsOf(model.tiles, model.prefix, words)} minTileWidth={150} />}
              </section>
            ) : null}
            {model.documents ? <NewDocuments model={model.documents} loading={loading} failed={failed} actions={actions} /> : null}
            {model.messages ? <Messages model={model.messages} loading={loading} failed={failed} onRetry={actions?.onRetryMessages} /> : null}
          </div>
        </div>
      )}
      {model.approve ? <ApproveDialog model={model.approve} actions={actions?.approve} /> : null}
      {model.document ? <DocumentPreview model={model.document} actions={actions?.document} /> : null}
    </div>
  )
}

function metricsOf(tiles: { state: Async; items: readonly Tile[] }, prefix: string, words: ReturnType<typeof useHomeWords>): Metric[] {
  const { t } = words
  return tiles.items.map((tile) => {
    const known = tiles.state === 'ready' && tile.value !== null
    const value = tiles.state === 'loading' ? <Skeleton width={36} height={22} /> : known ? String(tile.value) : '—'
    const hint =
      tiles.state === 'ready' && tile.value === null
        ? t('tiles.unknown')
        : tile.amount
          ? [tile.amount.open ? t('tiles.invoicesAmount', { amount: tile.amount.open }) : null, tile.amount.overdue ? t('tiles.invoicesOverdue', { count: tile.amount.overdue }) : null].filter(Boolean).join(' · ') || t(tile.hint)
          : // F-PR-15: My production's tile says what waits there ("2 waiting on you · 1 at risk"), else its own hint.
            tile.waiting && tile.waiting.length > 0
            ? tile.waiting.map((part) => t(part.words, { count: part.count })).join(' · ')
            : t(tile.hint)
    const accent = tile.tone && (tile.value ?? 0) > 0 ? { accent: tile.tone === 'danger' ? 'var(--nds-danger)' : 'var(--nds-warning)' } : {}
    const base = { label: t(tile.label), value, hint, ...accent }
    return tile.href ? { ...base, href: `${prefix}${tile.href}` } : base
  })
}

// ── Find anything (SAL-084) ────────────────────────────────────────────────────────────────────────────────────────────
function SearchHero({ model, actions }: { model: HomeSearchModel; actions?: CustomerHomeActions['search'] }) {
  const { t } = useHomeWords()
  const ds = useDsWords()
  const box = useRef<HTMLInputElement>(null)
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      actions?.onSubmit?.()
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.currentTarget.closest('.fw-pch-search')?.querySelector<HTMLAnchorElement>('a.fw-presult')?.focus()
    }
  }
  const moveIn = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a.fw-presult')]
    const at = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (at < 0) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && at === 0) box.current?.focus()
    else links[Math.min(links.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))]?.focus()
  }
  const status =
    model.state === 'tooShort'
      ? t('search.tooShort')
      : model.state === 'searching'
        ? t('search.searching')
        : model.state === 'ready'
          ? model.found > 0
            ? t('search.found', { count: model.found })
            : t('search.none', { query: model.query })
          : ''
  return (
    <section className="fw-pch-section fw-pch-search" aria-labelledby="fw-pch-search" onKeyDown={moveIn}>
      <h2 id="fw-pch-search" className="fw-pch-title">
        {t('search.title')}
      </h2>
      <div className="fw-pch-search-row">
        <Input
          ref={box}
          type="search"
          value={model.query}
          onChange={(event) => actions?.onQuery?.(event.target.value)}
          onKeyDown={onKey}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
          aria-describedby="fw-pch-search-hint"
          leadingIcon={<Search size={16} aria-hidden />}
          autoComplete="off"
        />
        <Button onClick={() => actions?.onSubmit?.()}>{t('search.go')}</Button>
      </div>
      <p id="fw-pch-search-hint" className="fw-pch-sub">
        {t('search.hint')}
      </p>
      <div className="fw-pch-sub" role="status" aria-live="polite">
        {status}
      </div>
      {model.state === 'idle' && model.query.trim() === '' && model.recent.length > 0 ? (
        <div className="fw-pch-recent">
          <span className="fw-pch-recent-label">
            <History size={14} aria-hidden /> {t('search.recent')}
          </span>
          <ul className="fw-pch-recent-list" aria-label={t('search.recent')}>
            {model.recent.map((query) => (
              <li key={query}>
                <Button size="sm" variant="quiet" aria-label={t('search.again', { query })} onClick={() => actions?.onRecent?.(query)}>
                  {query}
                </Button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="quiet" onClick={() => actions?.onClearRecent?.()}>
            {t('search.clear')}
          </Button>
          <span className="fw-pch-sub">{t('search.recentHint')}</span>
        </div>
      ) : null}
      {model.state === 'searching' && model.groups.length === 0 ? (
        <div className="fw-pch-stack">
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : null}
      {model.state === 'error' ? (
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('search.failed')}</span>
          {actions?.onRetry ? <Button onClick={actions.onRetry}>{t('state.retry')}</Button> : null}
        </div>
      ) : null}
      {model.groups.length > 0 ? (
        <div className="fw-pch-results">
          {model.groups.map((group) => (
            <section key={group.group} className="fw-psearch-group" aria-label={group.label}>
              <h3 className="fw-psearch-head">
                {group.label} <span className="fw-psearch-count">{group.count}</span>
              </h3>
              <ul className="fw-psearch-list">
                {group.results.map((result) => (
                  <li key={result.key}>
                    <a href={result.href} className="fw-presult" onClick={(event) => actions?.onOpen?.(result.href, event)}>
                      <RefPair theirs={result.theirs} ours={result.ours} theirsLabel={t('search.yours')} oursLabel={t('search.ours')} copy={false} match={model.query} size="sm" labels={ds.refPair} />
                      <span className="fw-presult-meta">{[result.subtitle, result.when].filter(Boolean).join(' · ')}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
      {model.state === 'ready' && model.capped ? <p className="fw-pch-sub">{t('search.capped')}</p> : null}
    </section>
  )
}

// ── B-TH-223: Start (P-HOME.actions) ───────────────────────────────────────────────────────────────────────────────────
function StartCard({ model, onAsk }: { model: StartModel; onAsk?: () => void }) {
  const { t } = useHomeWords()
  return (
    <section className="fw-pch-section fw-pch-start" aria-labelledby="fw-pch-start">
      <h2 id="fw-pch-start" className="fw-sr">
        {t('start.label')}
      </h2>
      <div className="fw-pch-start-doors">
        {model.buyer && model.newOrderHref ? (
          <a className="fw-pch-door is-primary" href={model.newOrderHref}>
            <PenLine size={20} aria-hidden />
            <span className="fw-pch-door-text">
              <strong>{t('start.newOrder')}</strong>
              <span>{t('start.newOrderHint')}</span>
            </span>
          </a>
        ) : null}
        {!model.buyer ? (
          <div className="fw-pch-door is-held" role="note">
            <Lock size={20} aria-hidden />
            <span className="fw-pch-door-text">
              <strong>{t('start.noRight')}</strong>
              <span>{model.admins.length > 0 ? t('start.noRightAsk', { names: model.admins.join(', ') }) : t('start.noRightAskUs')}</span>
            </span>
          </div>
        ) : null}
        <button type="button" className="fw-pch-door" onClick={() => onAsk?.()}>
          <MessageSquare size={20} aria-hidden />
          <span className="fw-pch-door-text">
            <strong>{t('start.ask')}</strong>
            <span>{t('start.askHint')}</span>
          </span>
        </button>
      </div>
      {model.draft && model.newOrderHref ? (
        <p className="fw-pch-draft">
          <FilePen size={16} aria-hidden />
          <span className="fw-pch-draft-text">
            <strong>{t('start.draft', { subject: model.draft.subject })}</strong> <span className="fw-pch-sub">{t(model.draft.where === 'server' ? 'start.draftSaved' /* B-TH-287 */ : 'start.draftKept', { time: model.draft.at })}</span>
          </span>
          <Button size="sm" asChild>
            <a href={model.newOrderHref}>{t('start.continue')}</a>
          </Button>
        </p>
      ) : null}
    </section>
  )
}

// ── First visit ────────────────────────────────────────────────────────────────────────────────────────────────────────
function WelcomeHero({ model, onAsk }: { model: WelcomeModel; onAsk?: () => void }) {
  const { t } = useHomeWords()
  const orders = model.buyer && (model.newOrderHref || model.catalogueHref)
  return (
    <Card padded className="fw-pch-welcome">
      <span className="fw-pch-welcome-icon" aria-hidden>
        <Sparkles size={22} />
      </span>
      <h2 className="fw-pch-welcome-title">{t('welcome.title', { name: model.name })}</h2>
      <p className="fw-pch-welcome-body">{t('welcome.body', { company: model.company })}</p>
      {model.buyer ? (
        <>
          <p className="fw-pch-welcome-body">{t('welcome.buyerBody')}</p>
          <div className="fw-pch-welcome-actions">
            {model.newOrderHref ? (
              <Button variant="primary" asChild>
                <a href={model.newOrderHref}>{t('welcome.firstOrder')}</a>
              </Button>
            ) : null}
            {model.catalogueHref ? (
              <Button asChild>
                <a href={model.catalogueHref}>{t('welcome.catalogue')}</a>
              </Button>
            ) : null}
            {!orders ? (
              <Button variant="primary" onClick={() => onAsk?.()}>
                {t('welcome.ask')}
              </Button>
            ) : null}
          </div>
          {!orders ? <p className="fw-pch-sub">{t('welcome.askHint')}</p> : null}
        </>
      ) : (
        <p className="fw-pch-welcome-body">{model.admins.length > 0 ? t('welcome.other', { admins: model.admins.join(', ') }) : t('welcome.otherNoAdmin')}</p>
      )}
    </Card>
  )
}

// ── Your next deliveries ───────────────────────────────────────────────────────────────────────────────────────────────
function NextOrders({
  model,
  loading,
  failed,
  actions,
}: {
  model: NonNullable<CustomerHomeViewModel['orders']>
  loading: (height: number, rows?: number) => ReactNode
  failed: (text: string, onRetry?: () => void) => ReactNode
  actions?: CustomerHomeActions
}) {
  const words = useHomeWords()
  const { t, day } = words
  const ds = useDsWords()
  return (
    <section className="fw-pch-section fw-pch-orders" aria-labelledby="fw-pch-orders">
      <div className="fw-pch-head">
        <h2 id="fw-pch-orders" className="fw-pch-title">
          {t('orders.title')}
        </h2>
        {model.seeAllHref && model.state === 'ready' && model.open ? (
          <a className="fw-pch-more" href={model.seeAllHref}>
            {t('orders.seeAll', { count: model.open })}
          </a>
        ) : null}
      </div>
      {model.state === 'loading' ? (
        loading(64)
      ) : model.state === 'error' ? (
        failed(t('orders.failed'), actions?.onRetryOrders)
      ) : model.items.length === 0 ? (
        <div className="fw-pch-empty">
          <PackageOpen size={16} aria-hidden />
          <span>{t('orders.empty')}</span>
          {model.newOrderHref ? (
            <Button size="sm" asChild>
              <a href={model.newOrderHref}>{t('welcome.firstOrder')}</a>
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="fw-pch-rows" aria-label={t('orders.title')}>
          {model.items.map((row) => {
            const name = [row.oursLabel, row.ours].filter(Boolean).join(' ') || row.theirs || ''
            const head = (
              <>
                <span className="fw-pch-order-refs">
                  {row.kind === 'REQUEST' ? <Tag tone="neutral">{t('orders.request')}</Tag> : null}
                  <RefPair theirs={row.theirs} ours={row.ours} theirsLabel={t('orders.yours')} oursLabel={row.oursLabel ?? ''} copy={false} size="sm" labels={ds.refPair} />
                </span>
                <MilestoneTracker steps={row.steps} layout="compact" label={t('orders.steps', { number: name })} labels={ds.milestoneTracker} />
                <span className="fw-pch-sub">
                  {[t('orders.pieces', { open: row.pieces.open, ordered: row.pieces.ordered }), row.shipment ? t('orders.shipment', { number: row.shipment.number, status: row.shipment.words }) : null].filter(Boolean).join(' · ')}
                </span>
              </>
            )
            const why = model.why[row.id]
            return (
              <li key={row.id} className="fw-pch-order">
                {row.href ? (
                  <a className="fw-pch-order-main fw-pch-pressable" href={row.href}>
                    {head}
                  </a>
                ) : (
                  <div className="fw-pch-order-main">{head}</div>
                )}
                <div className="fw-pch-order-side">
                  <span className="fw-pch-promise">
                    <Clock size={14} aria-hidden />
                    {row.promise ? t('orders.promised', { date: day(row.promise) }) : row.requested ? t('orders.wanted', { date: day(row.requested) }) : t('orders.noPromise')}
                  </span>
                  {row.moved ? (
                    <DetailPopover
                      trigger={<Pill tone="warning">{t('orders.moved')}</Pill>}
                      triggerLabel={t('orders.movedOpen', { number: name })}
                      triggerClassName="fw-pch-moved"
                      label={t('orders.movedTitle')}
                      hoverDelay={0}
                      onOpenChange={(open) => {
                        if (open) actions?.onWhy?.(row.id)
                      }}
                    >
                      <div className="fw-pch-why">
                        <strong>{t('orders.movedTitle')}</strong>
                        <span>{t('orders.movedFrom', { from: day(row.moved.from), to: day(row.moved.to) })}</span>
                        <span className="fw-pch-sub" role="status">
                          {!why || why.state === 'loading' ? t('orders.movedReading') : why.state === 'error' ? t('orders.movedFailed') : why.words ? t('orders.movedWhy', { reason: why.words }) : t('orders.movedNone')}
                        </span>
                      </div>
                    </DetailPopover>
                  ) : null}
                  {row.progress !== null ? (
                    <span className="fw-pch-progress">
                      <ProgressBar value={row.progress} ariaLabel={t('orders.progressLabel', { number: name })} />
                      <span className="fw-pch-sub">{t('orders.progress', { percent: row.progress })}</span>
                    </span>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── New documents (SAL-086) ────────────────────────────────────────────────────────────────────────────────────────────
function NewDocuments({
  model,
  loading,
  failed,
  actions,
}: {
  model: NonNullable<CustomerHomeViewModel['documents']>
  loading: (height: number, rows?: number) => ReactNode
  failed: (text: string, onRetry?: () => void) => ReactNode
  actions?: CustomerHomeActions
}) {
  const { t, day } = useHomeWords()
  return (
    <section className="fw-pch-section fw-pch-documents" aria-labelledby="fw-pch-documents">
      <div className="fw-pch-head">
        <h2 id="fw-pch-documents" className="fw-pch-title">
          {t('documents.title')}
        </h2>
        {model.seeAllHref ? (
          <a className="fw-pch-more" href={model.seeAllHref}>
            {t('documents.seeAll')}
          </a>
        ) : null}
      </div>
      {model.problem ? <Banner tone="warning" title={model.problem} /> : null}
      {model.state === 'loading' ? (
        loading(52, 2)
      ) : model.state === 'error' ? (
        failed(t('documents.failed'), actions?.onRetryDocuments)
      ) : model.items.length === 0 ? (
        <p className="fw-pch-empty">
          <FileText size={16} aria-hidden /> <span>{t('documents.empty')}</span>
        </p>
      ) : (
        <ul className="fw-pch-files" aria-label={t('documents.title')}>
          {model.items.map((row) => {
            const busy = model.busy === row.id
            const held = model.held ?? (busy ? t('documents.opening') : null)
            return (
              <li key={row.id}>
                <FileRow
                  name={row.title}
                  size={row.sizeBytes ?? undefined}
                  status={
                    <span className="fw-pch-file-status">
                      {row.isNew ? <Pill tone="info">{t('documents.new')}</Pill> : null}
                      <span>{[row.forWords ? t(row.forWords.key, row.forWords.params) : null, day(row.date), t('documents.version', { version: row.version })].filter(Boolean).join(' · ')}</span>
                    </span>
                  }
                  actions={
                    <>
                      {row.previewable ? (
                        <Button size="sm" heldReason={held} aria-label={t('documents.previewOf', { title: row.title })} aria-haspopup="dialog" onClick={() => actions?.onPreview?.(row.id)}>
                          {t('documents.preview')}
                        </Button>
                      ) : null}
                      <Button size="sm" heldReason={held} aria-label={t('documents.downloadOf', { title: row.title })} onClick={() => actions?.onDownload?.(row.id)}>
                        {t('documents.download')}
                      </Button>
                    </>
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ── B-TH-238 (P-HOME.messages): Messages — what needs the customer first, then new messages, the account's conversation ──────
function Messages({
  model,
  loading,
  failed,
  onRetry,
}: {
  model: NonNullable<CustomerHomeViewModel['messages']>
  loading: (height: number, rows?: number) => ReactNode
  failed: (text: string, onRetry?: () => void) => ReactNode
  onRetry?: () => void
}) {
  const { t, at, day } = useHomeWords()
  const ds = useDsWords()
  const card = model.card
  const lastLine = (row: MessageRow) =>
    row.last ? (row.last.from === 'you' ? t('messages.lastFromYou', { when: at(row.last.at) }) : t('messages.lastFromUs', { company: model.company, when: at(row.last.at) })) : null
  const fresh = (row: MessageRow) => (row.newCount > 0 ? <Pill tone="info">{t('messages.new', { count: row.newCount })}</Pill> : null)
  const conversationRow = (row: MessageRow) => {
    const name = row.ours ?? row.theirs ?? row.subject ?? ''
    return (
      <li key={row.key} className="fw-pch-message">
        <span className="fw-pch-message-main">
          <span className="fw-pch-from">
            {row.theirs || row.ours ? <RefPair theirs={row.theirs} ours={row.ours} theirsLabel={t('orders.yours')} oursLabel={t('messages.yourNumber')} size="sm" copy={false} labels={ds.refPair} /> : <strong>{row.subject}</strong>}
            {fresh(row)}
          </span>
          {lastLine(row) ? <span className="fw-pch-sub">{lastLine(row)}</span> : null}
          {row.last?.excerpt ? <span className="fw-pch-excerpt">{row.last.excerpt}</span> : null}
        </span>
        <Button size="sm" asChild>
          <a href={row.href} aria-label={t('messages.openAbout', { record: name })}>
            {t('messages.open')}
          </a>
        </Button>
      </li>
    )
  }
  // ---- B-TH-253 (PROJ.portal-F01): a project the person was added to — its NAME (never the office's number), its status when it
  // is not simply going, its target date, the last message or "No messages yet", new marks; it opens the project's page.
  const projectRow = (row: MessageRow) => {
    const name = row.subject ?? t('messages.projectTag')
    const status = row.project?.status ?? null
    return (
      <li key={row.key} className="fw-pch-message">
        <span className="fw-pch-message-main">
          <span className="fw-pch-from">
            <FolderKanban size={16} aria-hidden />
            <strong>{name}</strong>
            <Tag tone="neutral">{t('messages.projectTag')}</Tag>
            {status === 'ON_HOLD' ? <Pill tone="warning">{t('messages.projectStatus.ON_HOLD')}</Pill> : status === 'CLOSED' ? <Pill tone="neutral">{t('messages.projectStatus.CLOSED')}</Pill> : null}
            {fresh(row)}
          </span>
          <span className="fw-pch-sub">
            {[row.project?.targetDate ? t('messages.projectTarget', { date: day(row.project.targetDate) }) : null, lastLine(row) ?? t('messages.projectNone')].filter(Boolean).join(' · ')}
          </span>
          {row.last?.excerpt ? <span className="fw-pch-excerpt">{row.last.excerpt}</span> : null}
        </span>
        <Button size="sm" asChild>
          <a href={row.href} aria-label={t('messages.openProject', { name })}>
            {t('messages.open')}
          </a>
        </Button>
      </li>
    )
  }
  // ---- end B-TH-253
  return (
    <section className="fw-pch-section fw-pch-messages" aria-labelledby="fw-pch-messages">
      <h2 id="fw-pch-messages" className="fw-pch-title">
        {t('messages.title')}
      </h2>
      {model.state === 'loading' || (model.state === 'ready' && !card) ? (
        loading(52, 2)
      ) : model.state === 'error' || !card ? (
        failed(t('messages.failed'), onRetry)
      ) : (
        <>
          {card.needsYou.length > 0 ? (
            <div className="fw-pch-stack">
              <h3 className="fw-pch-subtitle">
                <AlertCircle size={16} aria-hidden /> {t('messages.needsYou', { count: card.needsYouCount })}
              </h3>
              <ul className="fw-pch-rows" aria-label={t('messages.needsYouLabel')}>
                {card.needsYou.map((row) => (
                  <li key={row.key} className="fw-pch-message">
                    <span className="fw-pch-message-main">
                      <span className="fw-pch-from">
                        {row.yours ? <strong>{row.yours}</strong> : null}
                        <Pill tone="warning">{row.state}</Pill>
                        {fresh(row)}
                      </span>
                      <span className="fw-pch-excerpt">{row.subject}</span>
                      {lastLine(row) ? <span className="fw-pch-sub">{lastLine(row)}</span> : null}
                    </span>
                    <Button size="sm" variant="primary" asChild>
                      <a href={row.href} aria-label={t('messages.answerAbout', { record: row.yours ?? row.subject ?? '' })}>
                        {t('messages.answer')}
                      </a>
                    </Button>
                  </li>
                ))}
              </ul>
              {card.needsYouCount > card.needsYou.length && model.needsYouHref ? <a href={model.needsYouHref}>{t('messages.needsYouAll', { count: card.needsYouCount })}</a> : null}
            </div>
          ) : null}
          {/* B-TH-253: the projects the person was added to, after what needs the customer. */}
          {card.projects.length > 0 ? (
            <div className="fw-pch-stack">
              <h3 className="fw-pch-subtitle">
                <FolderKanban size={16} aria-hidden /> {t('messages.projects')}
              </h3>
              <ul className="fw-pch-rows" aria-label={t('messages.projectsLabel')}>
                {card.projects.map(projectRow)}
              </ul>
              {card.projectsMore > 0 ? <p className="fw-pch-sub">{t('messages.projectsMore', { count: card.projectsMore })}</p> : null}
            </div>
          ) : null}
          {messagesEmpty(card) ? (
            <p className="fw-pch-empty">
              <MessageSquare size={16} aria-hidden /> <span>{t('messages.empty')}</span>
            </p>
          ) : null}
          {card.conversations.length > 0 ? (
            <ul className="fw-pch-rows" aria-label={t('messages.conversationsLabel')}>
              {card.conversations.map(conversationRow)}
            </ul>
          ) : null}
          {card.more > 0 ? <p className="fw-pch-sub">{t('messages.more', { count: card.more })}</p> : null}
          <ul className="fw-pch-rows" aria-label={t('messages.accountLabel', { company: model.company })}>
            <li className="fw-pch-message">
              <span className="fw-pch-message-main">
                <span className="fw-pch-from">
                  <strong>{t('messages.account', { company: model.company })}</strong>
                  {fresh(card.account)}
                </span>
                <span className="fw-pch-sub">{lastLine(card.account) ?? t('messages.accountEmpty')}</span>
                {card.account.last?.excerpt ? <span className="fw-pch-excerpt">{card.account.last.excerpt}</span> : null}
              </span>
              <Button size="sm" asChild>
                <a href={card.account.href}>{card.account.last ? t('messages.open') : t('messages.write')}</a>
              </Button>
            </li>
          </ul>
        </>
      )}
    </section>
  )
}
