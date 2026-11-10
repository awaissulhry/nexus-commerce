'use client'

import { useEffect, useMemo, useState, type RefObject } from 'react'
import Link from 'next/link'
import { Archive, MoreHorizontal, Stamp } from 'lucide-react'
import { Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Select, TokenChip } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { SwatchRow } from '../../_shared/Swatch'
import { keepLoaded } from '../../library/model'
import { listState, showsState } from '../../library/parts'
import { pictureAddress, searchOf, SET_VIEWS, STATUS_TONE, SWATCHES_SHOWN, type BrandingSetRow } from '../model'
import type { ColoursActions, ColoursViewModel } from '../view-model'

/**
 * SCR-118 sec:colours.branding — the branding sets of private-label customers (PRD-045): customer, logos, label artwork,
 * brand colours, the styles that read it; on the shared list frame (select-all, shift range, x; Archive N; keys in the
 * footer's icon). A row opens the set in its DetailModal (`?open=<id>`, a real link: ⌘-click opens a new tab). Fetches
 * nothing.
 */
export function BrandingSection({ model, actions, sectionRef }: { model: ColoursViewModel; actions?: ColoursActions; sectionRef?: RefObject<HTMLElement | null> }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const items = model.sets.items
  const [selected, setSelected] = useState<readonly string[]>(model.selectedSets ?? [])
  const [archiving, setArchiving] = useState(model.dialog === 'archiveSets')
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => keepLoaded(current, items)), [rowsKey])
  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const openHref = (row: BrandingSetRow) => `${model.prefix}/products/colours${searchOf(model.filters, { open: row.id })}`

  const columns = useMemo<ColDef<BrandingSetRow>[]>(() => {
    const CustomerCell = ({ data }: ICellRendererParams<BrandingSetRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <span>{data.party.name}</span>
          <span className="fw-lib-sub">{data.party.code}</span>
        </span>
      ) : null
    const SetCell = ({ data }: ICellRendererParams<BrandingSetRow>) =>
      data ? (
        <span className="fw-lib-cell">
          <Link className="fw-lib-rowlink" href={openHref(data)} onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey) return
            event.preventDefault()
            actions?.onOpenSet?.(data.id)
          }}>
            {data.code}
          </Link>
          <span className="fw-lib-sub">{data.name}</span>
        </span>
      ) : null
    const LogoCell = ({ data }: ICellRendererParams<BrandingSetRow>) => {
      if (!data) return null
      const src = pictureAddress(data.logo?.url)
      return (
        <span className="fw-col-logo-cell">
          {src ? <img className="fw-col-logo" src={src} alt={t('sets.logoOf', { code: data.party.code })} loading="lazy" /> : null}
          <span className={data.logos === 0 ? 'fw-lib-hint' : undefined}>{data.logos === 0 ? t('sets.none') : t('sets.files', { count: data.logos })}</span>
        </span>
      )
    }
    const ArtworkCell = ({ data }: ICellRendererParams<BrandingSetRow>) => (data ? <span className={data.artwork === 0 ? 'fw-lib-hint' : undefined}>{data.artwork === 0 ? t('sets.none') : t('sets.files', { count: data.artwork })}</span> : null)
    const ColoursCell = ({ data }: ICellRendererParams<BrandingSetRow>) =>
      data ? data.colours.length === 0 ? <span className="fw-lib-hint">{t('sets.none')}</span> : <SwatchRow colours={data.colours} max={SWATCHES_SHOWN} noHex={t('swatch.noHex')} more={(count) => t('sets.moreColours', { count })} /> : null
    const StylesCell = ({ data }: ICellRendererParams<BrandingSetRow>) =>
      data ? data.stylesLinked === null ? <span className="fw-lib-hint">{t('sets.notInUse')}</span> : <span>{t('sets.styles', { count: data.stylesLinked })}</span> : null
    const StatusCell = ({ data }: ICellRendererParams<BrandingSetRow>) => (data ? <Pill tone={STATUS_TONE[data.status]}>{t(`setStatus.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<BrandingSetRow>) =>
      data ? (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('sets.rowMenu', { code: data.code }) }}
          items={[
            { id: 'open', label: t('sets.open'), onSelect: () => actions?.onOpenSet?.(data.id) },
            { id: 'tab', label: tl('list.openNewTab'), href: openHref(data), target: '_blank' },
          ]}
        />
      ) : null
    return [
      { colId: 'customer', headerName: t('sets.col.customer'), minWidth: 170, flex: 1.3, cellRenderer: CustomerCell },
      { colId: 'set', headerName: t('sets.col.set'), field: 'code', minWidth: 170, flex: 1.3, cellRenderer: SetCell },
      { colId: 'logos', headerName: t('sets.col.logos'), minWidth: 130, flex: 0.9, cellRenderer: LogoCell },
      { colId: 'artwork', headerName: t('sets.col.artwork'), minWidth: 120, flex: 0.8, cellRenderer: ArtworkCell },
      { colId: 'colours', headerName: t('sets.col.colours'), minWidth: 150, flex: 1, cellRenderer: ColoursCell },
      { colId: 'styles', headerName: t('sets.col.styles'), minWidth: 120, flex: 0.8, cellRenderer: StylesCell },
      { colId: 'status', headerName: t('sets.col.status'), field: 'status', minWidth: 110, flex: 0.6, cellRenderer: StatusCell },
      { colId: 'more', headerName: tl('list.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, tl, model.prefix, model.filters, actions])

  const state = showsState(model.sets.problem, items)
    ? listState({
        problem: model.sets.problem,
        rows: items,
        filtered: model.filters.sets !== 'all',
        forbidden: { title: t('forbidden.title'), body: t('forbidden.body') },
        empty: { title: t('sets.empty.title'), body: t(model.can.branding ? 'sets.empty.body' : 'sets.empty.bodyView') },
        onRetry: () => actions?.onRetrySets?.(),
        onClear: () => actions?.onFilters?.({ ...model.filters, sets: 'all' }),
      })
    : undefined
  const archiveHeld = !model.can.branding ? t('held.noBranding') : picked.some((row) => row.status === 'ACTIVE') ? null : t('held.noneActiveSets')

  return (
    <section className="fw-col-branding" aria-labelledby="fw-col-branding-h" ref={sectionRef} tabIndex={-1}>
      <div className="fw-col-section-head">
        <h2 id="fw-col-branding-h" className="fw-col-h2">
          {t('sets.title')}
        </h2>
        <p className="fw-lib-hint">{t('sets.intro')}</p>
      </div>
      {model.filters.sets !== 'all' && (
        <div className="fw-lib-chips" aria-label={tl('list.activeFilters')}>
          <TokenChip removeLabel={tl('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, sets: 'all' })}>
            {t(`setsView.${model.filters.sets}`)}
          </TokenChip>
        </div>
      )}
      <ListFrame<BrandingSetRow>
        label={t('sets.label')}
        title={t('sets.title')}
        listKey="products.colours.2"
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? tl('list.count', { count: items.length, total: items.length }) : '—'}
        tools={
          <Select size="sm" aria-label={t('filter.sets')} value={model.filters.sets} onChange={(event) => actions?.onFilters?.({ ...model.filters, sets: event.target.value as ColoursViewModel['filters']['sets'] })}>
            {SET_VIEWS.map((view) => (
              <option key={view} value={view}>
                {t(`setsView.${view}`)}
              </option>
            ))}
          </Select>
        }
        right={
          <Button size="sm" heldReason={model.can.branding ? null : t('held.noBranding')} onClick={() => actions?.onNewSet?.(true)}>
            <Stamp size={13} aria-hidden /> {t('sets.new')}
          </Button>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <Button size="sm" variant="danger-outline" aria-label={t('sets.bulk.archive', { count: picked.length })} heldReason={archiveHeld} onClick={() => setArchiving(true)}>
              <Archive size={13} aria-hidden /> <SelectionLabel>{t('sets.bulk.archive', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => (row.status === 'ARCHIVED' ? t('sets.archivedRow') : null)}
        onOpen={(row) => actions?.onOpenSet?.(row.id)}
        state={state}
      />
      {archiving && <ArchiveSetsDialog rows={picked.filter((row) => row.status === 'ACTIVE')} busy={model.busy} actions={actions} onDone={() => setSelected([])} onClose={() => setArchiving(false)} />}
    </section>
  )
}

/** Archive the chosen sets: their brands' labels and tech packs no longer read them; one reason for all. */
function ArchiveSetsDialog({ rows, busy, actions, onDone, onClose }: { rows: readonly BrandingSetRow[]; busy: boolean; actions?: ColoursActions; onDone: () => void; onClose: () => void }) {
  const t = useT('products-colours')
  const tl = useT('library')
  const [reason, setReason] = useState('')
  const held = rows.length === 0 ? t('held.noneActiveSets') : busy ? tl('held.busy') : null
  const go = () => {
    if (held) return
    void actions?.onArchiveSets?.(rows.map((row) => row.id), reason.trim()).then((done) => {
      if (done) {
        onDone()
        onClose()
      }
    })
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('sets.archive.title', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{tl('common.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={go}>
            {t('sets.bulk.archive', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('sets.archive.reach')}</li>
          <li>{t('sets.archive.back')}</li>
        </ul>
        <ul className="fw-lib-list">
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.code}</b> · {row.party.name}
            </li>
          ))}
        </ul>
        <Field label={tl('dialog.reason')} hint={tl('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
