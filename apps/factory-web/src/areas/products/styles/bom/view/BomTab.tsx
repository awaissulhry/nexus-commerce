'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, CircleX, Download, Layers3, Plus, Search, ShieldAlert, Upload } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu } from '@nexus/ui/components'
import { Button, Input, RadioCard, SegmentedControl, Select, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { dimensionOf, UOMS } from '@nexus/factory-domain/product/units/units'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { BomLine, BomLineInput, BomView, MaterialView, StyleView } from '../../api'
import { SheetImportDialog } from '../../import/view/SheetImportDialog'
import { decimalInput, decimalText, draftOf, editableRevision, editText, isRoutingIssue, issueWords, mayEditDraftParts, moneyText, nextRevisionNumber, revisionInView, stepLabel } from '../../model'
// ---- owb-pd5 (steps 5.1, 5.2): the Materials tab in the section kit ----
import { PartFailed, PartReading, Quiet, Section } from '../../../../../lib/record-sections/Kit'
import { bomRefusalOf, ceRecheckOf, costsOf, customerSent, isMainLine, lineFactsOf, longestWaits, mainOf, openOrdersNeedOf, orderNeedOf, piecesOf, stepOf, topLineOf, type CeRecheck, type LineFacts, type MaterialsTop, type NeedRow } from '../materials-model'
// ---- end owb-pd5
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
    <WithMessages namespaces={['products-bom-depth', /* owb-pd5: the section kit's words */ 'orders']}>
      <BomTabBody {...props} />
    </WithMessages>
  )
}

