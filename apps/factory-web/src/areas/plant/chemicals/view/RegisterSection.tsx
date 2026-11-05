'use client'

import { useEffect, useMemo } from 'react'
import { Archive, FlaskConical } from 'lucide-react'
import { EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select } from '@nexus/ui/primitives'
import { REGISTER_LAW, type ChemicalUse, type QuantityUnit } from '@nexus/factory-domain/safety/chemicals/rules'
import { Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { siteColumn } from '../../../../shell/scope/scope-context'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import type { Chemical } from '../api'
import { archiveHeld, CHEMICAL_USES, placeOf, quantityOf, sheetsText, sheetStateKey, type RegisterStatus } from '../model'
import type { ArchiveManyState, ChemicalsPageActions, ChemicalsPageModel } from '../view-model'
import { GhsMarks, PAGE_KEYS, SectionFailed, SectionHead, SectionLoading, useDay, useWords } from './parts'

const STATE_TONE = { MISSING: 'danger', OTHER_LANGUAGE: 'warning', OK: 'success' } as const

/**
 * The chemical register (design sec register; QHS-277, D.Lgs. 81/2008 art. 223): every product in use at the top bar's site
 * (with "All sites" a Site column and the site chip), as the list frame — Product with its supplier, Use, GHS pictograms, H
 * and P statements, Location / cabinet, Most kept, Roles that use it, SDS version and date — its filters (use, cabinet,
 * status, the words typed) in the address as the API's own; Enter opens the chemical's window; Archive N over the rows
 * chosen (one reason, one call each). Chemicals | Waste: waste stays Later (hidden until built). No money, no person.
 */
export function RegisterSection({ model, actions, onHelp }: { model: ChemicalsPageModel; actions?: ChemicalsPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const { address, scope } = model
  const answer = model.register.status === 'ready' ? model.register.value : null
  const canManage = model.can.manage && (answer?.canManage ?? true)
  const rows = answer?.chemicals ?? null
  const selected = model.selected ?? []
  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))

  const columns = useMemo<ColDef<Chemical>[]>(() => {
    const unit = (code: QuantityUnit) => t(`unit.${code}`)
    const NameCell = ({ data }: ICellRendererParams<Chemical>) =>
      data ? (
        <span className="fw-ch-cell">
          <span>{data.name}</span>
          <span className="fw-ch-muted">{data.supplier.name ?? t('register.noSupplier')}</span>
        </span>
      ) : null
    const GhsCell = ({ data }: ICellRendererParams<Chemical>) => (data ? <GhsMarks codes={data.ghsPictograms} say={t} /> : null)
    const SdsCell = ({ data }: ICellRendererParams<Chemical>) =>
      data ? (
        <span className="fw-ch-cell">
          <span>{sheetsText(data, day, t('sds.none'))}</span>
          {data.sheetState !== 'OK' && (
            <Pill tone={STATE_TONE[data.sheetState]} dot>
              {t(sheetStateKey(data.sheetState), { language: t(`lang.${data.language}`) })}
            </Pill>
          )}
        </span>
      ) : null
    const site = siteColumn<Chemical>(scope, (row) => row.siteId, t('register.col.site'))
    return [
      { colId: 'name', headerName: t('register.col.name'), minWidth: 220, flex: 1.6, valueGetter: (params) => params.data?.name ?? '', cellRenderer: NameCell },
      { colId: 'use', headerName: t('register.col.use'), minWidth: 120, flex: 0.8, valueGetter: (params) => (params.data ? t(`use.${params.data.use}`) : '') },
      { colId: 'pictograms', headerName: t('register.col.pictograms'), minWidth: 130, flex: 0.9, sortable: false, valueGetter: (params) => params.data?.ghsPictograms.join(' ') ?? '', cellRenderer: GhsCell },
      { colId: 'hazards', headerName: t('register.col.hazards'), minWidth: 150, flex: 1, cellClass: 'fw-ch-codes', valueGetter: (params) => params.data?.hazardStatements.join(' ') || (params.data ? '—' : '') },
      { colId: 'precautions', headerName: t('register.col.precautions'), minWidth: 150, flex: 1, cellClass: 'fw-ch-codes', valueGetter: (params) => params.data?.precautionStatements.join(' ') || (params.data ? '—' : '') },
      { colId: 'place', headerName: t('register.col.place'), minWidth: 180, flex: 1.2, valueGetter: (params) => (params.data ? placeOf(params.data) : '') },
      { colId: 'maxQuantity', headerName: t('register.col.maxQuantity'), minWidth: 110, flex: 0.6, valueGetter: (params) => (params.data ? (quantityOf(params.data, unit) ?? '—') : '') },
      { colId: 'roles', headerName: t('register.col.roles'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? params.data.roles.map((role) => role.name).join(', ') || '—' : '') },
      { colId: 'sds', headerName: t('register.col.sds'), minWidth: 190, flex: 1.2, valueGetter: (params) => (params.data ? sheetsText(params.data, day, t('sds.none')) : ''), cellRenderer: SdsCell },
      ...(site ? [site] : []),
      ...(address.status !== 'ACTIVE' ? [{ colId: 'status', headerName: t('register.col.status'), minWidth: 110, flex: 0.6, valueGetter: (params: { data?: Chemical }) => (params.data ? t(`status.${params.data.status}`) : '') } as ColDef<Chemical>] : []),
    ]
  }, [t, day, scope, address.status])

  const filters = (
    <span className="fw-ch-row">
      <Input size="sm" type="search" value={address.q} placeholder={t('register.search')} aria-label={t('register.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
      <Select size="sm" value={address.use ?? ''} aria-label={t('register.filterUse')} onChange={(event) => actions?.onAddress?.({ use: (event.target.value || null) as ChemicalUse | null })}>
        <option value="">{t('register.allUses')}</option>
        {CHEMICAL_USES.map((use) => (
          <option key={use} value={use}>
            {t(`use.${use}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.status} aria-label={t('register.filterStatus')} onChange={(event) => actions?.onAddress?.({ status: event.target.value as RegisterStatus })}>
        <option value="ACTIVE">{t('register.status.ACTIVE')}</option>
        <option value="ARCHIVED">{t('register.status.ARCHIVED')}</option>
        <option value="all">{t('register.status.all')}</option>
      </Select>
      {address.cabinet && (
        <Button size="sm" variant="quiet" aria-label={t('register.clearCabinet', { cabinet: address.cabinet })} onClick={() => actions?.onAddress?.({ cabinet: null })}>
          {t('register.cabinetChip', { cabinet: address.cabinet })} ×
        </Button>
      )}
      {address.tile && (
        <Button size="sm" variant="quiet" aria-label={t('register.clearTile')} onClick={() => actions?.onAddress?.({ tile: null })}>
          {t(`tile.${address.tile}.label`)} ×
        </Button>
      )}
    </span>
  )

  const head = (
    <SectionHead id="fw-ch-register" title={t('register.title')} note={<LawRef law={answer?.law.register ?? REGISTER_LAW} plain={t('law.register')} labels={ds.lawRef} />}>
      <span className="fw-ch-muted">{t('register.wasteLater')}</span>
      <ScopeSiteChip model={scope} />
    </SectionHead>
  )

  if (model.register.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('register.failed')} problem={model.register.problem} onRetry={actions?.onRetryRegister} />
      </>
    )
  }
  if (!answer) {
    return (
      <>
        {head}
        <SectionLoading rows={6} />
      </>
    )
  }

  const filtered = address.q !== '' || address.use !== null || address.cabinet !== null || address.tile !== null || address.status !== 'ACTIVE'
  return (
    <>
      {head}
      <ListFrame<Chemical>
        label={t('register.label')}
        title={t('register.title')}
        listKey="plant.chemicals"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('register.count', { count: answer.chemicals.length })}
        search={filters}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          exportSelected: true,
          actions: canManage ? (
            <Button size="sm" variant="primary" aria-label={t('bulk.archive', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneActive') : null} onClick={() => actions?.onArchiveMany?.(picked.map((row) => row.id))}>
              <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: picked.length })}</SelectionLabel>
            </Button>
          ) : null,
        }}
        isRowSelectable={canManage ? (row) => (row.status === 'ACTIVE' ? null : t('held.archivedRow')) : undefined}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ open: row.id })}
        more={answer.complete ? null : { label: t('register.more'), onMore: () => undefined, held: t('register.moreHeld') }}
        state={
          answer.chemicals.length === 0 ? (
            filtered ? (
              <EmptyState icon={<FlaskConical size={22} aria-hidden />} title={t('register.noneFiltered')} description={t('register.noneFilteredHint')} />
            ) : (
              <EmptyState
                icon={<FlaskConical size={22} aria-hidden />}
                title={t('register.emptyTitle')}
                description={t('register.empty')}
                action={
                  canManage && model.companyId ? (
                    <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ add: true })}>
                      {t('band.add')}
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { name: { role: 'title' }, use: { role: 'subtitle' } } }}
      />
    </>
  )
}

/** Archive N: one reason for every chemical chosen (one call each); their sheets are kept. */
export function ArchiveManyDialog({ model, state, actions }: { model: ChemicalsPageModel; state: ArchiveManyState; actions?: ChemicalsPageActions | undefined }) {
  const t = useWords()
  const rows = (model.register.status === 'ready' ? model.register.value.chemicals : []).filter((row) => state.ids.includes(row.id))
  const held = archiveHeld(state.reason, state.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onArchiveMany?.(null)}
      title={t('archive.bulkTitle', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onArchiveMany?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onApplyArchiveMany?.()}>
            {t('bulk.archive', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-ch-form">
        <ul className="fw-ch-list">
          {rows.map((row) => (
            <li key={row.id}>{`${row.name} · ${placeOf(row)}`}</li>
          ))}
        </ul>
        <p className="fw-ch-muted">{t('archive.kept')}</p>
        <Field label={t('archive.reason')} required>
          <Textarea value={state.reason} rows={3} onChange={(event) => actions?.onArchiveManyReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
