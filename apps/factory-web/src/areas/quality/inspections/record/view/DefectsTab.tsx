'use client'

import { useMemo, useRef, useState } from 'react'
import { Camera, MoreHorizontal, Plus, TriangleAlert } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { PhotoCapture } from '@nexus/ui/components/PhotoCapture/index'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { CellSaveMark, Modal } from '../../../../../lib/i18n/ds-parts'
import { DEFECT_CLASSES } from '@nexus/factory-domain/quality/final/rules'
import { usePhotoWords, PHOTO_KIT_NAMESPACE } from '../../../../../lib/ds-words/photo-capture'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { Section } from '../../../_shared/parts'
import { GarmentZoneMap, zoneWords } from '../../../defects/zones/GarmentZoneMap'
import type { DefectBody, FinalCell, PickedDefect } from '../../api'
import { changedLine, defectKey, defectWords, ncrFromDefectsHeld, photosOf, pickedDefectIds, withoutLine, withPicked, type DefectsTabModel } from '../../model'
import '../../inspections.css'

export interface DefectsTabActions {
  onLines?: (lines: readonly DefectBody[]) => void
  onPhoto?: (index: number, photo: Blob) => void
  onRetry?: () => void
  onDismiss?: () => void
  onRaiseNcr?: () => void
  /** B-W2b-17: the lines picked (their keys) and "Create NCR from N defects" (their saved ids). */
  onSelect?: (keys: readonly string[]) => void
  onRaiseNcrFrom?: (defectIds: readonly string[]) => void
  onDialog?: (dialog: { kind: 'pick' } | { kind: 'zone'; index: number } | { kind: 'photo'; index: number } | null) => void
}

const CLASS_TONE = { CRITICAL: 'danger', MAJOR: 'warning', MINOR: 'neutral' } as const

/**
 * Inspection › Defects & photos (design quality.inspections rec:Inspection/defects, ins-defects; B-W2a-67): every defect
 * found — the library's code with its words, the severity, where on the garment (GarmentZoneMap, or the list), how many
 * garments of the sample, the size, a photo with markup (the DS PhotoCapture) and a note — saved after each change (the
 * whole list, with the version read; the save state is said). Add defect picks from the library (the codes the floor's
 * tiles show). "Create NCR…" opens B-W2a-68's New NCR from the inspection (its prefill takes the worst and the lead library
 * defect, the zone and the garments of these lines). A signed inspection's defects are read only. Totals per severity are
 * the result's counts.
 */
export function DefectsTab({
  model,
  cells,
  sampleSize,
  held,
  canRaise,
  saved,
  dialog,
  actions,
}: {
  model: DefectsTabModel
  cells: readonly FinalCell[]
  sampleSize: number
  /** Why the defects cannot be changed (signed, not yours, no right), or null. */
  held: string | null
  canRaise: boolean
  /** B-W2b-17: the saved lines' ids by key (`<class>|<code>`): a line not saved yet cannot be picked for an NCR. */
  saved?: Readonly<Record<string, string>>
  dialog: { kind: 'pick' } | { kind: 'zone'; index: number } | { kind: 'photo'; index: number } | null
  actions?: DefectsTabActions
}) {
  return (
    <WithMessages namespaces={[PHOTO_KIT_NAMESPACE, 'defects']}>
      <Tab model={model} cells={cells} sampleSize={sampleSize} held={held} canRaise={canRaise} saved={saved} dialog={dialog} actions={actions} />
    </WithMessages>
  )
}