function BomTabBody({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const td = useT('products-bom-depth')
  const revision = revisionInView(style.revisions, model.revisionId)
  // owb-pd5 (step 5.1; S4 settle 6): the BOM's right, or the designer's on a DRAFT.
  const mayEdit = mayEditDraftParts(model.can)
  const editable = editableRevision(style, revision) && mayEdit
  const heldWhy = !mayEdit ? t('held.noManage') : !editableRevision(style, revision) ? t('bom.held.frozen') : model.busy ? t('held.busy') : null
  // B-W2b-241: the BOM in depth (its own read; design cases without one draw W1's data with "—" in the W2b columns).
  const depth = model.bomDepth ?? { ...NO_BOM_DEPTH, canManage: mayEdit }
  const bomRefused = bomRefusalOf(model.refused)
  const depthActions = actions?.bomDepth
  // W2a Import BOM (importer product.bom): rows go into a style's DRAFT revision, so a frozen one says where to go first.
  const draft = draftOf(style.revisions)
  const importHeld = !mayEdit
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
  // owb-pd5 (steps 5.1, 5.2): the facts of each line (section, who brings it, wait, main), one piece's cost (cost grain only), the CE re-check.
  const facts = lineFactsOf(bom, structure, ready(depth.depth))
  const costs = costsOf(model.cost.status === 'ready' ? model.cost.value : null, model.grains)
  const top = topLineOf(facts, costs?.piece ?? null)
  const ce = revision.status === 'DRAFT' ? ceRecheckOf(bom, facts, model.releasedBom?.status === 'ready' ? model.releasedBom.value : null) : null
  const sizeCodes = bom.sizes.map((size) => size.code)
  const extras = {
    facts,
    costs,
    steps: Object.fromEntries(bom.lines.map((line) => [line.id, stepOf(line, sizeCodes, bom.style.baseSize)])),
    editable,
  }

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
    <div className="fw-pt fw-pd-mat">
      {/* owb-pd5 (step 5.1): the top line — lines, the leather, what the customer sends, the longest wait, one piece's cost (cost grain). */}
      <MaterialsAnswer top={top} currency={costs?.currency ?? null} />
      {/* owb-pd5 (step 5.2): "CE: check the certificate again" with today's Tell Compliance (on the Compliance tab). */}
      {ce ? <CeSection ce={ce} model={model} styleId={style.id} /> : null}
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
      {/* owb-pd8b (pd3): the BOM's own refusal the last write met, in the tab's words (the studio's notice points here). */}
      {bomRefused && <Banner tone="danger" title={td(`mat.refusal.${bomRefused}`)} />}
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

      <div className="fw-pt-pairs">
        <MainSection facts={facts} editable={editable} />
        <BeforeSection facts={facts} />
      </div>

      <Section
        id="pd-mat-list"
        title={td('mat.list.title', { count: bom.lines.length })}
        answer={t('bom.intro', { revision: bom.revision.revision })}
        info={<p>{td('mat.list.info')}</p>}
        buttons={[
            <Menu
              key="export"
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
            />,
            <Button key="import" size="sm" heldReason={importHeld} onClick={() => actions?.onImportBom?.()}>
              <Upload size={13} aria-hidden /> {t('bom.import.open')}
            </Button>,
            <Button key="add" size="sm" variant="primary" heldReason={heldWhy} onClick={() => actions?.onDialog?.({ kind: 'bomLine', lineId: null })} aria-keyshortcuts="n">
              <Plus size={13} aria-hidden /> {t('bom.add')}
            </Button>,
        ]}
      >
        {/* owb-pd5 (step 5.1): the material list first; By size, By colourway and Tree stay as more views of the same lines. */}
        <span className="fw-pd-mat-views">
          <Layers3 size={13} aria-hidden />
          <SegmentedControl
            size="sm"
            ariaLabel={t('bom.viewLabel')}
            value={model.bomView}
            onChange={(value) => actions?.onBomView?.(value as BomViewMode)}
            options={VIEWS.map((view) => ({ value: view, label: view === 'tree' ? td('view.tree') : view === 'lines' ? td('mat.list.view') : t(`bom.view.${view}`) }))}
          />
        </span>
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
          <LinesGrid bom={bom} model={depth} actions={depthActions} recordActions={actions} prefix={model.prefix} extras={extras /* owb-pd5 */} />
        )}
      </Section>

      {/* owb-pd5 (step 5.1): what an order needs (browser arithmetic, nothing saved) beside what the open orders need. */}
      {model.orders ? (
        <div className="fw-pt-pairs">
          <OrderNeedSection bom={bom} facts={facts} />
          <OpenNeedSection bom={bom} facts={facts} model={model} actions={actions} />
        </div>
      ) : (
        <OrderNeedSection bom={bom} facts={facts} />
      )}

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
              <LeatherGrades pieces={model.pieces} lineId={line.id} filesHref={`${model.prefix}/products/styles/${bom.style.id}?tab=patterns&rev=${bom.revision.id}` /* B-TH-261: Files & patterns is Patterns */} locale={locale} />
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
  const td = useT('products-bom-depth')
  const line = bom.lines.find((entry) => entry.id === lineId)
  // owb-pd5 (step 5.1): the main material cannot be taken out (pd3 MAIN_REQUIRED says the same).
  const mainHeld = line && isMainLine(line) ? td('mat.main.held') : null
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
          <Button variant="danger" heldReason={mainHeld ?? (model.busy ? t('held.busy') : null)} onClick={run}>
            {t('bom.remove')}
          </Button>
        </>
      }
    >
      <p>{t('bom.removeBody', { revision: bom.revision.revision })}</p>
    </Modal>
  )
}

// ---- owb-pd5 (steps 5.1, 5.2; design § 5zc, prototype mat.js prodMaterialsTab) — the Materials tab's sections ---------------------

/** The top line: how many lines, the leather, what the customer sends, the longest wait and (cost grain) one piece's material cost. */
function MaterialsAnswer({ top, currency }: { top: MaterialsTop; currency: string | null }) {
  const td = useT('products-bom-depth')
  const locale = useLocale()
  const parts = [
    td('mat.top.lines', { count: top.lines }),
    top.leather ? td('mat.top.leather', { code: top.leather.code, name: top.leather.name }) : null,
    top.customerLines > 0 ? td('mat.top.customer', { count: top.customerLines }) : null,
    top.longestWait !== null ? td('mat.top.wait', { count: top.longestWait }) : null,
    top.cost !== null && currency ? td('mat.top.cost', { cost: moneyText(top.cost, currency, locale) }) : null,
  ].filter(Boolean)
  return (
    <p className="fw-pd-answer">
      <Layers3 size={16} aria-hidden />
      <span>{parts.join(' · ')}.</span>
    </p>
  )
}

