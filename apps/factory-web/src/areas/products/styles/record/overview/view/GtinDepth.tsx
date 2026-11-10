'use client'

import { Barcode, CircleCheck } from 'lucide-react'
import { Banner, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import type { SkuView } from '@nexus/factory-domain/product/styles/contracts'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import type { AssignView, GtinRange } from '../api'
import { assignHeld, confirmHeld, gtinText, MATRIX_SHOWS, valueOf, waitingForGtin, type MatrixShow, type StyleDepthActions, type StyleDepthModel } from '../model'
import { DepthNotice, DialogProblem, useDepthT } from './parts'

type Sku = Pick<SkuView, 'id' | 'sku' | 'gtin' | 'status' | 'colourwayCode' | 'size'>

/**
 * SCR-342 — GTINs in the colour × size matrix (design products.styles rec:Style style.ov.matrix "Cell: on/off, SKU code,
 * GTIN (W2b)", "Assign GTINs from the GS1 range (W2b): preview then confirm; a GTIN is never reused"; pop:styles.gtin): what
 * a cell says (its state, its SKU code or its GTIN — a SKU switched on without one says so), and Assign GTINs: the company's
 * range, the next free numbers, the preview per SKU, then "Assign N GTINs". Draws one model; fetches nothing.
 */
export function GtinMatrixTools({ model, actions, skus }: { model: StyleDepthModel; actions?: StyleDepthActions; skus: readonly Sku[] }) {
  const t = useDepthT()
  const waiting = waitingForGtin(skus)
  const held = assignHeld(model, waiting)
  return (
    <span className="fw-sdp-tools">
      <SegmentedControl
        ariaLabel={t('cells.show.label')}
        size="sm"
        value={model.matrixShow}
        onChange={(value) => actions?.onMatrixShow?.(value as MatrixShow)}
        options={MATRIX_SHOWS.map((show) => ({ value: show, label: t(`cells.show.${show}`) }))}
      />
      <Button size="sm" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.({ kind: 'assign' })}>
        <Barcode size={13} aria-hidden /> {waiting > 0 ? t('gtin.assignCount', { count: waiting }) : t('gtin.assign')}
      </Button>
      {model.dialog?.kind === 'assign' && <AssignDialog model={model} actions={actions} skus={skus} />}
    </span>
  )
}

/** The depth's banner on Colourways & sizes (a GTIN given, or why it was refused). */
export function GtinNotice({ model, actions }: { model: StyleDepthModel; actions?: StyleDepthActions }) {
  return <DepthNotice model={model} actions={actions} />
}

/** What a cell says beside its state mark: W1's GTIN mark, its SKU code, or its GTIN ("no GTIN" for a SKU switched on without one). */
export function GtinCellWords({ show, sku }: { show: MatrixShow; sku: Pick<Sku, 'sku' | 'gtin' | 'status'> | null }) {
  const t = useDepthT()
  if (!sku) return null
  // The state view keeps W1's mark of a cell that has a GTIN.
  if (show === 'state') return sku.gtin ? <span className="fw-st-matrix-mark">GTIN</span> : null
  if (show === 'sku') return <span className="fw-sdp-cell">{sku.sku}</span>
  if (sku.gtin) return <span className="fw-sdp-cell">{sku.gtin}</span>
  return sku.status === 'ACTIVE' ? <span className="fw-sdp-cell is-missing">{t('cells.noGtin')}</span> : null
}