function Tab({ model, cells, sampleSize, held, canRaise, saved = {}, dialog, actions }: Parameters<typeof DefectsTab>[0]) {
  const t = useT('quality')
  const locale = useLocale()
  const editable = held === null
  const library = model.library.value
  const lines = model.lines
  const latest = useRef({ model, actions, lines })
  latest.current = { model, actions, lines }
  const counts = useMemo(
    () => DEFECT_CLASSES.map((klass) => ({ klass, count: lines.filter((line) => line.defectClass === klass).reduce((sum, line) => sum + line.quantity, 0) })),
    [lines],
  )
  // A row carries its photos (count, the first one's address) and the library's words, so a new photo or a late read
  // redraws its cells (the grid redraws a row whose data changed).
  const rows = useMemo(
    () =>
      lines.map((line, index) => {
        const own = photosOf(model.photos.value ?? [], line.code)
        return { ...line, index, photoCount: own.length, photoId: own[0]?.id ?? null, photoSrc: own[0] ? (model.photoSrc[own[0].id] ?? null) : null, words: defectWords(line.code, library, locale) }
      }),
    [lines, model.photos.value, model.photoSrc, library, locale],
  )
  type Row = (typeof rows)[number]

  const columns = useMemo<ColDef<Row>[]>(() => {
    const change = (index: number, patch: Partial<DefectBody>) => latest.current.actions?.onLines?.(changedLine(latest.current.lines, index, patch))
    const DefectCell = ({ data }: ICellRendererParams<Row>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.code}</span>
          <span className="fw-q-hint">{data.words ?? (data.defectCodeId ? t('defects.libraryWordsUnknown') : t('defects.typed'))}</span>
        </span>
      ) : null
    const ClassCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      if (!editable) return <Tag tone={CLASS_TONE[data.defectClass]}>{t(`defects.class.${data.defectClass}`)}</Tag>
      return (
        <Select size="xs" aria-label={t('defects.classFor', { code: data.code })} value={data.defectClass} onChange={(event) => change(data.index, { defectClass: event.target.value as DefectBody['defectClass'] })}>
          {DEFECT_CLASSES.map((klass) => (
            <option key={klass} value={klass}>
              {t(`defects.class.${klass}`)}
            </option>
          ))}
        </Select>
      )
    }
    const ZoneCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      const words = data.zone ? zoneWords(data.zone, locale) : t('defects.noZone')
      return editable ? (
        <Button size="sm" variant="quiet" aria-label={t('defects.zoneFor', { code: data.code, zone: words })} onClick={() => latest.current.actions?.onDialog?.({ kind: 'zone', index: data.index })}>
          {words}
        </Button>
      ) : (
        <span>{words}</span>
      )
    }
    const QuantityCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      if (!editable) return <span className="fw-q-num">{data.quantity}</span>
      return (
        <Input
          size="sm"
          inputMode="numeric"
          className="fw-q-qty"
          aria-label={t('defects.quantityFor', { code: data.code })}
          defaultValue={String(data.quantity)}
          key={`${data.code}:${data.defectClass}:${data.quantity}`}
          onBlur={(event) => {
            const next = Number(event.target.value.trim())
            if (next !== data.quantity) change(data.index, { quantity: Number.isFinite(next) ? next : data.quantity })
          }}
        />
      )
    }
    const CellCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      const cell = cells.find((entry) => entry.workOrderSizeId === data.workOrderSizeId)
      if (!editable) return <span>{cell ? `${cell.colourwayCode} ${cell.size}` : '—'}</span>
      return (
        <Select size="xs" aria-label={t('defects.cellFor', { code: data.code })} value={data.workOrderSizeId ?? ''} onChange={(event) => change(data.index, { workOrderSizeId: event.target.value || null })}>
          <option value="">{t('defects.anyCell')}</option>
          {cells.map((entry) => (
            <option key={entry.workOrderSizeId} value={entry.workOrderSizeId}>
              {entry.colourwayCode} {entry.size}
            </option>
          ))}
        </Select>
      )
    }
    const PhotoCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      return (
        <span className="fw-q-cell-row fw-q-photo-cell">
          {data.photoCount > 0 ? data.photoSrc ? <img className="fw-q-thumb" src={data.photoSrc} alt={t('defects.photoOf', { code: data.code })} /> : <Tag tone="info">{t('defects.photos', { count: data.photoCount })}</Tag> : <span className="fw-q-hint">{t('defects.noPhoto')}</span>}
          {data.photoCount > 1 && <span className="fw-q-hint">{t('defects.morePhotos', { count: data.photoCount - 1 })}</span>}
          {editable && (
            <Button size="sm" variant="quiet" aria-label={t('defects.addPhotoFor', { code: data.code })} onClick={() => latest.current.actions?.onDialog?.({ kind: 'photo', index: data.index })}>
              <Camera size={14} aria-hidden />
            </Button>
          )}
        </span>
      )
    }
    const NoteCell = ({ data }: ICellRendererParams<Row>) => {
      if (!data) return null
      if (!editable) return <span className="fw-q-hint">{data.note ?? ''}</span>
      return (
        <Input
          size="sm"
          aria-label={t('defects.noteFor', { code: data.code })}
          defaultValue={data.note ?? ''}
          key={`${data.code}:${data.defectClass}:${data.note ?? ''}`}
          onBlur={(event) => {
            const next = event.target.value.trim() || null
            if (next !== (data.note ?? null)) change(data.index, { note: next })
          }}
        />
      )
    }
    const ActionsCell = ({ data }: ICellRendererParams<Row>) =>
      data && editable ? (
        <Menu
          align="right"
          label={<MoreHorizontal size={16} aria-hidden />}
          triggerProps={{ 'aria-label': t('defects.menuFor', { code: data.code }) }}
          items={[
            { id: 'one-more', label: t('defects.oneMore'), onSelect: () => change(data.index, { quantity: data.quantity + 1 }) },
            { id: 'remove', label: t('defects.remove'), onSelect: () => latest.current.actions?.onLines?.(withoutLine(latest.current.lines, data.index)) },
          ]}
        />
      ) : null
    // Each column's value is what its cell shows: a changed value redraws the cell (a saved line, a new photo, late words).
    const column = (colId: string, headerName: string, cellRenderer: ColDef<Row>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }, value: (row: Row) => string): ColDef<Row> => ({
      colId,
      headerName,
      cellRenderer,
      sortable: false,
      valueGetter: (params) => (params.data ? value(params.data) : ''),
      ...size,
    })
    return [
      column('defect', t('defects.code'), DefectCell, { flex: 1.6, minWidth: 180 }, (row) => `${row.code}|${row.words ?? ''}`),
      column('class', t('defects.classLabel'), ClassCell, { flex: 1, minWidth: 130 }, (row) => row.defectClass),
      column('zone', t('defects.zone'), ZoneCell, { flex: 1.1, minWidth: 140 }, (row) => row.zone ?? ''),
      column('quantity', t('defects.quantity'), QuantityCell, { width: 110, minWidth: 100 }, (row) => String(row.quantity)),
      column('cell', t('defects.cell'), CellCell, { flex: 1, minWidth: 130 }, (row) => row.workOrderSizeId ?? ''),
      column('photo', t('defects.photo'), PhotoCell, { flex: 1.1, minWidth: 150 }, (row) => `${row.photoCount}|${row.photoSrc ?? ''}`),
      column('note', t('defects.note'), NoteCell, { flex: 1.5, minWidth: 170 }, (row) => row.note ?? ''),
      ...(editable ? [{ ...column('actions', t('col.actions'), ActionsCell, { width: 72, minWidth: 72 }, (row) => `${row.index}`), suppressHeaderMenuButton: true }] : []),
    ]
    // The cells read the latest model through the ref; the words, the cells and the right rebuild them.
  }, [t, locale, editable, cells])

  const raiseHeld = !canRaise ? t('raiseNcr.held.noRight') : null
  // B-W2b-17 ("Create NCR from N defects", design ins-defects): the picked lines; only saved ones can be picked.
  const picked = (model.selected ?? []).filter((key) => lines.some((line) => defectKey(line) === key))
  const fromHeld = ncrFromDefectsHeld(picked, saved, canRaise)
  const bulk = (
    <Button size="sm" variant="primary" heldReason={fromHeld ? t(fromHeld) : null} onClick={() => actions?.onRaiseNcrFrom?.(pickedDefectIds(picked, saved))} aria-label={t('defects.ncr.from', { count: picked.length })}>
      <TriangleAlert size={13} aria-hidden /> <SelectionLabel>{t('defects.ncr.from', { count: picked.length })}</SelectionLabel>
    </Button>
  )
  const zoneLine = dialog?.kind === 'zone' ? lines[dialog.index] : undefined
  const photoLine = dialog?.kind === 'photo' ? lines[dialog.index] : undefined

  return (
    <div className="fw-q-stack">
      {model.problem && (
        <Banner tone="warning" title={t(model.problem)} onDismiss={actions?.onDismiss}>
          {model.lines_refused && model.lines_refused.length > 0 && (
            <ul className="fw-q-lines">
              {model.lines_refused.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      <Section
        id="defects-found"
        title={t('defects.heading')}
        sub={
          <span className="fw-q-cell-row">
            {counts.map(({ klass, count }) => (
              <Tag key={klass} tone={CLASS_TONE[klass]}>
                {t('defects.countOf', { klass: t(`defects.class.${klass}`), count })}
              </Tag>
            ))}
            <span className="fw-q-hint" role="status">
              {model.saving === 'saving' ? (
                <>
                  <CellSaveMark state="saving" /> {t('defects.saving')}
                </>
              ) : model.saving === 'saved' ? (
                t('defects.saved')
              ) : model.saving === 'failed' ? (
                t('defects.notSaved')
              ) : null}
            </span>
          </span>
        }
        actions={
          <span className="fw-q-actions">
            <Button size="sm" onClick={() => actions?.onRaiseNcr?.()} heldReason={raiseHeld}>
              <TriangleAlert size={14} aria-hidden /> {t('row.createNcr')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'pick' })} heldReason={held ? t(held) : null}>
              <Plus size={14} aria-hidden /> {t('defects.add')}
            </Button>
          </span>
        }
      >
        {held && <p className="fw-q-hint">{t(held)}</p>}
        <ListFrame<Row>
          label={t('defects.heading')}
          listKey={null}
          rows={rows}
          rowId={(row) => defectKey(row)}
          columns={columns}
          count={t('defects.lines', { count: rows.length })}
          selection={{ selected: picked, onChange: (next) => actions?.onSelect?.(next), actions: bulk }}
          isRowSelectable={(row) => (saved[defectKey(row)] !== undefined ? null : t('defects.ncr.held.unsaved'))}
          state={
            lines.length === 0 ? (
              <EmptyState
                title={t('defects.none')}
                description={editable ? t('defects.noneHint') : undefined}
                action={
                  editable ? (
                    <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'pick' })}>
                      {t('defects.add')}
                    </Button>
                  ) : undefined
                }
              />
            ) : undefined
          }
        />
        <p className="fw-q-hint">{t('defects.sampleRule', { sample: sampleSize })}</p>
        {model.photos.problem && <p className="fw-q-hint">{t('defects.photosFailed')}</p>}
      </Section>

      <PickDialog
        open={dialog?.kind === 'pick'}
        library={model.library}
        onPick={(picked) => {
          actions?.onLines?.(withPicked(lines, picked))
          actions?.onDialog?.(null)
        }}
        onRetry={actions?.onRetry}
        onClose={() => actions?.onDialog?.(null)}
      />
      <Modal open={zoneLine !== undefined} onClose={() => actions?.onDialog?.(null)} title={t('defects.zoneTitle', { code: zoneLine?.code ?? '' })} size="lg">
        {zoneLine && (
          <GarmentZoneMap
            label={t('defects.zoneTitle', { code: zoneLine.code })}
            value={zoneLine.zone ?? null}
            onChange={(zone) => {
              if (dialog?.kind === 'zone') actions?.onLines?.(changedLine(lines, dialog.index, { zone }))
              actions?.onDialog?.(null)
            }}
          />
        )}
      </Modal>
      <PhotoDialog
        line={photoLine}
        uploading={photoLine ? model.uploading === photoLine.code : false}
        onCapture={(blob) => dialog?.kind === 'photo' && actions?.onPhoto?.(dialog.index, blob)}
        onClose={() => actions?.onDialog?.(null)}
      />
    </div>
  )
}

