'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, CircleX, Download, Plus, Search, Upload } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu } from '@nexus/ui/components'
import { Button, Input, RadioCard, SegmentedControl, Select, Spinner, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { dimensionOf, UOMS } from '@nexus/factory-domain/product/units/units'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { BomLine, BomLineInput, BomView, MaterialView, StyleView } from '../../api'
import { SheetImportDialog } from '../../import/view/SheetImportDialog'
import { decimalInput, decimalText, draftOf, editableRevision, editText, isRoutingIssue, issueWords, nextRevisionNumber, revisionInView, stepLabel } from '../../model'
import type { BomViewMode, StyleRecordActions, StyleRecordViewModel } from '../../record/record-model'
// B-W2b-241: the BOM in depth (sections and group rows, the sub-assembly tree, alternates, customer-supplied and option
// lines, THE check, leather grades, fill by size).
import { NO_BOM_DEPTH, ready, type ShowMe } from '../depth/model'
import { CheckCard } from '../depth/view/CheckCard'
import { DepthDialogs } from '../depth/view/DepthDialogs'
import { LeatherGrades } from '../depth/view/LeatherGrades'
import { LinesGrid } from '../depth/view/LinesGrid'
import { SizesGrid } from '../depth/view/SizesGrid'
import { TreeSection } from '../depth/view/TreeSection'
import '../depth/bom-depth.css'

const VIEWS: BomViewMode[] = ['lines', 'sizes', 'colours', 'tree']

/**
 * SCR-042 Materials (BOM) of the revision in view: the release check of the BOM (each finding with Show me), four views
 * of the same lines — Lines (add with `n`, edit, move with Alt+↑ / Alt+↓, remove), By size (size-dependent lines × the
 * range, decimals typed either way, a missing size said in words, never 0), By colourway (colour-dependent lines × the
 * active colourways, the material's own colours only), Tree (the sub-assemblies) — `v` cycles them; and leather: what
 * each size cuts and needs in hide, with the planned hide yield of the revision. A released revision is frozen: everything
 * is drawn as text.
 * B-W2b-88: each line may name the operation of the routing that uses it (column "Operation", a field of the line): the
 * floor then asks its components at that operation only, and dispatch flags its material per operation.
 * B-W2b-241: THE check (W1's and the structure's findings, B-W2b-223), the Lines view on the shared list frame with the
 * Section column and group rows, Alternates, Customer-supplied and Option (bulk Section… / Group… / Supply…), the line in
 * depth (Enter), By size on the DS SizeColumns with Fill from base by increment, the Tree view (Sub-assemblies, used in),
 * and the leather lines' grade mix and minimum grade per pattern piece.
 */
export function BomTab(props: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  return (
    <WithMessages namespaces={['products-bom-depth']}>
      <BomTabBody {...props} />
    </WithMessages>
  )
}

function BomTabBody({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const td = useT('products-bom-depth')
  const revision = revisionInView(style.revisions, model.revisionId)
  const editable = editableRevision(style, revision) && model.can.bomManage
  const heldWhy = !model.can.bomManage ? t('held.noManage') : !editableRevision(style, revision) ? t('bom.held.frozen') : model.busy ? t('held.busy') : null
  // B-W2b-241: the BOM in depth (its own read; design cases without one draw W1's data with "—" in the W2b columns).
  const depth = model.bomDepth ?? { ...NO_BOM_DEPTH, canManage: model.can.bomManage }
  const depthActions = actions?.bomDepth
  // W2a Import BOM (importer product.bom): rows go into a style's DRAFT revision, so a frozen one says where to go first.
  const draft = draftOf(style.revisions)
  const importHeld = !model.can.bomManage
    ? t('held.noManage')
    : !model.can.imports
      ? t('bom.import.held.noImports')
      : style.status === 'ARCHIVED'
        ? t('held.archived')
        : !editableRevision(style, revision)
          ? draft
            ? t('bom.import.held.goToDraft', { revision: draft.revision })
            : t('bom.import.held.startFirst', { revision: nextRevisionNumber(style.revisions) })
          : model.busy
            ? t('held.busy')
            : null

  // n adds a line, v cycles the views (00 §3.17) — never while typing or in a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.dialog || depth.dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'n' && editable) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'bomLine', lineId: null })
      } else if (event.key === 'v') {
        event.preventDefault()
        actions?.onBomView?.(VIEWS[(VIEWS.indexOf(model.bomView) + 1) % VIEWS.length]!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!revision) return <EmptyState title={t('bom.noRevision.title')} description={t('bom.noRevision.body')} />
  if (model.bom.status === 'loading' || model.bom.status === 'idle')
    return (
      <Card padded aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('bom.loading')}
        </p>
      </Card>
    )
  if (model.bom.status === 'error')
    return <Banner tone="danger" title={t('bom.failed')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('common.retry')}</Button>}>{t(model.bom.problem)}</Banner>
  const bom = model.bom.value
  const routing = model.routing.status === 'ready' ? model.routing.value : null
  const bomIssues = bom.issues.filter((issue) => !isRoutingIssue(issue.code))
  const bomWarnings = bom.warnings.filter((issue) => !isRoutingIssue(issue.code))
  const structure = ready(depth.structure)

  const showMe = (issue: BomView['issues'][number]) => {
    const view: BomViewMode = issue.size ? 'sizes' : issue.colourwayId ? 'colours' : 'lines'
    actions?.onBomView?.(view)
    requestAnimationFrame(() => {
      const selector = issue.size ? `[data-cell="${issue.lineId}:${issue.size}"]` : issue.colourwayId ? `[data-cell="${issue.lineId}:${issue.colourwayId}"]` : `[row-id="${issue.lineId}"]`
      document.querySelector<HTMLElement>(selector)?.focus()
    })
    if (issue.size && issue.lineId) depthActions?.onShowSize?.(issue.lineId, issue.size)
  }
  // B-W2b-241: "Show me" of THE check lands on the cell to fix.
  const showTarget = (target: ShowMe) => {
    switch (target.to) {
      case 'add':
        actions?.onDialog?.({ kind: 'bomLine', lineId: null })
        return
      case 'sizes':
        actions?.onBomView?.('sizes')
        depthActions?.onShowSize?.(target.lineId, target.size)
        return
      case 'colours':
        actions?.onBomView?.('colours')
        requestAnimationFrame(() => document.querySelector<HTMLElement>(target.colourwayId ? `[data-cell="${target.lineId}:${target.colourwayId}"]` : `[row-id="${target.lineId}"]`)?.focus())
        return
      case 'line':
        depthActions?.onDialog?.({ kind: 'line', lineId: target.lineId, part: target.part })
        return
      case 'edit':
        actions?.onDialog?.({ kind: 'bomLine', lineId: target.lineId })
        return
      case 'yield':
        requestAnimationFrame(() => document.getElementById('fw-bmd-yield')?.focus())
        return
      case 'row':
        actions?.onBomView?.('lines')
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[row-id="${target.lineId}"] [col-id="material"]`)?.focus())
        return
    }
  }

  return (
    <div className="fw-st-stack-lg">
      {revision.status === 'DRAFT' && structure ? (
        <CheckCard structure={structure} depth={ready(depth.depth)} bom={bom} routing={routing} onShowMe={showTarget} />
      ) : (
        revision.status === 'DRAFT' &&
        bomIssues.length > 0 && (
          <Card header={t('bom.check.title', { count: bomIssues.length })} description={t('bom.check.intro')}>
            <ul className="fw-st-checklist">
              {bomIssues.map((issue, index) => {
                const words = issueWords(issue, bom, routing)
                return (
                  <li key={`${issue.code}-${index}`} className="fw-st-check is-blocked">
                    <CircleX size={14} aria-hidden />
                    <span>{t(words.key, words.params)}</span>
                    {(issue.lineId || issue.code === 'NO_LINES') && (
                      <Button size="sm" variant="link" onClick={() => (issue.code === 'NO_LINES' ? actions?.onDialog?.({ kind: 'bomLine', lineId: null }) : showMe(issue))}>
                        {t('check.showMe')}
                      </Button>
                    )}
                  </li>
                )
              })}
              {bomWarnings.map((issue, index) => {
                const words = issueWords(issue, bom, routing)
                return (
                  <li key={`w${index}`} className="fw-st-check is-warning">
                    <CircleAlert size={14} aria-hidden />
                    <span>
                      {t(words.key, words.params)} <span className="fw-st-hint">· {t('release.warningPasses')}</span>
                    </span>
                    <span />
                  </li>
                )
              })}
            </ul>
          </Card>
        )
      )}
      {depth.notice && (
        <Banner
          tone={depth.notice.tone}
          title={td(depth.notice.key, depth.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => depthActions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {(depth.structure.status === 'error' || depth.depth.status === 'error') && model.bomView !== 'tree' && (
        <Banner tone="warning" title={td('depth.failed')} action={<Button size="sm" onClick={() => depthActions?.onRetry?.()}>{t('common.retry')}</Button>} />
      )}

      <Card
        header={t('bom.title', { count: bom.lines.length })}
        description={t('bom.intro', { revision: bom.revision.revision })}
        headerAction={
          <span className="fw-st-inline">
            <SegmentedControl
              size="sm"
              ariaLabel={t('bom.viewLabel')}
              value={model.bomView}
              onChange={(value) => actions?.onBomView?.(value as BomViewMode)}
              options={VIEWS.map((view) => ({ value: view, label: view === 'tree' ? td('view.tree') : t(`bom.view.${view}`) }))}
            />
            <Menu
              label={
                <span className="fw-st-inline">
                  <Download size={13} aria-hidden /> {model.exporting ? t('bom.export.making') : t('bom.export.title')}
                </span>
              }
              align="right"
              triggerProps={{ 'aria-label': t('bom.export.label', { revision: bom.revision.revision }) }}
              items={(['xlsx', 'csv', 'pdf'] as const).map((format) => ({
                id: format,
                label: t(`bom.export.${format}`),
                description: t(`bom.export.${format}Hint`),
                disabled: !!model.exporting,
                onSelect: () => actions?.onExportBom?.(format),
              }))}
            />
            <Button size="sm" heldReason={importHeld} onClick={() => actions?.onImportBom?.()}>
              <Upload size={13} aria-hidden /> {t('bom.import.open')}
            </Button>
            <Button size="sm" variant="primary" heldReason={heldWhy} onClick={() => actions?.onDialog?.({ kind: 'bomLine', lineId: null })} aria-keyshortcuts="n">
              <Plus size={13} aria-hidden /> {t('bom.add')}
            </Button>
          </span>
        }
      >
        {model.bomView === 'tree' ? (
          <TreeSection model={depth} actions={depthActions} prefix={model.prefix} />
        ) : bom.lines.length === 0 ? (
          <EmptyState
            title={t('bom.empty.title')}
            description={t('bom.empty.body')}
            action={
              <Button size="sm" variant="primary" heldReason={heldWhy} onClick={() => actions?.onDialog?.({ kind: 'bomLine', lineId: null })}>
                {t('bom.addFirst')}
              </Button>
            }
          />
        ) : model.bomView === 'sizes' ? (
          <SizesGrid
            bom={bom}
            editable={editable}
            heldWhy={editable ? null : heldWhy}
            marks={depth.marks}
            offline={depth.offline}
            focus={depth.focus}
            onCell={(lineId, size, value) => (depthActions?.onSizeCell ? depthActions.onSizeCell(lineId, size, value) : actions?.onLineSizes?.(lineId, [{ size, qty: value }]))}
            onFill={(lineId) => depthActions?.onDialog?.({ kind: 'fill', lineId })}
            onFocused={() => depthActions?.onFocused?.()}
          />
        ) : model.bomView === 'colours' ? (
          <ColoursView bom={bom} model={model} editable={editable} actions={actions} />
        ) : (
          <LinesGrid bom={bom} model={depth} actions={depthActions} recordActions={actions} prefix={model.prefix} />
        )}
      </Card>

      <LeatherCard bom={bom} model={model} editable={editable} actions={actions} />

      {model.bomImport && <SheetImportDialog model={model.bomImport} actions={actions?.bomImport} />}
      {model.dialog?.kind === 'bomLine' && <LineDialog bom={bom} model={model} actions={actions} lineId={model.dialog.lineId} />}
      {model.dialog?.kind === 'removeLine' && <RemoveLineDialog bom={bom} model={model} actions={actions} lineId={model.dialog.lineId} />}
      <DepthDialogs bom={bom} model={depth} actions={depthActions} recordActions={actions} materials={model.materials} prefix={model.prefix} styleId={style.id} />
    </div>
  )
}

function ColoursView({ bom, model, editable, actions }: { bom: BomView; model: StyleRecordViewModel; editable: boolean; actions?: StyleRecordActions }) {
  const t = useT('products')
  const lines = bom.lines.filter((line) => line.colourDependent)
  const colourways = bom.colourways.filter((colourway) => colourway.status === 'ACTIVE')
  const needed = useMemo(() => [...new Set(lines.map((line) => line.item.id))].join(','), [lines])
  const load = useRef(actions?.onLoadMaterial)
  load.current = actions?.onLoadMaterial
  useEffect(() => {
    for (const id of needed.split(',')) if (id && !(id in model.materials)) load.current?.(id)
    // The materials of the colour-dependent lines, once each.
  }, [needed])
  if (lines.length === 0) return <EmptyState title={t('bom.colours.empty.title')} description={t('bom.colours.empty.body')} />
  return (
    <div className="fw-st-stack">
      <div className="fw-st-scroll">
        <table className="fw-st-grid" aria-label={t('bom.view.colours')}>
          <thead>
            <tr>
              <th scope="col" className="fw-st-grid-first">
                {t('bom.col.material')}
              </th>
              {colourways.map((colourway) => (
                <th key={colourway.id} scope="col">
                  {colourway.code}
                  <span className="fw-st-hint"> · {colourway.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const material = model.materials[line.item.id] ?? null
              const choices = material?.colours.filter((colour) => colour.status === 'ACTIVE') ?? []
              return (
                <tr key={line.id}>
                  <th scope="row" className="fw-st-grid-first">
                    <span className="fw-st-cellstack">
                      <b>
                        {line.seq} · {line.item.code}
                      </b>
                      <span className="fw-st-hint">{line.placement ?? line.item.name}</span>
                    </span>
                  </th>
                  {colourways.map((colourway) => {
                    const cell = line.colours.find((entry) => entry.colourwayId === colourway.id)?.itemColour ?? null
                    const key = `${line.id}:${colourway.id}`
                    return (
                      <td key={colourway.id} className={cell ? undefined : 'is-missing'}>
                        {editable && material ? (
                          <Select
                            size="sm"
                            data-cell={key}
                            value={cell?.id ?? ''}
                            aria-label={t('bom.colourCell', { line: `${line.seq} · ${line.item.code}`, colourway: colourway.code })}
                            aria-invalid={!cell || undefined}
                            onChange={(event) => actions?.onLineColours?.(line.id, [{ colourwayId: colourway.id, itemColourId: event.target.value || null }])}
                          >
                            <option value="">{t('bom.colours.choose')}</option>
                            {choices.map((colour) => (
                              <option key={colour.id} value={colour.id}>
                                {colour.code} · {colour.name}
                                {colour.supplierColourCode ? ` (${colour.supplierColourCode})` : ''}
                              </option>
                            ))}
                            {cell && !choices.some((colour) => colour.id === cell.id) && <option value={cell.id}>{cell.code}</option>}
                          </Select>
                        ) : cell ? (
                          <span>
                            {cell.code} · {cell.name}
                          </span>
                        ) : (
                          <span className="fw-st-danger">{editable ? t('bom.colours.loading') : t('bom.colours.none')}</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="fw-st-hint">{t('bom.colours.hint')}</p>
    </div>
  )
}

function LeatherCard({ bom, model, editable, actions }: { bom: BomView; model: StyleRecordViewModel; editable: boolean; actions?: StyleRecordActions }) {
  const t = useT('products')
  const locale = useLocale()
  const leather = bom.lines.filter((line) => line.item.kind === 'LEATHER')
  const [yieldText, setYieldText] = useState(editText(bom.revision.plannedHideYieldPct, locale))
  useEffect(() => setYieldText(editText(bom.revision.plannedHideYieldPct, locale)), [bom.revision.plannedHideYieldPct, locale])
  const needed = leather.map((line) => line.item.id).join(',')
  const load = useRef(actions?.onLoadMaterial)
  load.current = actions?.onLoadMaterial
  useEffect(() => {
    for (const id of needed.split(',')) if (id && !(id in model.materials)) load.current?.(id)
  }, [needed])
  if (leather.length === 0) return null
  const base = bom.style.baseSize
  const typed = decimalInput(yieldText, 4)
  const yieldHeld = typed === undefined || (typed !== null && (Number(typed) <= 0 || Number(typed) > 100)) ? t('bom.leather.yieldRange') : model.busy ? t('held.busy') : typed === (bom.revision.plannedHideYieldPct === null ? null : decimalInput(bom.revision.plannedHideYieldPct, 4)) ? t('sku.gtinSame') : null
  return (
    <Card header={t('bom.leather.title')} description={t('bom.leather.intro')}>
      <div className="fw-st-stack">
        {leather.map((line) => {
          const material: MaterialView | null = model.materials[line.item.id] ?? null
          const atBase = line.bySize.find((entry) => entry.size === base)
          const perHide = material?.purchaseUom === 'HIDE' ? Number(material.units.purchase.factor) : null
          const gross = atBase?.base ? Number(atBase.base) : null
          return (
            <div key={line.id} className="fw-st-stack">
              <p className="fw-st-h3">
                {line.seq} · {line.item.code} — {line.item.name}
              </p>
              {atBase?.qty && atBase.gross ? (
                <p>{t('bom.leather.sentence', { size: base ?? '—', net: decimalText(atBase.qty, locale, 2), gross: decimalText(atBase.gross, locale, 2), unit: t(`uom.${line.uom}`), pct: decimalText(line.wastagePct, locale) })}</p>
              ) : (
                <p className="fw-st-hint">{t('bom.leather.noBase')}</p>
              )}
              <KeyValue
                columns={3}
                labelCase="sentence"
                dense
                items={[
                  { label: t('bom.leather.hideArea'), value: perHide ? `${decimalText(String(perHide), locale, 2)} ${t(`uom.${line.item.baseUom}`)}` : t('bom.leather.hideUnknown') },
                  { label: t('bom.leather.perGarment'), value: perHide && gross ? decimalText((gross / perHide).toFixed(3), locale, 3) : '—' },
                  { label: t('bom.leather.per100'), value: perHide && gross ? decimalText(((gross / perHide) * 100).toFixed(1), locale, 1) : '—' },
                ]}
              />
              {/* B-W2b-241: the grade mix and minimum grade per pattern piece cut from this line (B-W2b-95's pieces). */}
              <LeatherGrades pieces={model.pieces} lineId={line.id} filesHref={`${model.prefix}/products/styles/${bom.style.id}?tab=files&rev=${bom.revision.id}`} locale={locale} />
            </div>
          )
        })}
        <Field label={t('bom.leather.yield')} hint={t('bom.leather.yieldHint')}>
          {editable ? (
            <span className="fw-st-inline">
              <Input id="fw-bmd-yield" inputMode="decimal" value={yieldText} onChange={(event) => setYieldText(event.target.value)} aria-label={t('bom.leather.yield')} suffix="%" />
              <Button size="sm" heldReason={yieldHeld} onClick={() => void actions?.onHideYield?.(typed ?? null)}>
                {t('bom.leather.saveYield')}
              </Button>
            </span>
          ) : (
            <p className="fw-st-static">{bom.revision.plannedHideYieldPct ? `${decimalText(bom.revision.plannedHideYieldPct, locale)} %` : '—'}</p>
          )}
        </Field>
      </div>
    </Card>
  )
}

/** The units a line may be typed in: the material's consumption, base and purchase units and those of the base's kind. */
function unitsFor(material: MaterialView): BomLine['uom'][] {
  const dimension = dimensionOf(material.baseUom)
  return [...new Set([material.consumptionUom, material.baseUom, material.purchaseUom, ...UOMS.filter((uom) => dimensionOf(uom) === dimension)])]
}

function LineDialog({ bom, model, actions, lineId }: { bom: BomView; model: StyleRecordViewModel; actions?: StyleRecordActions; lineId: string | null }) {
  const t = useT('products')
  const locale = useLocale()
  const current = lineId ? bom.lines.find((line) => line.id === lineId) ?? null : null
  const [itemId, setItemId] = useState<string | null>(current?.item.id ?? model.lineDraft?.material.id ?? null)
  const material: MaterialView | null = (itemId ? model.materials[itemId] : null) ?? (model.lineDraft && model.lineDraft.material.id === itemId ? model.lineDraft.material : null)
  // An existing line's material is read when the dialog opens (only leather and colour-dependent lines are read beforehand).
  const loadMaterial = useRef(actions?.onLoadMaterial)
  loadMaterial.current = actions?.onLoadMaterial
  useEffect(() => {
    if (itemId && !(itemId in model.materials) && model.lineDraft?.material.id !== itemId) loadMaterial.current?.(itemId)
  }, [itemId, model.materials, model.lineDraft])
  const [query, setQuery] = useState('')
  const typedQuery = useRef(false)
  const search = useRef(actions?.onMaterialQuery)
  search.current = actions?.onMaterialQuery
  useEffect(() => {
    if (!typedQuery.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const [placement, setPlacement] = useState(current?.placement ?? '')
  const [uom, setUom] = useState<BomLine['uom'] | ''>(current?.uom ?? '')
  const [qty, setQty] = useState(current ? editText(current.qty, locale) : '')
  const [wastage, setWastage] = useState(current ? editText(current.wastagePct, locale) : '0')
  const [sizeDependent, setSizeDependent] = useState(current?.sizeDependent ?? false)
  const [colourDependent, setColourDependent] = useState(current?.colourDependent ?? false)
  const [itemColourId, setItemColourId] = useState<string | null>(current?.itemColour?.id ?? null)
  const [colourwayId, setColourwayId] = useState<string | null>(current?.colourway?.id ?? null)
  const [routingSeq, setRoutingSeq] = useState<number | null>(current?.routingStep?.seq ?? null)
  const steps = model.routing.status === 'ready' ? model.routing.value.steps : null
  const [note, setNote] = useState(current?.note ?? '')
  useEffect(() => {
    if (material && !uom) setUom(material.consumptionUom)
  }, [material, uom])

  const qtyValue = decimalInput(qty, 4)
  const wastageValue = decimalInput(wastage, 4)
  const held = !material
    ? t('bom.line.held.material')
    : !sizeDependent && (qtyValue === undefined || qtyValue === null || Number(qtyValue) <= 0)
      ? t('bom.line.held.qty')
      : wastageValue === undefined || wastageValue === null || Number(wastageValue) > 60
        ? t('bom.line.held.wastage')
        : model.busy
          ? t('held.busy')
          : null
  const run = () => {
    if (held || !material) return
    const input: BomLineInput = {
      placement: placement.trim() || null,
      uom: uom || material.consumptionUom,
      ...(sizeDependent ? {} : { qty: qtyValue ?? undefined }),
      wastagePct: wastageValue ?? '0',
      sizeDependent,
      colourDependent,
      itemColourId: colourDependent ? null : itemColourId,
      colourwayId,
      note: note.trim() || null,
      routingSeq,
    }
    const done = current ? actions?.onEditLine?.(current.id, input) : actions?.onAddLine?.({ ...input, itemId: material.id })
    void done?.then((ok) => ok && actions?.onDialog?.(null))
  }
  const results = model.materialSearch.results
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="lg"
      title={current ? t('bom.line.editTitle', { line: current.seq, code: current.item.code }) : t('bom.line.addTitle')}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={run} aria-keyshortcuts="Meta+Enter Control+Enter">
            {current ? t('bom.line.save') : t('bom.line.add')}
          </Button>
        </>
      }
    >
      <div
        className="fw-st-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            run()
          }
        }}
      >
        {!material ? (
          itemId ? (
            <p className="fw-st-hint" role="status">
              <Spinner size={14} /> {t('bom.line.loadingMaterial')}
            </p>
          ) : (
            <>
              <Field label={t('bom.line.material')} hint={t('bom.line.materialHint')}>
                <Input
                  type="search"
                  autoFocus
                  leadingIcon={<Search size={13} aria-hidden />}
                  value={query}
                  placeholder={t('bom.line.materialPlaceholder')}
                  onChange={(event) => {
                    typedQuery.current = true
                    setQuery(event.target.value)
                  }}
                />
              </Field>
              {model.materialSearch.problem ? (
                <Banner tone="danger" title={t(model.materialSearch.problem)} />
              ) : (
                <fieldset className="fw-st-choices">
                  <legend className="fw-st-legend" aria-live="polite">
                    {results === null ? (typedQuery.current ? t('bom.line.searching') : t('bom.line.typeToSearch')) : results.length === 0 ? t('bom.line.noneFound') : t('bom.line.found', { count: results.length })}
                  </legend>
                  {(results ?? []).map((row) => (
                    <RadioCard
                      key={row.id}
                      variant="row"
                      name="fw-st-material"
                      value={row.id}
                      checked={false}
                      onChange={() => {
                        setItemId(row.id)
                        actions?.onLoadMaterial?.(row.id)
                      }}
                      title={`${row.code} · ${row.name}`}
                      description={[t(`kind.${row.kind}`), t(`uom.${row.consumptionUom}`), row.defaultSupplier?.name, row.colourCount > 0 ? t('bom.line.colours', { count: row.colourCount }) : null].filter(Boolean).join(' · ')}
                    />
                  ))}
                </fieldset>
              )}
            </>
          )
        ) : (
          <>
            <div className="fw-st-chosen">
              <span className="fw-st-cellstack">
                <b>
                  {material.code} · {material.name}
                </b>
                <span className="fw-st-hint">
                  {t(`kind.${material.kind}`)} · {t('bom.line.baseUnit', { unit: t(`uom.${material.baseUom}`) })}
                  {material.requiresCrViTest ? ` · ${t('bom.line.crVi')}` : ''}
                  {material.isPpeComponent ? ` · ${t('bom.line.ppeComponent')}` : ''}
                </span>
              </span>
              {!current && (
                <Button size="sm" variant="quiet" onClick={() => setItemId(null)}>
                  {t('bom.line.change')}
                </Button>
              )}
            </div>
            <div className="fw-st-form-grid">
              <Field label={t('bom.col.placement')} hint={t('bom.line.placementHint')}>
                <Input value={placement} maxLength={120} onChange={(event) => setPlacement(event.target.value)} />
              </Field>
              <Field label={t('bom.line.unit')}>
                <Select value={uom || material.consumptionUom} onChange={(event) => setUom(event.target.value as BomLine['uom'])}>
                  {unitsFor(material).map((unit) => (
                    <option key={unit} value={unit}>
                      {t(`uom.${unit}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('bom.line.sizeDependent')} hint={t('bom.line.sizeDependentHint')}>
                <span className="fw-st-inline">
                  <Toggle checked={sizeDependent} onChange={setSizeDependent} aria-label={t('bom.line.sizeDependent')} />
                  {t(sizeDependent ? 'common.yes' : 'common.no')}
                </span>
              </Field>
              {!sizeDependent && (
                <Field label={t('bom.line.qty')} required hint={t('bom.line.qtyHint')}>
                  <Input inputMode="decimal" value={qty} onChange={(event) => setQty(event.target.value)} />
                </Field>
              )}
              <Field label={t('bom.col.wastage')} hint={t(material.kind === 'LEATHER' ? 'bom.line.wastageLeather' : 'bom.line.wastageHint')}>
                <Input inputMode="decimal" value={wastage} onChange={(event) => setWastage(event.target.value)} suffix="%" />
              </Field>
              <Field label={t('bom.line.colourDependent')} hint={t('bom.line.colourDependentHint')}>
                <span className="fw-st-inline">
                  <Toggle checked={colourDependent} onChange={setColourDependent} aria-label={t('bom.line.colourDependent')} />
                  {t(colourDependent ? 'common.yes' : 'common.no')}
                </span>
              </Field>
              {!colourDependent && (
                <Field label={t('bom.line.oneColour')} hint={t('bom.line.oneColourHint')}>
                  <Select value={itemColourId ?? ''} onChange={(event) => setItemColourId(event.target.value || null)}>
                    <option value="">{t('bom.line.noColour')}</option>
                    {material.colours
                      .filter((colour) => colour.status === 'ACTIVE')
                      .map((colour) => (
                        <option key={colour.id} value={colour.id}>
                          {colour.code} · {colour.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              )}
              <Field label={t('bom.line.onlyIn')} hint={t('bom.line.onlyInHint')}>
                <Select value={colourwayId ?? ''} onChange={(event) => setColourwayId(event.target.value || null)}>
                  <option value="">{t('bom.line.everyColourway')}</option>
                  {bom.colourways
                    .filter((colourway) => colourway.status === 'ACTIVE')
                    .map((colourway) => (
                      <option key={colourway.id} value={colourway.id}>
                        {colourway.code} · {colourway.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Field label={t('bom.line.operation')} hint={steps === null ? t('bom.line.operationLoading') : steps.length === 0 ? t('bom.line.operationNoRouting') : t('bom.line.operationHint')}>
              <Select value={routingSeq === null ? '' : String(routingSeq)} onChange={(event) => setRoutingSeq(event.target.value === '' ? null : Number(event.target.value))}>
                <option value="">{t('bom.line.noOperation')}</option>
                {(steps ?? []).map((step) => (
                  <option key={step.id} value={String(step.seq)}>
                    {stepLabel(step)} {step.name}
                  </option>
                ))}
                {current?.routingStep && !(steps ?? []).some((step) => step.seq === current.routingStep!.seq) && <option value={String(current.routingStep.seq)}>{stepLabel(current.routingStep)}</option>}
              </Select>
            </Field>
            <Field label={t('bom.line.note')}>
              <Textarea value={note} rows={2} maxLength={1000} onChange={(event) => setNote(event.target.value)} />
            </Field>
            {sizeDependent && <p className="fw-st-hint">{t('bom.line.sizesAfter')}</p>}
            {colourDependent && <p className="fw-st-hint">{t('bom.line.coloursAfter')}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}

function RemoveLineDialog({ bom, model, actions, lineId }: { bom: BomView; model: StyleRecordViewModel; actions?: StyleRecordActions; lineId: string }) {
  const t = useT('products')
  const line = bom.lines.find((entry) => entry.id === lineId)
  const run = () => void actions?.onRemoveLine?.(lineId).then((ok) => ok && actions?.onDialog?.(null))
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="sm"
      title={t('bom.removeTitle', { line: line?.seq ?? '', code: line?.item.code ?? '' })}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('held.busy') : null} onClick={run}>
            {t('bom.remove')}
          </Button>
        </>
      }
    >
      <p>{t('bom.removeBody', { revision: bom.revision.revision })}</p>
    </Modal>
  )
}