function AssignDialog({ model, actions, skus }: { model: StyleDepthModel; actions?: StyleDepthActions; skus: readonly Sku[] }) {
  const t = useDepthT()
  const assign = model.assign
  const ranges = valueOf(assign.ranges)?.ranges ?? []
  const range: GtinRange | null = ranges.find((entry) => entry.id === assign.rangeId) ?? null
  const preview = assign.preview && assign.preview.status === 'ready' ? assign.preview.value : null
  const held = confirmHeld(assign, model.busy)
  const done = assign.done
  const skuOf = (id: string) => skus.find((sku) => sku.id === id) ?? null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('gtin.title', { code: model.styleCode })}
      size="lg"
      footer={
        done ? (
          <Button variant="primary" onClick={() => actions?.onDialog?.(null)}>
            {t('base.close')}
          </Button>
        ) : (
          <>
            <Button onClick={() => actions?.onDialog?.(null)}>{t('base.cancel')}</Button>
            {assign.rangeId && (
              <Button variant="quiet" heldReason={model.busy ? t('hold.busy') : null} onClick={() => actions?.onPreview?.()}>
                {t('gtin.previewAgain')}
              </Button>
            )}
            {(!preview || preview.allocation.open) && (
              <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => void actions?.onAssign?.()}>
                {t('gtin.confirm', { count: preview?.count ?? 0 })}
              </Button>
            )}
          </>
        )
      }
    >
      <div className="fw-st-dialog">
        {done ? (
          <Given view={done} skuOf={skuOf} />
        ) : assign.ranges.status === 'loading' || assign.ranges.status === 'idle' ? (
          <Skeleton height={60} />
        ) : assign.ranges.status === 'error' ? (
          <Banner tone="danger" title={t(assign.ranges.problem)} />
        ) : ranges.length === 0 ? (
          <Banner tone="info" title={t('gtin.noRange')}>
            <p className="fw-st-hint">{t('gtin.noRangeHint')}</p>
          </Banner>
        ) : (
          <>
            <p className="fw-st-hint">{t('gtin.intro')}</p>
            <div className="fw-st-stack">
              <Field label={t('gtin.range')}>
                <Select value={assign.rangeId ?? ''} onChange={(event) => actions?.onPickRange?.(event.target.value)}>
                  {ranges.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {t('gtin.rangeOption', { name: entry.name, prefix: entry.gs1Prefix, left: entry.left })}
                    </option>
                  ))}
                </Select>
              </Field>
              {range && (
                <KeyValue
                  dense
                  columns={3}
                  labelCase="sentence"
                  items={[
                    { label: t('gtin.prefix'), value: range.gs1Prefix },
                    { label: t('gtin.next'), value: range.nextGtin ? gtinText(range.nextGtin) : t('gtin.usedUp') },
                    { label: t('gtin.left'), value: String(range.left) },
                  ]}
                />
              )}
            </div>
            <p className="fw-st-inline fw-st-hint">
              <CircleCheck size={13} aria-hidden /> {t('gtin.neverReused')}
            </p>
            {assign.preview?.status === 'loading' && <Skeleton height={80} />}
            {assign.preview?.status === 'error' && <Banner tone="danger" title={t(assign.preview.problem)} />}
            {preview && <Preview view={preview} skuOf={skuOf} />}
          </>
        )}
        <DialogProblem problem={model.problem} />
      </div>
    </Modal>
  )
}

function Preview({ view, skuOf }: { view: AssignView; skuOf: (id: string) => Sku | null }) {
  const t = useDepthT()
  return (
    <div className="fw-st-stack">
      {!view.allocation.open && <Banner tone="warning" title={t('gtin.gate')}>{<p className="fw-st-hint">{t('gtin.gateHint')}</p>}</Banner>}
      {view.count === 0 ? (
        <p className="fw-st-hint">{t('gtin.nothing')}</p>
      ) : (
        <SummaryTable
          label={t('gtin.previewTitle', { count: view.count })}
          stackOnPhone
          columns={[t('gtin.col.sku'), t('gtin.col.cell'), t('gtin.col.gtin')]}
          widths={['36%', '24%', undefined]}
          rows={view.assignments.map((row) => {
            const sku = skuOf(row.skuId)
            return { id: row.skuId, cells: [<b key="s">{row.sku}</b>, sku ? `${sku.colourwayCode} · ${sku.size}` : '—', <span key="g" className="fw-sdp-mono">{gtinText(row.gtin)}</span>] }
          })}
        />
      )}
      {view.skipped.length > 0 && <p className="fw-st-hint">{t('gtin.skipped', { count: view.skipped.length, gtins: view.skipped.map((entry) => entry.gtin).join(', ') })}</p>}
      {view.short > 0 && <Banner tone="warning" title={t('gtin.short', { count: view.short })} />}
      {view.notNumbered.length > 0 && (
        <div className="fw-st-stack">
          <p className="fw-st-hint">{t('gtin.notNumbered', { count: view.notNumbered.length })}</p>
          <ul className="fw-st-list">
            {view.notNumbered.map((row) => {
              const sku = skuOf(row.skuId)
              return <li key={row.skuId}>{t(sku?.gtin ? 'gtin.why.has' : sku && sku.status !== 'ACTIVE' ? 'gtin.why.off' : 'gtin.why.other', { sku: row.sku })}</li>
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

function Given({ view, skuOf }: { view: AssignView; skuOf: (id: string) => Sku | null }) {
  const t = useDepthT()
  return (
    <div className="fw-st-stack">
      <Banner tone="success" title={t('gtin.given', { count: view.count })} />
      <SummaryTable
        label={t('gtin.givenTitle')}
        stackOnPhone
        columns={[t('gtin.col.sku'), t('gtin.col.cell'), t('gtin.col.gtin')]}
        widths={['36%', '24%', undefined]}
        rows={view.assignments.map((row) => {
          const sku = skuOf(row.skuId)
          return { id: row.skuId, cells: [<b key="s">{row.sku}</b>, sku ? `${sku.colourwayCode} · ${sku.size}` : '—', <span key="g" className="fw-sdp-mono">{gtinText(row.gtin)}</span>] }
        })}
      />
      <p className="fw-st-hint">{t('gtin.leftAfter', { left: view.range.left })}</p>
    </div>
  )
}
