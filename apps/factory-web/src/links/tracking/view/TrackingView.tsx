'use client'

import type { FormEvent, ReactNode } from 'react'
import { AlertTriangle, Copy, Download, ExternalLink, Link2Off, MapPin, MessageSquareWarning, Search, ShieldAlert, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, type KeyValueItem } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Input, Pill, Skeleton, Spinner } from '@nexus/ui/primitives'
import { FileRow, Timeline, useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'
import { WithMessages } from '../../../record-panels/i18n'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import type { Paper, TrackingPage } from '../api'
import {
  carrierPageOf,
  deliveredPlace,
  EVENT_TONE,
  headerCarrierPage,
  orderLabel,
  paperLine,
  PILL_TONE,
  placeLine,
  trackerSteps,
  type SearchModel,
  type TrackingActions,
  type TrackingViewModel,
} from '../model'
import '../tracking.css'

export type { TrackingViewModel, TrackingActions } from '../model'

/**
 * SCR-194 — Track an order (design links.tracking; LOG-062): the link frame (the sender's brand, the language, whom to
 * ask, the privacy notice) around ONE task, in the reader's language: the status pill and "Track on the carrier's site"
 * (a new tab); Where it is (the DS MilestoneTracker: Packed · Collected · In transit · Out for delivery · Delivered, the
 * expected delivery, the carrier and each parcel's tracking number with Copy); Carrier events (time · place · event, said
 * in our words from the carrier's codes); Delivery (town and postcode only, and when it was delivered); Papers (packing
 * list, Declaration of Conformity, user information — never a price; a link found by the search sends to our e-mail);
 * Something wrong? ("Report a problem with this delivery" opens a claim link in a new tab). `/t`: Find your order — the
 * customer's order reference and the delivery postcode, one answer for a miss, Enter searches.
 */
export function TrackingView({ model, actions }: { model: TrackingViewModel; actions?: TrackingActions }) {
  return (
    <WithMessages namespaces={['link-tracking', 'ds-words']}>
      <TrackingPageFrame model={model} actions={actions} />
    </WithMessages>
  )
}

function TrackingPageFrame({ model, actions }: { model: TrackingViewModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  const page = model.page
  const search = model.search
  const timeZone = page?.timeZone ?? model.timeZone
  const title = page ? t('title', { order: orderLabel(page) }) : search ? t('search.title') : null
  return (
    // On /t the sender is the company the address names (its public branding and whom to ask); on a link, the landing's.
    <LinkFrameView model={{ sender: search?.sender ? { ...search.sender, contact: { email: search.sender.contactEmail } } : null, title, body: { kind: 'task' }, timeZone }}>
      <div className="fw-trk">
        {search && (model.load === 'idle' || model.load === 'dead') ? <SearchCard search={search} actions={actions} /> : null}
        {search && model.load !== 'idle' && model.load !== 'dead' ? (
          <p className="fw-trk-again">
            <Button variant="quiet" size="sm" onClick={() => actions?.onSearchAgain?.()}>
              <Search size={14} aria-hidden /> {t('search.again')}
            </Button>
          </p>
        ) : null}
        <TrackingBody model={model} actions={actions} />
      </div>
    </LinkFrameView>
  )
}

function TrackingBody({ model, actions }: { model: TrackingViewModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  if (model.load === 'idle') return null
  if (model.load === 'loading' || (model.load === 'ready' && !model.page)) return <LoadingBody slow={model.slow} />
  if (model.load === 'error') {
    return (
      <Card padded className="fw-link-state tone-danger">
        <EmptyState
          icon={<ShieldAlert size={28} aria-hidden />}
          title={t('state.error.title')}
          description={t('state.error.body')}
          action={
            <Button variant="primary" onClick={() => actions?.onRetry?.()}>
              {t('retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  if (model.load === 'dead') return model.search ? <SearchEnded /> : <DeadBody model={model} actions={actions} />
  return <ReadyBody page={model.page!} model={model} actions={actions} />
}

// ---- loading, dead -----------------------------------------------------------------------------------------------------

function LoadingBody({ slow }: { slow: boolean }) {
  const t = useT('link-tracking')
  return (
    <div className="fw-trk-stack" aria-busy="true">
      <Card padded className="fw-trk-card">
        <Skeleton width="40%" height={22} />
        <Skeleton height={64} />
        <Skeleton width="70%" height={16} />
      </Card>
      <Card padded className="fw-trk-card">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} height={36} />
        ))}
      </Card>
      <p className="fw-trk-hint" role="status">
        {slow ? (
          <>
            <Spinner size={14} /> {t('loading.slow')}
          </>
        ) : (
          t('loading.label')
        )}
      </p>
    </div>
  )
}

function DeadBody({ model, actions }: { model: TrackingViewModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  return (
    <div className="fw-trk-stack">
      <Card padded className="fw-link-state tone-warning">
        <EmptyState
          icon={<Link2Off size={28} aria-hidden />}
          title={t('state.dead.title')}
          description={t('state.dead.body')}
          action={
            model.ask === 'done' ? (
              <Button variant="secondary" heldReason={t('ask.held')}>
                {t('ask.asked')}
              </Button>
            ) : (
              <Button variant="primary" heldReason={model.ask === 'busy' ? t('ask.busy') : null} onClick={() => actions?.onAskNewLink?.()}>
                {model.ask === 'busy' && <Spinner size={14} />} {model.ask === 'failed' ? t('ask.again') : t('ask.label')}
              </Button>
            )
          }
        />
      </Card>
      {model.ask === 'done' && (
        <p className="fw-trk-hint" role="status">
          {t('ask.done')}
        </p>
      )}
      {model.ask === 'failed' && <Banner tone="danger" title={t('ask.failed')} />}
      <p className="fw-trk-hint">{t('ask.onlyOnFile')}</p>
    </div>
  )
}

function SearchEnded() {
  const t = useT('link-tracking')
  return <Banner tone="warning" title={t('search.ended.title')}>{t('search.ended.body')}</Banner>
}

// ---- the tracking page -------------------------------------------------------------------------------------------------

function ReadyBody({ page, model, actions }: { page: TrackingPage; model: TrackingViewModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  const locale = useLocale()
  const when = (iso: string) => formatDateTime(iso, { locale, timeZone: page.timeZone })
  return (
    <div className="fw-trk-stack">
      <StatusBand page={page} />
      <div className="fw-trk-grid">
        <div className="fw-trk-col">
          <WhereItIs page={page} model={model} actions={actions} />
          <Events page={page} />
        </div>
        <div className="fw-trk-col">
          <Delivery page={page} />
          <Papers page={page} model={model} actions={actions} />
          <Problem page={page} model={model} actions={actions} />
        </div>
      </div>
      <p className="fw-trk-hint">
        {t('foot.ends', { date: formatDate(page.link.endsAt, { locale, timeZone: page.timeZone }) })}
        {model.readAt ? ` ${t('foot.read', { time: when(model.readAt) })}` : ''}
      </p>
    </div>
  )
}

function StatusBand({ page }: { page: TrackingPage }) {
  const t = useT('link-tracking')
  const carrierPage = headerCarrierPage(page)
  return (
    <Card padded className="fw-trk-band">
      <div className="fw-trk-band-text">
        <Pill tone={PILL_TONE[page.pill]}>{t(`pill.${page.pill}`)}</Pill>
        <span className="fw-trk-band-line">{page.problem ? t(`problem.${page.problem}`) : t(`now.${page.pill}`)}</span>
      </div>
      {carrierPage ? (
        <Button asChild variant="secondary">
          <a href={carrierPage} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={16} aria-hidden /> {t('carrierSite')}
          </a>
        </Button>
      ) : null}
    </Card>
  )
}

function WhereItIs({ page, model, actions }: { page: TrackingPage; model: TrackingViewModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  const locale = useLocale()
  const ds = useDsWords()
  const day = (iso: string) => formatDate(iso, { locale, timeZone: page.timeZone })
  const when = (iso: string) => formatDateTime(iso, { locale, timeZone: page.timeZone })
  const { shipment } = page
  const facts: KeyValueItem[] = [
    shipment.deliveredAt
      ? { label: t('fact.delivered'), value: when(shipment.deliveredAt) }
      : shipment.returnedAt
        ? { label: t('fact.returned'), value: when(shipment.returnedAt) }
        : { label: t('fact.expected'), value: shipment.expectedDeliveryAt ? day(shipment.expectedDeliveryAt) : t('fact.expectedUnknown') },
    { label: t('fact.carrier'), value: shipment.carrierName ?? t(`by.${shipment.transportBy}`) },
    { label: t('fact.shipment'), value: shipment.number },
    ...(page.order.customerRef && page.order.number ? [{ label: t('fact.ourOrder'), value: page.order.number }] : []),
  ]
  const several = page.parcels.length > 1
  return (
    <Card header={t('where.title')} headingLevel={2} description={t('where.sub')}>
      <div className="fw-trk-card">
        <MilestoneTracker steps={trackerSteps(page, (code) => t(`step.${code}`), when)} label={t('where.steps', { number: shipment.number })} labels={ds.milestoneTracker} />
        <KeyValue columns={2} phoneColumns={1} labelCase="sentence" items={facts} />
        {page.parcels.length > 0 ? (
          <ul className="fw-trk-parcels" aria-label={t('parcels.label', { count: page.parcels.length })}>
            {page.parcels.map((parcel) => {
              const carrierPage = carrierPageOf(parcel.carrierPage)
              return (
                <li key={parcel.seq} className="fw-trk-parcel">
                  <span className="fw-trk-parcel-name">
                    <strong>{t('parcels.name', { seq: parcel.seq, count: page.parcels.length })}</strong>
                    {parcel.trackingNumber ? <span className="fw-trk-mono">{parcel.trackingNumber}</span> : <span className="fw-trk-muted">{t('parcels.noNumber')}</span>}
                    {parcel.status ? <span className="fw-trk-muted">{t(`event.${parcel.status}`)}</span> : null}
                  </span>
                  <span className="fw-trk-parcel-actions">
                    {parcel.trackingNumber ? (
                      <Button size="sm" variant="quiet" onClick={() => actions?.onCopy?.(parcel.trackingNumber!)} aria-label={t('parcels.copyOf', { number: parcel.trackingNumber })}>
                        <Copy size={13} aria-hidden /> {model.copied === parcel.trackingNumber ? t('parcels.copied') : t('parcels.copy')}
                      </Button>
                    ) : null}
                    {several && carrierPage ? (
                      <a className="fw-trk-link" href={carrierPage} target="_blank" rel="noopener noreferrer" aria-label={t('parcels.carrierOf', { seq: parcel.seq })}>
                        <ExternalLink size={13} aria-hidden /> {t('carrierSite')}
                      </a>
                    ) : null}
                  </span>
                </li>
              )
            })}
          </ul>
        ) : null}
        {model.copied ? (
          <span className="fw-trk-vh" role="status">
            {t('parcels.copiedSay', { number: model.copied })}
          </span>
        ) : null}
      </div>
    </Card>
  )
}

function Events({ page }: { page: TrackingPage }) {
  const t = useT('link-tracking')
  const locale = useLocale()
  const when = (iso: string) => formatDateTime(iso, { locale, timeZone: page.timeZone })
  const empty =
    page.shipment.transportBy !== 'CARRIER'
      ? t(`events.none.${page.shipment.transportBy}`)
      : page.shipment.status === 'PACKED'
        ? page.shipment.expectedDeliveryAt
          ? t('events.none.packedEta', { date: formatDate(page.shipment.expectedDeliveryAt, { locale, timeZone: page.timeZone }) })
          : t('events.none.packed')
        : t('events.none.left')
  return (
    <Card header={t('events.title')} headingLevel={2} description={t('events.sub')}>
      {page.events.length === 0 ? (
        <p className="fw-trk-hint">{empty}</p>
      ) : (
        <Timeline
          label={t('events.title')}
          steps={page.events.map((event) => ({
            key: event.id,
            tone: EVENT_TONE[event.status],
            label: event.parcelSeq !== null && page.parcels.length > 1 ? t('events.ofParcel', { event: t(`event.${event.status}`), seq: event.parcelSeq }) : t(`event.${event.status}`),
            detail: [when(event.occurredAt), event.place].filter(Boolean).join(' · '),
          }))}
        />
      )}
    </Card>
  )
}

function Delivery({ page }: { page: TrackingPage }) {
  const t = useT('link-tracking')
  const locale = useLocale()
  const place = placeLine(page.delivery)
  const at = deliveredPlace(page)
  const items: KeyValueItem[] = [
    { label: t('delivery.where'), value: place ?? t('delivery.unknown') },
    ...(page.shipment.deliveredAt
      ? [{ label: t('delivery.proof'), value: at ? t('delivery.proofAt', { when: formatDateTime(page.shipment.deliveredAt, { locale, timeZone: page.timeZone }), place: at }) : formatDateTime(page.shipment.deliveredAt, { locale, timeZone: page.timeZone }) }]
      : []),
  ]
  return (
    <Card header={t('delivery.title')} headingLevel={2} description={t('delivery.sub')}>
      <div className="fw-trk-card">
        <KeyValue columns={1} labelCase="sentence" items={items} />
        <p className="fw-trk-hint">
          <MapPin size={14} aria-hidden /> {t('delivery.only')}
        </p>
      </div>
    </Card>
  )
}

function paperTitle(t: Translate, paper: Paper): string {
  const line = paperLine(paper)
  if (line.kind === 'PACKING_LIST') return line.number ? t('paper.packingListOf', { number: line.number }) : t('paper.PACKING_LIST')
  return line.style ? t('paper.styled', { kind: t(`paper.${line.kind}`), style: line.style }) : t(`paper.${line.kind}`)
}

function Papers({ page, model, actions }: { page: TrackingPage; model: TrackingViewModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  const locale = useLocale()
  const languages = (code: string | null) => (code ? new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code : null)
  return (
    <Card header={t('papers.title')} headingLevel={2} description={t('papers.sub')}>
      {!page.papers.shown ? (
        <p className="fw-trk-hint">{t('papers.search')}</p>
      ) : page.papers.files.length === 0 ? (
        <p className="fw-trk-hint">{t('papers.none')}</p>
      ) : (
        <ul className="fw-trk-papers" aria-label={t('papers.title')}>
          {page.papers.files.map((paper) => {
            const state = model.papers[paper.fileId] ?? 'idle'
            const language = languages(paper.language)
            return (
              <li key={paper.fileId}>
                <FileRow
                  name={paperTitle(t, paper)}
                  size={paper.sizeBytes}
                  tone={state === 'failed' ? 'danger' : 'neutral'}
                  status={state === 'failed' ? t('papers.failed') : state === 'busy' ? t('papers.busy') : language ? t('papers.language', { language }) : t('papers.noPrice')}
                  actions={
                    <Button size="sm" variant="secondary" heldReason={state === 'busy' ? t('papers.busy') : null} onClick={() => actions?.onPaper?.(paper.fileId)} aria-label={t('papers.downloadOf', { name: paperTitle(t, paper) })}>
                      {state === 'busy' ? <Spinner size={13} /> : <Download size={13} aria-hidden />} {state === 'failed' ? t('papers.again') : t('papers.download')}
                    </Button>
                  }
                />
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function Problem({ page, model, actions }: { page: TrackingPage; model: TrackingViewModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  const held = page.claim.held ? t(`claim.held.${page.claim.held}`) : model.claim === 'too-many' ? t('claim.tooMany') : model.claim === 'busy' ? t('claim.busy') : null
  return (
    <Card header={t('claim.title')} headingLevel={2} description={t('claim.sub')}>
      <div className="fw-trk-card">
        <div>
          <Button variant="secondary" heldReason={held} onClick={() => actions?.onClaim?.()}>
            {model.claim === 'busy' ? <Spinner size={14} /> : <MessageSquareWarning size={16} aria-hidden />} {t('claim.button')}
          </Button>
        </div>
        {held && model.claim !== 'busy' ? <p className="fw-trk-hint">{held}</p> : null}
        {model.claim === 'opened' ? (
          <p className="fw-trk-hint" role="status">
            {t('claim.opened')}
          </p>
        ) : null}
        {model.claim === 'failed' ? <Banner tone="danger" title={t('claim.failed')} /> : null}
      </div>
    </Card>
  )
}

// ---- Find your order (/t) ----------------------------------------------------------------------------------------------

const PROBLEM_KEY = { EMPTY: 'empty', LONG: 'long', FORMAT: 'format' } as const

function SearchCard({ search, actions }: { search: SearchModel; actions?: TrackingActions }) {
  const t = useT('link-tracking')
  const locale = useLocale()
  if (search.head === 'missing') {
    return (
      <Card padded className="fw-link-state tone-warning">
        <EmptyState icon={<AlertTriangle size={28} aria-hidden />} title={t('search.missing.title')} description={t('search.missing.body')} />
      </Card>
    )
  }
  const busy = search.state === 'searching' || search.state === 'checking'
  const held = search.head === 'loading' ? t('search.held.loading') : busy ? t(`search.held.${search.state}`) : search.state === 'wait' ? t('search.wait', { count: search.waitMinutes ?? 1 }) : null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!held) actions?.onSearch?.()
  }
  const problem = (field: 'reference' | 'postcode'): ReactNode => (search.problems[field] ? t(`search.problem.${field}.${PROBLEM_KEY[search.problems[field]!]}`) : null)
  return (
    <Card header={t('search.cardTitle')} headingLevel={2} description={t('search.sub')}>
      <form className="fw-trk-search" onSubmit={submit} noValidate aria-busy={busy}>
        <div className="fw-trk-search-fields">
          <Field label={t('search.reference')} hint={t('search.referenceHint')} error={problem('reference')} required>
            <Input value={search.reference} autoComplete="off" onChange={(event) => actions?.onSearchField?.('reference', event.target.value)} />
          </Field>
          <Field label={t('search.postcode')} hint={t('search.postcodeHint')} error={problem('postcode')} required>
            <Input value={search.postcode} autoComplete="postal-code" inputMode="text" onChange={(event) => actions?.onSearchField?.('postcode', event.target.value)} />
          </Field>
        </div>
        <div className="fw-trk-search-actions">
          <Button type="submit" variant="primary" heldReason={held}>
            {busy ? <Spinner size={14} /> : <Search size={16} aria-hidden />} {t('search.button')}
          </Button>
          <span className="fw-trk-hint">{t('search.enter')}</span>
        </div>
        <div role="status" aria-live="polite">
          {search.state === 'miss' ? (
            <Banner tone="info" title={t('search.miss.title')}>
              {t('search.miss.body')}
            </Banner>
          ) : search.state === 'wait' ? (
            <Banner tone="warning" title={t('search.wait', { count: search.waitMinutes ?? 1 })} />
          ) : search.state === 'error' ? (
            <Banner tone="danger" title={t('search.error')} />
          ) : search.state === 'checking' ? (
            <p className="fw-trk-hint">{t('search.checking')}</p>
          ) : null}
        </div>
        {search.state === 'several' && search.found.length > 0 ? (
          <div className="fw-trk-found">
            <p className="fw-trk-hint">{t('search.several', { count: search.found.length })}</p>
            <ul className="fw-trk-found-list" aria-label={t('search.foundLabel')}>
              {search.found.map((hit) => (
                <li key={hit.token}>
                  <Button variant="secondary" onClick={() => actions?.onPick?.(hit.token)}>
                    <Truck size={16} aria-hidden /> {hit.shippedAt ? t('search.pickLeft', { number: hit.number, date: formatDate(hit.shippedAt, { locale }) }) : t('search.pickPacked', { number: hit.number })}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>
    </Card>
  )
}
