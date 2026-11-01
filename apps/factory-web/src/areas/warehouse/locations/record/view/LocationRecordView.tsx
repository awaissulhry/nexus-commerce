'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeftRight, Archive, Boxes, MapPin, MoreHorizontal } from 'lucide-react'
import { Banner, Card, EmptyState, EntityPath, Field, KeyValue, Menu, Tabs, type TabItem } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Input, Pill, Select, Skeleton, Toggle } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { LiveState } from '../../../../_shared/buying/hooks'
import { LOCATION_KIND_LIST, type LocationKind, type LocationView, type SiteLocations, type StockOverview, type StockRow, type Uom } from '../../../../_shared/stock/api'
import { money, movesHref, QUALITY_TONE, quantity, sumPerUnit, unitTotals } from '../../../../_shared/stock/model'
import { NoAccess, ReadFailed, StockMessages } from '../../../../_shared/stock/parts'
import { currencyOf, editChanges, editOf, editProblem, LOCATIONS_NAMESPACES, placeRows, recordStockRows, type LocationsCan, type PlaceEdit, type RecordTab } from '../../model'
import { LocationDialogs, type DialogActions, type LocationDialog, type Refusal } from '../../view/LocationDialogs'
import { SaveBar } from '../../view/SaveBar'
import '../../locations.css'

export interface LocationRecordModel {
  prefix: string
  can: LocationsCan
  locationId: string
  record: { status: 'loading' } | { status: 'ready'; site: SiteLocations } | { status: 'error'; problem: string } | { status: 'not_found' }
  /** The site's stock (inventory.stock.view): this place's, and the places inside it. */
  stock: { value: StockOverview | null; problem: string | null }
  tab: RecordTab
  includeInside: boolean
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  busy: boolean
  /** Saved by someone else meanwhile: the typing stays, Reload. */
  conflict: boolean
  savedAt: string | null
  notice?: { tone: 'success' | 'danger'; key: string; params?: Record<string, string | number> } | null
  /** Design cases: typing in the form, a dialog open. */
  draft?: PlaceEdit
  dialog?: LocationDialog | null
}