/** Add defect: the library's active defects for the final inspection, grouped by category, picked by name or code. */
function PickDialog({ open, library, onPick, onRetry, onClose }: { open: boolean; library: DefectsTabModel['library']; onPick: (picked: PickedDefect) => void; onRetry?: () => void; onClose: () => void }) {
  const t = useT('quality')
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const list = library.value ?? []
  const q = query.trim().toLowerCase()
  const shown = q ? list.filter((entry) => `${entry.code} ${entry.labelIt} ${entry.labelEn}`.toLowerCase().includes(q)) : list
  const groups = [...new Map(shown.map((entry) => [entry.category.id, entry.category])).values()]
  return (
    <Modal open={open} onClose={onClose} title={t('defects.pickTitle')} subtitle={t('defects.pickSubtitle')} size="lg">
      <div className="fw-q-form">
        {library.problem ? (
          <EmptyState
            title={t('defects.libraryFailed')}
            description={t(library.problem)}
            action={
              <Button size="sm" onClick={() => onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : library.value === null ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : list.length === 0 ? (
          <EmptyState title={t('defects.libraryEmpty')} description={t('defects.libraryEmptyHint')} />
        ) : (
          <>
            <Field label={t('defects.pickSearch')}>
              <Input size="sm" type="search" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
            </Field>
            {groups.map((category) => (
              <div key={category.id}>
                <h3 className="fw-q-group-title">{locale.startsWith('it') ? category.labelIt : category.labelEn}</h3>
                <ul className="fw-q-pick-grid">
                  {shown
                    .filter((entry) => entry.category.id === category.id)
                    .map((entry) => (
                      <li key={entry.id}>
                        <Button size="sm" onClick={() => onPick(entry)} aria-label={t('defects.pickOne', { code: entry.code, words: locale.startsWith('it') ? entry.labelIt : entry.labelEn, klass: t(`defects.class.${entry.severity}`) })}>
                          <span className="fw-q-cell">
                            <span>{locale.startsWith('it') ? entry.labelIt : entry.labelEn}</span>
                            <span className="fw-q-hint">
                              {entry.code} · {t(`defects.class.${entry.severity}`)}
                              {entry.zone ? ` · ${zoneWords(entry.zone, locale)}` : ''}
                            </span>
                          </span>
                        </Button>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
            {shown.length === 0 && <p className="fw-q-hint">{t('defects.pickNone')}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}

/** A defect's photo with markup (the DS PhotoCapture: camera or a file, arrows and circles; the marked copy is kept). */
function PhotoDialog({ line, uploading, onCapture, onClose }: { line: DefectBody | undefined; uploading: boolean; onCapture: (photo: Blob) => void; onClose: () => void }) {
  const t = useT('quality')
  const words = usePhotoWords()
  return (
    <Modal open={line !== undefined} onClose={onClose} title={t('defects.photoTitle', { code: line?.code ?? '' })} subtitle={t('defects.photoSubtitle')} size="lg">
      {line &&
        (uploading ? (
          <p className="fw-q-loading" role="status">
            <Spinner size={14} /> {t('defects.uploading')}
          </p>
        ) : (
          <PhotoCapture label={t('defects.photoTitle', { code: line.code })} words={words} onCapture={(photo) => onCapture(photo.marked ?? photo.photo)} onCancel={onClose} />
        ))}
    </Modal>
  )
}