/** 5.2: a protection or CE label material taken out, or set to "the customer sends it" — check the certificate again (today's Tell Compliance). */
function CeSection({ ce, model, styleId }: { ce: CeRecheck; model: StyleRecordViewModel; styleId: string }) {
  const td = useT('products-bom-depth')
  const held = !model.can.complianceView ? td('mat.ce.heldCompliance') : !model.can.tellCompliance ? td('mat.ce.heldTask') : null
  const href = `${model.prefix}/products/styles/${encodeURIComponent(styleId)}?tab=compliance${model.revisionId ? `&rev=${model.revisionId}` : ''}`
  return (
    <Section
      id="pd-mat-ce"
      title={td('mat.ce.title')}
      answer={td('mat.ce.answer')}
      info={<p>{td('mat.ce.info')}</p>}
      buttons={[
        held ? (
          <Button key="tell" size="sm" variant="primary" heldReason={held}>
            {td('mat.ce.tell')}
          </Button>
        ) : (
          <Button key="tell" size="sm" variant="primary" asChild>
            <a href={href}>{td('mat.ce.tell')}</a>
          </Button>
        ),
      ]}
    >
      <ul className="fw-st-list">
        {ce.takenOut.map((line) => (
          <li key={`out:${line.code}`}>
            <ShieldAlert size={13} aria-hidden /> {td('mat.ce.takenOut', { code: line.code, name: line.name })}
          </li>
        ))}
        {ce.customerSends.map((line) => (
          <li key={`cust:${line.code}`}>
            <ShieldAlert size={13} aria-hidden /> {td('mat.ce.customerSends', { code: line.code, name: line.name, customer: line.sentBy || td('mat.customer') })}
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Main material: the line the customer's leather choice hangs on — it cannot be taken out (pd3 `isMain`). */
function MainSection({ facts, editable }: { facts: readonly LineFacts[]; editable: boolean }) {
  const td = useT('products-bom-depth')
  const main = mainOf(facts)
  return (
    <Section id="pd-mat-main" title={td('mat.main.title')} answer={main ? td('mat.main.answer', { code: main.code, name: main.name }) : td('mat.main.none')} info={<p>{td('mat.main.info')}</p>}>
      <Quiet>{main ? td('mat.main.fixed') : editable ? td('mat.main.howTo') : td('mat.main.noneRead')}</Quiet>
    </Section>
  )
}

/** Before the work starts: the three longest waits (the first decides when to order) and the lines the customer sends. */
function BeforeSection({ facts }: { facts: readonly LineFacts[] }) {
  const td = useT('products-bom-depth')
  const waits = longestWaits(facts)
  const sent = customerSent(facts)
  return (
    <Section id="pd-mat-before" title={td('mat.before.title')} answer={waits[0] ? td('mat.before.answer', { code: waits[0].code, count: waits[0].wait ?? 0 }) : td('mat.before.noWaits')} info={<p>{td('mat.before.info')}</p>}>
      {waits.length > 0 ? (
        <ol className="fw-pd-mat-rows">
          {waits.map((line) => (
            <li key={line.id}>
              <span>
                <b>{line.code}</b> {line.name}
              </span>
              <span className="fw-pt-sub">{td('mat.before.days', { count: line.wait ?? 0 })}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {sent.length > 0 ? (
        <div className="fw-pt-blk">
          <h3 className="fw-pt-h3">{td('mat.before.sentTitle', { count: sent.length })}</h3>
          <ul className="fw-pd-mat-rows">
            {sent.map((line) => (
              <li key={line.id}>
                <span>
                  <b>{line.code}</b> {line.name}
                </span>
                <span className="fw-pt-sub">{line.sentBy ? td('mat.before.sentBy', { customer: line.sentBy }) : td('mat.customer')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  )
}

/** A need table: material, its need with its unit (waste included), the customer's lines said as theirs. */
function NeedTable({ rows }: { rows: readonly NeedRow[] }) {
  const td = useT('products-bom-depth')
  const t = useT('products')
  const locale = useLocale()
  return (
    <table className="fw-pt-table">
      <thead>
        <tr>
          <th>{td('mat.need.col.material')}</th>
          <th className="fw-pt-x">{td('mat.need.col.need')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.lineId}>
            <td className="fw-pt-first">
              <b>{row.code}</b> {row.name}
              {row.sentBy !== null ? (
                <span className="fw-pt-sub">
                  <Tag tone="info">{row.sentBy ? td('mat.before.sentBy', { customer: row.sentBy }) : td('mat.customer')}</Tag>
                </span>
              ) : null}
            </td>
            <td className="fw-pt-x" data-label={td('mat.need.col.need')}>
              {row.need === null ? td('mat.need.unknown') : `${decimalText(row.need, locale, 4)} ${t(`uom.${row.uom}`)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** What an order needs: pieces and a size → the need of each material, waste included. Arithmetic in the browser; nothing is saved. */
function OrderNeedSection({ bom, facts }: { bom: BomView; facts: readonly LineFacts[] }) {
  const td = useT('products-bom-depth')
  const [piecesText, setPiecesText] = useState('10')
  const [size, setSize] = useState<string>(bom.style.baseSize ?? bom.sizes[0]?.code ?? '')
  const pieces = piecesOf(piecesText)
  const rows = pieces === null ? [] : orderNeedOf(bom, facts, size || null, pieces)
  return (
    <Section id="pd-mat-need" title={td('mat.need.title')} answer={td('mat.need.answer')} info={<p>{td('mat.need.info')}</p>}>
      <div className="fw-pd-mat-need">
        <Field label={td('mat.need.pieces')} error={pieces === null ? td('mat.need.piecesHeld') : undefined}>
          <Input inputMode="numeric" value={piecesText} onChange={(event) => setPiecesText(event.target.value)} />
        </Field>
        {bom.sizes.length > 0 ? (
          <Field label={td('mat.need.size')}>
            <Select value={size} onChange={(event) => setSize(event.target.value)}>
              {bom.sizes.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.code === bom.style.baseSize ? td('mat.need.baseSize', { size: entry.code }) : entry.code}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </div>
      {rows.length > 0 ? <NeedTable rows={rows} /> : null}
    </Section>
  )
}

/** Open orders need: the open pieces of the open orders with this product, at the base size (marked: the sizes are not split here). */
function OpenNeedSection({ bom, facts, model, actions }: { bom: BomView; facts: readonly LineFacts[]; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const td = useT('products-bom-depth')
  const part = model.orders
  const pieces = part?.status === 'ready' ? part.value.totals.openPieces : 0
  return (
    <Section
      id="pd-mat-open"
      title={td('mat.open.title')}
      answer={part?.status === 'ready' ? (pieces > 0 ? td('mat.open.answer', { pieces, orders: part.value.totals.openOrders, size: bom.style.baseSize ?? '—' }) : td('mat.open.none')) : undefined}
      info={<p>{td('mat.open.info')}</p>}
    >
      {!part || part.status === 'idle' || part.status === 'loading' ? (
        <PartReading rows={2} />
      ) : part.status === 'error' ? (
        <PartFailed part={td('mat.open.title')} problem={part.problem} onRetry={actions?.onRetryOrders} />
      ) : pieces > 0 ? (
        <NeedTable rows={openOrdersNeedOf(bom, facts, pieces)} />
      ) : null}
    </Section>
  )
}