export interface LocationRecordActions extends DialogActions {
  onSave?: (edit: PlaceEdit) => Promise<Refusal>
  onIncludeInside?: (next: boolean) => void
  onReload?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-065 — a location's record (design warehouse.locations › Location): the band ("Bin N-MAG-A-01 · Ripiano A1", the
 * site and the places above, Active / Archived, ⋯ Move under…, Archive held while it holds stock or places), then link
 * tabs: Overview (code (never changes: printed bin labels show it), name and kind with a save bar, the place above and
 * the places inside, what lies here, whether it may be archived) and Stock (what lies here, with an "Include the places
 * inside" switch; rows open their lot or hide and the moves behind each figure). Archived: read only. Blocks and
 * labels are W2b. Fetches nothing.
 */
export function LocationRecordView({ model, actions }: { model: LocationRecordModel; actions?: LocationRecordActions }) {
  return (
    <StockMessages extra={LOCATIONS_NAMESPACES}>
      <LocationRecord model={model} actions={actions} />
    </StockMessages>
  )
}

function LocationRecord({ model, actions }: { model: LocationRecordModel; actions?: LocationRecordActions }) {
  const t = useT('warehouse-locations')
  const stock = useT('stock')
  const [dialog, setDialog] = useState<LocationDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const back = `${model.prefix}/warehouse/locations`

  if (!model.can.view) return <NoAccess permission="inventory.locations.view" />
  if (model.record.status === 'loading')
    return (
      <div className="fw-st" aria-busy="true">
        <Skeleton height={36} />
        <Skeleton height={28} />
        <div className="fw-st-cards">
          <Skeleton height={220} />
          <Skeleton height={220} />
        </div>
      </div>
    )
  if (model.record.status !== 'ready') {
    const problem = model.record.status === 'error' ? model.record.problem : null
    return (
      <div className="fw-st">
        <Card padded>
          <EmptyState
            icon={<MapPin size={22} aria-hidden />}
            title={problem ? stock(problem) : t('lc.record.notFound')}
            description={problem ? undefined : t('lc.record.notFoundBody')}
            action={
              <span className="fw-st-actions">
                {problem && actions?.onRetry && (
                  <Button size="sm" onClick={actions.onRetry}>
                    {stock('problem.retry')}
                  </Button>
                )}
                <Button size="sm" asChild>
                  <Link href={back}>{t('lc.record.back')}</Link>
                </Button>
              </span>
            }
          />
        </Card>
      </div>
    )
  }

  const site = model.record.site
  const location = site.locations.find((entry) => entry.id === model.locationId)
  if (!location)
    return (
      <div className="fw-st">
        <Card padded>
          <EmptyState icon={<MapPin size={22} aria-hidden />} title={t('lc.record.notFound')} description={t('lc.record.notFoundBody')} action={<Button size="sm" asChild><Link href={back}>{t('lc.record.back')}</Link></Button>} />
        </Card>
      </div>
    )
  return <Loaded model={model} actions={actions} site={site} location={location} dialog={dialog} setDialog={setDialog} />
}

function Loaded({ model, actions, site, location, dialog, setDialog }: { model: LocationRecordModel; actions?: LocationRecordActions; site: SiteLocations; location: LocationView; dialog: LocationDialog | null; setDialog: (next: LocationDialog | null) => void }) {
  const t = useT('warehouse-locations')
  const stock = useT('stock')
  const locale = useLocale()
  const unit = (uom: Uom) => stock(`uom.${uom}`)
  const rows = useMemo(() => placeRows(site, model.stock.value, model.can), [site, model.stock.value, model.can])
  const row = rows.find((entry) => entry.location.id === location.id)!
  const byId = new Map(site.locations.map((entry) => [entry.id, entry]))
  const parent = location.parentId ? byId.get(location.parentId) ?? null : null
  const archived = location.status === 'ARCHIVED'
  const editable = model.can.manage && !archived
  const siteName = `${site.code} · ${site.name}`
  const listHref = `${model.prefix}/warehouse/locations${site.id ? `?site=${encodeURIComponent(site.id)}` : ''}`
  const href = (entry: Pick<LocationView, 'id'>) => `${model.prefix}/warehouse/locations/${encodeURIComponent(entry.id)}`
  const tabHref = (tab: string) => `${href(location)}?tab=${tab}${tab === 'stock' && model.includeInside ? '&inside=1' : ''}`
  const place = { locale, timeZone: model.timeZone }

  const heldArchive = row.archiveHeld ? t(row.archiveHeld, row.archiveParams) : null
  const tabs: TabItem[] = [
    { id: 'overview', label: t('lc.tab.overview'), href: tabHref('overview') },
    ...(model.can.stock ? [{ id: 'stock', label: t('lc.tab.stock'), count: model.stock.value ? recordStockRows(model.stock.value, location.id, site.locations, model.includeInside).length : null, href: tabHref('stock') }] : []),
  ]
  const tab = model.can.stock ? model.tab : 'overview'

  return (
    <div className="fw-st">
      <div className="fw-lc-band">
        <DetailHeader
          backAsChild
          backLabel={<Link href={listHref}>{t('lc.record.back')}</Link>}
          title={t('lc.record.title', { kind: stock(`locationKind.${location.kind}`), code: location.code, name: location.name })}
          meta={<EntityPath label={t('lc.record.where')} items={[{ id: site.id, name: site.code, href: listHref }, ...row.above.map((entry) => ({ id: entry.id, name: entry.code, href: href(entry) }))]} />}
          status={
            <span className="fw-st-inline">
              <Pill tone={archived ? 'neutral' : 'success'}>{stock(`locationStatus.${location.status}`)}</Pill>
              <span className="fw-st-sub" role="status">
                {model.asOf ? stock('live.updated', { time: formatTime(model.asOf, place) }) : ''}
              </span>
            </span>
          }
          actions={
            <Menu
              label={<MoreHorizontal size={16} aria-hidden />}
              align="right"
              triggerProps={{ 'aria-label': stock('common.more') }}
              items={[
                ...(model.can.manage
                  ? [
                      { id: 'move', label: t('lc.menu.move'), icon: <ArrowLeftRight size={14} aria-hidden />, disabled: archived, description: archived ? t('lc.held.archived') : undefined, onSelect: () => setDialog({ kind: 'move', locationId: location.id }) },
                      { id: 'archive', label: t('lc.menu.archive'), tone: 'danger' as const, icon: <Archive size={14} aria-hidden />, disabled: !!heldArchive, description: heldArchive ?? undefined, onSelect: () => setDialog({ kind: 'archive', locationId: location.id }) },
                    ]
                  : []),
                ...(model.can.stock ? [{ id: 'moves', label: t('lc.menu.moves'), icon: <Boxes size={14} aria-hidden />, href: movesHref(model.prefix, { siteId: site.id, locationId: location.id }) }] : []),
                { id: 'list', label: t('lc.record.allPlaces'), href: listHref },
              ]}
            />
          }
        />
        {tabs.length > 1 && <Tabs ariaLabel={t('lc.record.tabs')} tabs={tabs} active={tab} size="sm" overflow="scroll" />}
      </div>

      {archived && <Banner tone="info" title={t('lc.record.archivedTitle')}>{t('lc.record.archivedBody')}</Banner>}
      {model.conflict && (
        <Banner
          tone="warning"
          title={t('lc.conflict.title')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('lc.conflict.reload')}
            </Button>
          }
        >
          {t('lc.conflict.body')}
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('lc.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {model.can.stock && model.stock.problem && <ReadFailed problem={model.stock.problem} onRetry={actions?.onRetry} />}

      {tab === 'overview' ? (
        <div className="fw-st-cards">
          <PlaceCard key={`${location.id}-${location.version}`} model={model} actions={actions} location={location} parent={parent} editable={editable} parentHref={parent ? href(parent) : listHref} siteName={siteName} onMove={() => setDialog({ kind: 'move', locationId: location.id })} />
          <Card padded>
            <div className="fw-lc-card">
              <h2 className="fw-lc-card-title">{t('lc.record.insideTitle')}</h2>
              {row.below === 0 ? (
                <p className="fw-st-sub">{t('lc.record.nothingInside')}</p>
              ) : (
                <ul className="fw-lc-children">
                  {site.locations
                    .filter((entry) => entry.parentId === location.id)
                    .map((entry) => (
                      <li key={entry.id}>
                        <Link className={entry.status === 'ARCHIVED' ? 'fw-st-link fw-st-struck' : 'fw-st-link'} href={href(entry)}>
                          {entry.code}
                        </Link>{' '}
                        <span className="fw-st-sub">
                          {entry.name} · {stock(`locationKind.${entry.kind}`)}
                          {entry.status === 'ARCHIVED' ? ` · ${stock('locationStatus.ARCHIVED')}` : ''}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
              {model.can.manage && !archived && (
                <p className="fw-lc-note">{t('lc.record.newInsideHint')}</p>
              )}
              <h2 className="fw-lc-card-title">{t('lc.record.hereTitle')}</h2>
              {row.stock === null ? (
                <p className="fw-st-sub">{model.can.stock ? '—' : t('lc.stock.noAccess')}</p>
              ) : row.stock.lines === 0 ? (
                <p className="fw-st-sub">{t('lc.stock.nothingHere')}</p>
              ) : (
                <KeyValue
                  dense
                  labelCase="sentence"
                  items={[
                    { label: t('lc.record.quantity'), value: <Link className="fw-st-link fw-st-num" href={movesHref(model.prefix, { siteId: site.id, locationId: location.id })}>{unitTotals(row.stock.quantities, unit, locale)}</Link> },
                    { label: t('lc.record.lines'), value: <Link className="fw-st-link" href={tabHref('stock')}>{t('lc.stock.lines', { count: row.stock.lines })}</Link> },
                    ...(row.stock.hides > 0 ? [{ label: t('lc.record.hides'), value: String(row.stock.hides) }] : []),
                  ]}
                />
              )}
              <h2 className="fw-lc-card-title">{t('lc.record.archiveTitle')}</h2>
              <p className={heldArchive && !archived ? 'fw-lc-note fw-st-warning' : 'fw-lc-note'}>
                {archived ? t('lc.record.isArchived') : heldArchive && model.can.manage ? t('lc.record.archiveHeld', { reason: heldArchive }) : model.can.manage ? t('lc.record.archiveFree') : t('lc.held.noManage')}
              </p>
            </div>
          </Card>
        </div>
      ) : (
        <StockTab model={model} actions={actions} site={site} location={location} />
      )}

      <LocationDialogs
        dialog={dialog}
        locations={site.locations}
        siteName={siteName}
        onClose={() => setDialog(null)}
        actions={{
          onMove: async (target, parentId) => {
            const answer = (await actions?.onMove?.(target, parentId)) ?? null
            if (!answer) setDialog(null)
            return answer
          },
          onArchive: async (target) => {
            const answer = (await actions?.onArchive?.(target)) ?? null
            if (!answer) setDialog(null)
            return answer
          },
        }}
      />
    </div>
  )
}

function PlaceCard({ model, actions, location, parent, editable, parentHref, siteName, onMove }: { model: LocationRecordModel; actions?: LocationRecordActions; location: LocationView; parent: LocationView | null; editable: boolean; parentHref: string; siteName: string; onMove: () => void }) {
  const t = useT('warehouse-locations')
  const stock = useT('stock')
  const locale = useLocale()
  const saved = editOf(location)
  const [draft, setDraft] = useState<PlaceEdit>(model.draft ?? saved)
  const [refusal, setRefusal] = useState<Refusal>(null)
  const [busy, setBusy] = useState(false)
  const changes = editChanges(saved, draft)
  const problem = editProblem(draft)

  const save = async () => {
    if (!actions?.onSave || busy || problem || changes === 0) return
    setBusy(true)
    const answer = await actions.onSave({ name: draft.name.trim(), kind: draft.kind })
    setBusy(false)
    setRefusal(answer)
  }

  const fields: { label: string; value: ReactNode; hint?: ReactNode }[] = [
    { label: t('lc.field.code'), value: <span className="fw-lc-code">{location.code}</span>, hint: t('lc.record.codeFixed') },
    { label: t('lc.field.parent'), value: parent ? <Link className="fw-st-link" href={parentHref}>{`${parent.code} · ${parent.name}`}</Link> : t('lc.new.top', { site: siteName }) },
  ]
  return (
    <Card padded>
      <div className="fw-lc-card">
        <h2 className="fw-lc-card-title">{t('lc.record.placeTitle')}</h2>
        <KeyValue dense labelCase="sentence" items={fields} />
        {editable && (
          <Button size="sm" onClick={onMove} className="fw-lc-inline-button">
            <ArrowLeftRight size={13} aria-hidden /> {t('lc.menu.move')}
          </Button>
        )}
        {editable ? (
          <form
            className="fw-lc-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            {refusal && !refusal.field && <Banner tone="danger" title={t(refusal.key)} />}
            <div className="fw-lc-pair">
              <Field label={t('lc.field.name')} required error={problem ? t(problem) : refusal?.field === 'name' ? t(refusal.key) : undefined}>
                <Input value={draft.name} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              </Field>
              <Field label={t('lc.field.kind')}>
                <Select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as LocationKind }))}>
                  {LOCATION_KIND_LIST.map((kind) => (
                    <option key={kind} value={kind}>
                      {stock(`locationKind.${kind}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {changes > 0 ? (
              <SaveBar
                count={changes}
                save={t('lc.save.save')}
                held={busy ? t('lc.busy') : problem ? t(problem) : null}
                busy={busy}
                onDiscard={() => {
                  setDraft(saved)
                  setRefusal(null)
                }}
                onSave={() => void save()}
              />
            ) : (
              <p className="fw-st-sub" role="status">
                {model.savedAt ? t('lc.save.saved', { time: formatTime(model.savedAt, { locale, timeZone: model.timeZone }) }) : t('lc.save.allSaved')}
              </p>
            )}
          </form>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('lc.field.name'), value: location.name },
              { label: t('lc.field.kind'), value: stock(`locationKind.${location.kind}`) },
            ]}
          />
        )}
        {!model.can.manage && <p className="fw-lc-note">{t('lc.held.noManage')}</p>}
      </div>
    </Card>
  )
}

function StockTab({ model, actions, site, location }: { model: LocationRecordModel; actions?: LocationRecordActions; site: SiteLocations; location: LocationView }) {
  const t = useT('warehouse-locations')
  const stock = useT('stock')
  const locale = useLocale()
  const unit = (uom: Uom) => stock(`uom.${uom}`)
  const overview = model.stock.value
  const rows = useMemo(() => (overview ? recordStockRows(overview, location.id, site.locations, model.includeInside) : null), [overview, location.id, site.locations, model.includeInside])
  const rowId = (row: StockRow) => `${row.location.id}|${row.item.id}|${row.colour?.id ?? ''}|${row.lot?.id ?? ''}|${row.hide?.id ?? ''}`

  const columns = useMemo<ColDef<StockRow>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<StockRow>) =>
      data ? (
        <span className="fw-st-cell">
          <span className="fw-st-ellipsis">{`${data.item.code} · ${data.item.name}`}</span>
          <span className="fw-st-sub">{data.colour ? `${data.colour.code} ${data.colour.name}` : '—'}</span>
        </span>
      ) : null
    const LotCell = ({ data }: ICellRendererParams<StockRow>) => {
      if (!data) return null
      if (!data.lot && !data.hide) return <span className="fw-st-sub">{t('lc.stock.noLot')}</span>
      return (
        <span className="fw-st-cell">
          {data.lot ? (
            <Link className="fw-st-link" href={`${model.prefix}${recordAddress({ type: 'Lot', id: data.lot.id, label: data.lot.code }, OFFICE_PAGES)}`}>
              {data.lot.code}
            </Link>
          ) : null}
          {data.hide ? (
            <Link className="fw-st-link fw-st-sub" href={`${model.prefix}${recordAddress({ type: 'Hide', id: data.hide.id, label: data.hide.code }, OFFICE_PAGES)}`}>
              {data.hide.code}
            </Link>
          ) : null}
        </span>
      )
    }
    const PlaceCell = ({ data }: ICellRendererParams<StockRow>) =>
      data ? (
        <Link className="fw-st-link" href={`${model.prefix}/warehouse/locations/${encodeURIComponent(data.location.id)}`}>
          {data.location.code}
        </Link>
      ) : null
    const QualityCell = ({ data }: ICellRendererParams<StockRow>) => (data?.lot ? <Pill tone={QUALITY_TONE[data.lot.qualityStatus]}>{stock(`quality.${data.lot.qualityStatus}`)}</Pill> : <span className="fw-st-sub">—</span>)
    const OnHandCell = ({ data }: ICellRendererParams<StockRow>) =>
      data ? (
        <Link
          className="fw-st-link fw-st-num"
          title={t('lc.stock.toMoves')}
          href={movesHref(model.prefix, { siteId: data.siteId, itemId: data.item.id, itemColourId: data.colour?.id, lotId: data.lot?.id, hideId: data.hide?.id, locationId: data.location.id, why: true })}
        >
          {`${quantity(data.onHand, locale)} ${unit(data.item.baseUom)}`}
        </Link>
      ) : null
    const number = (pick: (row: StockRow) => string) => ({ data }: ICellRendererParams<StockRow>) => (data ? <span className="fw-st-num">{`${quantity(pick(data), locale)} ${unit(data.item.baseUom)}`}</span> : null)
    const ValueCell = ({ data }: ICellRendererParams<StockRow>) => (data ? <span className="fw-st-num">{money(data.value ?? null, currencyOf(overview, data.item.id), locale)}</span> : null)
    return [
      { colId: 'material', headerName: t('lc.stock.col.material'), minWidth: 220, flex: 1.8, cellRenderer: MaterialCell },
      { colId: 'lot', headerName: t('lc.stock.col.lot'), minWidth: 150, flex: 1, cellRenderer: LotCell },
      ...(model.includeInside ? [{ colId: 'place', headerName: t('lc.stock.col.place'), minWidth: 130, flex: 0.8, cellRenderer: PlaceCell } satisfies ColDef<StockRow>] : []),
      { colId: 'quality', headerName: t('lc.stock.col.quality'), minWidth: 120, flex: 0.7, cellRenderer: QualityCell },
      { colId: 'onHand', headerName: t('lc.stock.col.onHand'), minWidth: 120, flex: 0.8, type: 'rightAligned', cellRenderer: OnHandCell },
      { colId: 'held', headerName: t('lc.stock.col.held'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: number((row) => row.held) },
      { colId: 'available', headerName: t('lc.stock.col.available'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: number((row) => row.available) },
      ...(model.can.cost ? [{ colId: 'value', headerName: stock('money.value'), minWidth: 110, flex: 0.7, type: 'rightAligned', cellRenderer: ValueCell } satisfies ColDef<StockRow>] : []),
    ]
  }, [t, stock, locale, model.prefix, model.includeInside, model.can.cost, overview])

  const totals = rows ? unitTotals(sumPerUnit(rows, (row) => ({ uom: row.item.baseUom, quantity: row.onHand })), unit, locale) : '—'
  const inside = site.locations.some((entry) => entry.parentId === location.id)
  return (
    <ListFrame<StockRow>
      label={t('lc.stock.tableLabel', { code: location.code })}
      rows={model.stock.problem ? [] : rows}
      rowId={rowId}
      columns={columns}
      count={rows ? t('lc.stock.count', { count: rows.length, totals }) : '—'}
      tools={
        inside ? (
          <label className="fw-lc-switch">
            <Toggle size="sm" checked={model.includeInside} onChange={(next) => actions?.onIncludeInside?.(next)} aria-label={t('lc.stock.includeInside')} />
            <span>{t('lc.stock.includeInside')}</span>
          </label>
        ) : undefined
      }
      updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
      state={rows && rows.length === 0 && !model.stock.problem ? <EmptyState icon={<Boxes size={22} aria-hidden />} title={t('lc.stock.nothingHere')} description={inside && !model.includeInside ? t('lc.stock.tryInside') : undefined} /> : undefined}
    />
  )
}
