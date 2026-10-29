'use client'

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, Minus, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Modal, SummaryTable } from '@nexus/ui/components'
import { EditModeBar } from '@nexus/ui/patterns'
import { Button, Input, Pill, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { CoverageCell, StyleView } from '../../api'
import { RangeFields, type RangeValue } from '../../forms'
import { CELL_TONE, matrixCells, moveCell, rangeEffect, rowToggle, type MatrixCellState } from '../../model'
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import '../../../../../list-frame/list-frame.css'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'

/**
 * SCR-041 Colourways & sizes: the size range (scale, sizes, base size; Apply says first how many SKUs it adds or
 * switches off), the body measures of the range, the colourways (main colour from the library), and the colour × size
 * SKU matrix — Space switches a cell, Shift+Space a whole colourway, the arrows move, Enter opens the cell (SKU, GTIN,
 * certificate coverage). A cell a valid certificate does not cover carries a mark (it blocks release, labels and
 * shipping of that cell).
 */
export function VariantsTab({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  return (
    <div className="fw-st-stack-lg">
      <RangeCard style={style} model={model} actions={actions} />
      <div className="fw-st-pair">
        <ColourwaysCard style={style} model={model} actions={actions} />
        <MeasuresCard style={style} />
      </div>
      <MatrixCard style={style} model={model} actions={actions} />
    </div>
  )
}

function RangeCard({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const base = useMemo<RangeValue>(() => ({ sizeScaleId: style.sizeScale.id, sizes: [...style.sizes], baseSize: style.baseSize }), [style])
  const [draft, setDraft] = useState<RangeValue>(model.rangeDraft ?? base)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(model.rangeDraft ?? base), [base, model.rangeDraft])
  const editable = model.can.manage && style.status !== 'ARCHIVED'
  const dirty = draft.sizeScaleId !== base.sizeScaleId || draft.baseSize !== base.baseSize || draft.sizes.join(',') !== base.sizes.join(',')
  const effect = rangeEffect(style, draft.sizes)
  const held = draft.sizes.length === 0 ? t('range.held.empty') : draft.baseSize === null ? t('range.held.base') : saving ? t('held.busy') : null
  const save = async () => {
    if (held || !dirty) return
    setSaving(true)
    const done = (await actions?.onSaveRange?.(draft)) ?? false
    setSaving(false)
    if (done) setDraft(base)
  }
  return (
    <Card header={t('range.title')} description={editable ? t('range.intro') : t('identity.readOnly')}>
      <RangeFields value={draft} scales={model.libraries.scales} onChange={setDraft} scaleLocked={style.matrix.generated ? 'range.scaleLocked' : null} readOnly={!editable} />
      {dirty && (
        <>
          {(effect.added.length > 0 || effect.removed.length > 0) && (
            <Banner tone={effect.skusOff > 0 ? 'warning' : 'info'} title={t('range.effectTitle')}>
              <ul className="fw-st-list">
                {effect.added.length > 0 && <li>{t(style.matrix.generated ? 'range.effectAdd' : 'range.effectAddPlain', { sizes: effect.added.join(', '), count: effect.skusOn })}</li>}
                {effect.removed.length > 0 && <li>{t(style.matrix.generated ? 'range.effectRemove' : 'range.effectRemovePlain', { sizes: effect.removed.join(', '), count: effect.skusOff })}</li>}
              </ul>
            </Banner>
          )}
          <EditModeBar message={t('range.unsaved')} count={1} onDiscard={() => setDraft(base)} onApply={() => void save()} applyLabel={t('range.apply')} applyHeldReason={held} busy={saving} saveShortcut />
        </>
      )}
    </Card>
  )
}

function MeasuresCard({ style }: { style: StyleView }) {
  const t = useT('products')
  const points = [...new Set(style.range.flatMap((size) => Object.keys(size.bodyMeasures ?? {})))]
  return (
    <Card header={t('measures.title')} description={t('measures.intro')}>
      {points.length === 0 ? (
        <p className="fw-st-hint">{t('measures.none')}</p>
      ) : (
        <div className="fw-st-scroll">
          <SummaryTable
            label={t('measures.title')}
            columns={[t('measures.size'), ...points]}
            align={[undefined, ...points.map(() => 'right' as const)]}
            rows={style.range.map((size) => ({
              id: size.code,
              cells: [
                <span key="s" className="fw-st-inline">
                  <b>{size.code}</b>
                  {size.code === style.baseSize && <Tag tone="info">{t('range.baseMark')}</Tag>}
                </span>,
                ...points.map((point) => {
                  const measure = size.bodyMeasures?.[point]
                  return measure ? `${measure.min ?? '…'}–${measure.max ?? '…'} ${measure.unit}` : '—'
                }),
              ],
            }))}
          />
        </div>
      )}
    </Card>
  )
}

function Swatch({ hex, label }: { hex: string | null | undefined; label: string }) {
  return hex ? <span className="fw-st-swatch" style={{ background: hex }} role="img" aria-label={label} /> : <span className="fw-st-swatch is-empty" aria-hidden />
}
export { Swatch }

function ColourwaysCard({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const editable = model.can.manage && style.status !== 'ARCHIVED'
  const skusOn = (colourwayId: string) => style.skus.filter((sku) => sku.colourwayId === colourwayId && sku.status === 'ACTIVE').length
  return (
    <Card
      header={t('colourways.title', { count: style.colourways.length })}
      description={t('colourways.intro')}
      headerAction={
        <Button size="sm" heldReason={editable ? null : t(style.status === 'ARCHIVED' ? 'held.archived' : 'held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'colourway', colourwayId: null })}>
          <Plus size={13} aria-hidden /> {t('colourways.add')}
        </Button>
      }
    >
      {style.colourways.length === 0 ? (
        <EmptyState title={t('colourways.empty.title')} description={t('colourways.empty.body')} />
      ) : (
        <SummaryTable
          label={t('colourways.title', { count: style.colourways.length })}
          density="roomy"
          stackOnPhone
          columns={[t('colourways.col.colourway'), t('colourways.col.colour'), t('colourways.col.skus'), t('colourways.col.status'), t('colourways.col.actions')]}
          widths={['34%', '22%', '12%', '14%', undefined]}
          rows={style.colourways.map((colourway) => ({
            id: colourway.id,
            cells: [
              <span key="c" className="fw-st-cellstack">
                <span className="fw-st-inline">
                  <Swatch hex={colourway.colour?.hex} label={colourway.colour?.name ?? colourway.name} />
                  <b>{colourway.code}</b> {colourway.name}
                </span>
                {colourway.description && <span className="nds-summary-sub">{colourway.description}</span>}
              </span>,
              colourway.colour ? `${colourway.colour.code} · ${colourway.colour.name}` : '—',
              String(skusOn(colourway.id)),
              <Pill key="s" tone={colourway.status === 'ACTIVE' ? 'success' : 'neutral'}>
                {t(`masterStatus.${colourway.status}`)}
              </Pill>,
              <span key="a" className="fw-st-inline">
                <Button size="sm" variant="quiet" heldReason={editable ? null : t(style.status === 'ARCHIVED' ? 'held.archived' : 'held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'colourway', colourwayId: colourway.id })} aria-label={t('colourways.editOne', { code: colourway.code })}>
                  {t('colourways.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  heldReason={editable ? null : t(style.status === 'ARCHIVED' ? 'held.archived' : 'held.noManage')}
                  onClick={() => actions?.onColourwayStatus?.(colourway.id, colourway.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')}
                  aria-label={t(colourway.status === 'ACTIVE' ? 'colourways.archiveOne' : 'colourways.restoreOne', { code: colourway.code })}
                >
                  {t(colourway.status === 'ACTIVE' ? 'colourways.archive' : 'colourways.restore')}
                </Button>
              </span>,
            ],
          }))}
        />
      )}
    </Card>
  )
}

function MatrixCard({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const editable = model.can.manage && style.status !== 'ARCHIVED'
  const rows = useMemo(() => matrixCells(style), [style])
  const sizes = style.matrix.sizes
  const coverage = model.compliance.status === 'ready' && model.compliance.value.coverage.required ? model.compliance.value.coverage.cells : null
  const coverageOf = (colourwayId: string, size: string): CoverageCell | null => coverage?.find((cell) => cell.colourwayId === colourwayId && cell.size === size) ?? null
  const [at, setAt] = useState({ row: 0, col: 0 })
  const [open, setOpen] = useState<{ row: number; col: number } | null>(null)
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const heldWhy = editable ? null : t(style.status === 'ARCHIVED' ? 'held.archived' : 'held.noManage')

  const toggle = (cell: MatrixCellState) => {
    if (!editable || !cell.sku || cell.state === 'closed') return
    void actions?.onSkus?.([{ skuId: cell.sku.id, version: cell.sku.version, status: cell.state === 'on' ? 'ARCHIVED' : 'ACTIVE' }])
  }
  const toggleRow = (index: number) => {
    if (!editable) return
    const changes = rowToggle(rows[index] ?? [])
    if (changes.length > 0) void actions?.onSkus?.(changes)
  }
  const toggleColumn = (col: number) => {
    if (!editable) return
    const changes = rowToggle(rows.map((row) => row[col]!).filter(Boolean))
    if (changes.length > 0) void actions?.onSkus?.(changes)
  }
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, row: number, col: number) => {
    const cell = rows[row]?.[col]
    if (!cell) return
    if (event.key === ' ') {
      event.preventDefault()
      if (event.shiftKey) toggleRow(row)
      else toggle(cell)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      setOpen({ row, col })
      return
    }
    const next = moveCell({ row, col }, event.key, rows.length, sizes.length)
    if (next.row !== row || next.col !== col) {
      event.preventDefault()
      setAt(next)
      refs.current.get(`${next.row}:${next.col}`)?.focus()
    }
  }

  const missing = style.matrix.missing
  const cellOpen = open ? rows[open.row]?.[open.col] ?? null : null
  return (
    <Card
      header={t('matrix.title')}
      description={t('matrix.intro')}
      headerAction={
        <Button size="sm" variant={missing > 0 ? 'primary' : 'secondary'} heldReason={heldWhy ?? (missing === 0 ? t('matrix.nothingToGenerate') : null)} onClick={() => actions?.onDialog?.({ kind: 'generate' })}>
          {missing > 0 ? t('matrix.generate', { count: missing }) : t('matrix.generateNone')}
        </Button>
      }
    >
      {rows.length === 0 || sizes.length === 0 ? (
        <EmptyState title={t('matrix.empty.title')} description={t('matrix.empty.body')} />
      ) : (
        <div className="fw-st-stack">
          <div className="fw-st-scroll">
            <table className="fw-st-matrix" aria-label={t('matrix.title')}>
              <thead>
                <tr>
                  <th scope="col" className="fw-st-matrix-corner">
                    {t('matrix.colourway')}
                  </th>
                  {sizes.map((size, col) => (
                    <th key={size.code} scope="col" className={size.code === style.baseSize ? 'is-base' : undefined}>
                      <button type="button" className="fw-st-matrix-head" onClick={() => toggleColumn(col)} aria-label={t('matrix.toggleColumn', { size: size.code })} title={heldWhy ?? undefined} aria-disabled={!editable || undefined}>
                        {size.code}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => {
                  const colourway = style.colourways.find((entry) => entry.id === row[0]?.colourwayId) ?? style.colourways[rowIndex]
                  return (
                    <tr key={colourway?.id ?? rowIndex}>
                      <th scope="row">
                        <button type="button" className="fw-st-matrix-row" onClick={() => toggleRow(rowIndex)} aria-label={t('matrix.toggleRow', { code: colourway?.code ?? '' })} title={heldWhy ?? undefined} aria-disabled={!editable || undefined}>
                          <Swatch hex={colourway?.colour?.hex} label={colourway?.colour?.name ?? colourway?.name ?? ''} />
                          <b>{colourway?.code}</b>
                          <span className="fw-st-hide-phone">{colourway?.name}</span>
                        </button>
                      </th>
                      {row.map((cell, col) => {
                        const cover = coverageOf(cell.colourwayId, cell.size)
                        const uncovered = cover && cell.state === 'on' && cover.status !== 'COVERED' && cover.status !== 'NOT_REQUIRED'
                        const active = at.row === rowIndex && at.col === col
                        return (
                          <td key={cell.size} className={`is-${cell.state}${cell.size === style.baseSize ? ' is-base' : ''}`}>
                            <button
                              type="button"
                              ref={(node) => {
                                if (node) refs.current.set(`${rowIndex}:${col}`, node)
                                else refs.current.delete(`${rowIndex}:${col}`)
                              }}
                              className="fw-st-matrix-cell"
                              tabIndex={active ? 0 : -1}
                              aria-pressed={cell.state === 'on'}
                              aria-label={t(`matrix.cell.${cell.state}`, { colourway: colourway?.code ?? '', size: cell.size, sku: cell.sku?.sku ?? '' }) + (uncovered ? ` · ${t('matrix.notCovered')}` : '')}
                              onFocus={() => setAt({ row: rowIndex, col })}
                              onClick={() => setOpen({ row: rowIndex, col })}
                              onKeyDown={(event) => onKey(event, rowIndex, col)}
                            >
                              {cell.state === 'on' ? <Check size={14} aria-hidden /> : cell.state === 'none' ? <Plus size={13} aria-hidden /> : <Minus size={13} aria-hidden />}
                              {cell.sku?.gtin && <span className="fw-st-matrix-mark">GTIN</span>}
                              {uncovered && <span className="fw-st-matrix-flag" aria-hidden />}
                            </button>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="fw-st-legend-row">
            <span className="fw-st-inline">
              <Check size={13} aria-hidden /> {t('matrix.legend.on')}
            </span>
            <span className="fw-st-inline">
              <Minus size={13} aria-hidden /> {t('matrix.legend.off')}
            </span>
            <span className="fw-st-inline">
              <Plus size={13} aria-hidden /> {t('matrix.legend.none')}
            </span>
            {coverage && (
              <span className="fw-st-inline">
                <span className="fw-st-matrix-flag is-legend" aria-hidden /> {t('matrix.legend.notCovered')}
              </span>
            )}
            <span className="fw-st-grow" />
            <ListKeysInfo
              keys={[
                { keys: ['←', '→', '↑', '↓'], does: t('matrix.keys.move') },
                { keys: ['Space'], does: t('matrix.keys.cell') },
                { keys: ['⇧', 'Space'], does: t('matrix.keys.row') },
                { keys: ['↵'], does: t('matrix.keys.open') },
              ]}
              onHelp={() => actions?.onDialog?.({ kind: 'help' })}
            />
          </div>
        </div>
      )}
      {cellOpen && (
        <SkuCellDialog
          style={style}
          cell={cellOpen}
          cover={coverageOf(cellOpen.colourwayId, cellOpen.size)}
          held={heldWhy}
          busy={model.busy}
          onClose={() => setOpen(null)}
          onToggle={() => {
            toggle(cellOpen)
            setOpen(null)
          }}
          onGtin={async (gtin) => {
            if (!cellOpen.sku) return false
            const done = (await actions?.onSkus?.([{ skuId: cellOpen.sku.id, version: cellOpen.sku.version, gtin }])) ?? false
            if (done) setOpen(null)
            return done
          }}
        />
      )}
    </Card>
  )
}

function SkuCellDialog({ style, cell, cover, held, busy, onClose, onToggle, onGtin }: { style: StyleView; cell: MatrixCellState; cover: CoverageCell | null; held: string | null; busy: boolean; onClose: () => void; onToggle: () => void; onGtin: (gtin: string | null) => Promise<boolean> }) {
  const t = useT('products')
  const colourway = style.colourways.find((entry) => entry.id === cell.colourwayId)
  const [gtin, setGtin] = useState(cell.sku?.gtin ?? '')
  const gtinHeld = held ?? (!/^(\d{8}|\d{12,14})?$/.test(gtin.trim()) ? t('sku.gtinFormat') : busy ? t('held.busy') : null)
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('sku.title', { colourway: colourway?.code ?? '', size: cell.size })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          {cell.sku && cell.state !== 'closed' && (
            <Button variant={cell.state === 'on' ? 'danger-outline' : 'primary'} heldReason={held ?? (busy ? t('held.busy') : null)} onClick={onToggle}>
              {t(cell.state === 'on' ? 'sku.switchOff' : 'sku.switchOn')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-st-dialog">
        <dl className="fw-st-kv">
          <dt>{t('sku.code')}</dt>
          <dd>{cell.sku?.sku ?? t('sku.noneYet')}</dd>
          <dt>{t('sku.state')}</dt>
          <dd>{t(`sku.stateIs.${cell.state}`)}</dd>
          <dt>{t('sku.coverage')}</dt>
          <dd>
            {cover ? (
              <span className="fw-st-inline">
                <Pill tone={CELL_TONE[cover.status]}>{t(`cellStatus.${cover.status}`)}</Pill>
                {cover.certificate && <span>{t('sku.certificate', { number: cover.certificate.number, until: cover.certificate.validTo })}</span>}
              </span>
            ) : (
              t('sku.coverageUnknown')
            )}
          </dd>
        </dl>
        {cell.state === 'none' && <p className="fw-st-hint">{t('sku.generateFirst')}</p>}
        {cell.sku && (
          <Field label={t('sku.gtin')} hint={t('sku.gtinHint')}>
            <span className="fw-st-inline">
              <Input value={gtin} inputMode="numeric" maxLength={14} onChange={(event) => setGtin(event.target.value.replace(/\D/g, ''))} aria-label={t('sku.gtin')} />
              <Button size="sm" heldReason={gtinHeld ?? ((cell.sku.gtin ?? '') === gtin.trim() ? t('sku.gtinSame') : null)} onClick={() => void onGtin(gtin.trim() === '' ? null : gtin.trim())}>
                {t('sku.saveGtin')}
              </Button>
            </span>
          </Field>
        )}
      </div>
    </Modal>
  )
}
