'use client'

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, Search, Trash2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { SizeFill } from '@nexus/ui/grid/size-columns/index'
import { Button, Input, Radio, RadioCard, SegmentedControl, Select, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { SECTION_OF_KIND, type BomSection } from '@nexus/factory-domain/product/bom-structure/rules'
import { CellSaveMark, Modal, Textarea, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { BomView, MaterialView } from '../../../api'
import { decimalText, editText } from '../../../model'
import type { StyleRecordActions } from '../../../record/record-model'
import type { Alternate, DepthLine, StructureLine } from '../api'
import {
  addAlternateHeld,
  alternateQty,
  ALTERNATE_NOTE_MAX,
  ALTERNATE_USES,
  BOM_SECTIONS,
  certificateHeld,
  customerHeld,
  depthHeld,
  groupChoices,
  isAlternateUse,
  lineName,
  lineRows,
  markKey,
  optionLabel,
  ready,
  sizeQty,
  subAssemblyHeld,
  subRevisions,
  supplyBlocked,
  type BomDepthActions,
  type BomDepthModel,
  type CellMark,
  type LinePart,
} from '../model'

interface Shared {
  bom: BomView
  model: BomDepthModel
  actions?: BomDepthActions
  recordActions?: StyleRecordActions
  /** The record's materials (an alternate's colours are its material's). */
  materials: Record<string, MaterialView | null>
  prefix: string
  styleId: string
}

/**
 * The pop-ups of the BOM in depth (B-W2b-241): the line in depth (design pop:styles.bomLine, "Autosaves per field", with
 * W2b's Alternates; ⌘↑ / ⌘↓ the next line, Esc closes), the selection's Section… / Group… / Supply…, Fill from base by
 * increment (the DS SizeFill in a sheet) and Remove alternate. Every change goes to the server at once through the studio's
 * queue; a field's save shows its mark (saving, refused with "!"). A frozen revision, no right or offline: read only, said
 * why.
 */
export function DepthDialogs(props: Shared) {
  const dialog = props.model.dialog
  if (!dialog) return null
  return <Refused model={props.model}>{body(props)}</Refused>
}

/** The pop-up with the server's refusal on top (our words, the API's sentence as its detail). */
function Refused({ model, children }: { model: BomDepthModel; children: ReactNode }) {
  return (
    <RefusalContext.Provider value={model.refusal}>
      {children}
    </RefusalContext.Provider>
  )
}

const RefusalContext = createContext<BomDepthModel['refusal']>(null)

function RefusalBanner() {
  const tp = useT('products')
  const refusal = useContext(RefusalContext)
  const at = useRef<HTMLDivElement>(null)
  // A refusal comes into view (the pop-up may be scrolled to the part that was changed).
  useEffect(() => {
    if (refusal) at.current?.scrollIntoView?.({ block: 'nearest' })
  }, [refusal])
  if (!refusal) return null
  return (
    <div ref={at}>
      <Banner tone="danger" title={tp(refusal.key)}>
        {refusal.detail}
      </Banner>
    </div>
  )
}

function body(props: Shared): ReactNode {
  const dialog = props.model.dialog!
  switch (dialog.kind) {
    case 'line':
      return <LineDrawer {...props} lineId={dialog.lineId} part={dialog.part} />
    case 'section':
      return <SectionDialog {...props} lineIds={dialog.lineIds} />
    case 'group':
      return <GroupDialog {...props} lineIds={dialog.lineIds} />
    case 'supply':
      return <SupplyDialog {...props} lineIds={dialog.lineIds} />
    case 'fill':
      return <FillDialog {...props} lineId={dialog.lineId} />
    case 'removeAlternate':
      return <RemoveAlternateDialog {...props} lineId={dialog.lineId} alternateId={dialog.alternateId} />
    default:
      return null
  }
}

/** A field's label with its save mark ("↻" saving, "!" refused with our words). */
function Marked({ text, mark }: { text: string; mark: CellMark | undefined }) {
  const t = useT('products-bom-depth')
  return (
    <span className="fw-bmd-label">
      {text}
      {mark?.state === 'refused' ? (
        <span className="fw-bmd-refused" role="img" aria-label={t(mark.problem ?? 'mark.refused')} title={t(mark.problem ?? 'mark.refused')}>
          !
        </span>
      ) : mark ? (
        <CellSaveMark state={mark.state} />
      ) : null}
    </span>
  )
}

// ---- the line in depth ------------------------------------------------------------------------------------------------------

function LineDrawer(props: Shared & { lineId: string; part: LinePart }) {
  const { bom, model, actions, recordActions, lineId, part } = props
  const t = useT('products-bom-depth')
  const locale = useLocale()
  const structure = ready(model.structure)
  const depth = ready(model.depth)
  const rows = lineRows(bom, structure, depth, ready(model.options), locale)
  const at = rows.findIndex((row) => row.id === lineId)
  const row = rows[at]
  const held = depthHeld(structure, model.canManage, model.offline, false)
  const go = (delta: -1 | 1) => {
    const next = rows[at + delta]
    if (next) actions?.onDialog?.({ kind: 'line', lineId: next.id, part })
  }
  if (!row) return null
  const line = row.structure
  const deep = row.depth
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="lg"
      title={t('line.title', { line: lineName(row.line) })}
      subtitle={row.line.item.name}
      footer={
        <>
          <Button size="sm" variant="quiet" heldReason={at <= 0 ? t('line.held.first') : null} onClick={() => go(-1)} aria-keyshortcuts="Meta+ArrowUp">
            <ArrowUp size={13} aria-hidden /> {t('line.previous')}
          </Button>
          <Button size="sm" variant="quiet" heldReason={at >= rows.length - 1 ? t('line.held.last') : null} onClick={() => go(1)} aria-keyshortcuts="Meta+ArrowDown">
            <ArrowDown size={13} aria-hidden /> {t('line.next')}
          </Button>
          <Button
            heldReason={held && held !== 'hold.busy' ? t(held) : null}
            onClick={() => {
              actions?.onDialog?.(null)
              recordActions?.onDialog?.({ kind: 'bomLine', lineId })
            }}
          >
            {t('line.editW1')}
          </Button>
          <Button variant="primary" onClick={() => actions?.onDialog?.(null)}>
            {t('line.close')}
          </Button>
        </>
      }
    >
      <div
        className="fw-bmd-stack"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault()
            go(event.key === 'ArrowUp' ? -1 : 1)
          }
        }}
      >
        <SegmentedControl
          size="sm"
          ariaLabel={t('line.parts')}
          value={part}
          onChange={(value) => actions?.onDialog?.({ kind: 'line', lineId, part: value as LinePart })}
          options={[
            { value: 'structure', label: t('line.part.structure') },
            { value: 'alternates', label: t('line.part.alternates', { count: deep?.alternates.length ?? line?.alternates ?? 0 }) },
          ]}
        />
        <RefusalBanner />
        {held && held !== 'hold.busy' && <Banner tone="info" title={t(held)} />}
        {!held && <p className="fw-bmd-hint">{t('line.autosave')}</p>}
        {!line || !deep ? (
          <p className="fw-bmd-hint" role="status">
            <Spinner size={14} /> {t('line.loading')}
          </p>
        ) : part === 'structure' ? (
          <StructurePart {...props} line={line} deep={deep} editable={held === null} />
        ) : (
          <AlternatesPart {...props} line={line} deep={deep} editable={held === null} />
        )}
        <p className="fw-bmd-hint">{t('line.w1Fields')}</p>
      </div>
    </Modal>
  )
}

function StructurePart({ model, actions, prefix, styleId, line, deep, editable }: Shared & { line: StructureLine; deep: DepthLine; editable: boolean }) {
  const t = useT('products-bom-depth')
  const tp = useT('products')
  const locale = useLocale()
  const structure = ready(model.structure)!
  const options = model.options
  const mark = (field: string) => model.marks[markKey(line.id, field)]
  const kindSection = SECTION_OF_KIND[line.item.kind]
  const parent = line.parentLineId ? structure.lines.find((entry) => entry.id === line.parentLineId) : undefined
  const under = structure.lines.filter((entry) => line.groupedLineIds.includes(entry.id))
  const choices = groupChoices(structure.lines, [line.id])
  const subHeld = subAssemblyHeld(line)
  const custHeld = customerHeld(deep)
  return (
    <div className="fw-bmd-stack">
      <div className="fw-bmd-form">
        <Field label={<Marked text={t('line.section')} mark={mark('section')} />} hint={line.filed ? t('line.sectionFiled') : t('line.sectionKindHint', { kind: tp(`kind.${line.item.kind}`) })}>
          {editable ? (
            <Select value={line.filed ? line.section : ''} onChange={(event) => void actions?.onStructure?.(line.id, { section: (event.target.value || null) as BomSection | null }, 'section')}>
              <option value="">{t('line.sectionKind', { section: t(`section.${kindSection}`) })}</option>
              {BOM_SECTIONS.map((section) => (
                <option key={section} value={section}>
                  {t(`section.${section}`)}
                </option>
              ))}
            </Select>
          ) : (
            <p className="fw-bmd-sub">{t(`section.${line.section}`)}</p>
          )}
        </Field>
        <Field label={<Marked text={t('line.group')} mark={mark('parentLineId')} />} hint={under.length > 0 ? t('line.groupRow', { lines: under.map((entry) => entry.seq).join(', ') }) : t('line.groupHint')}>
          {editable ? (
            <Select value={line.parentLineId ?? ''} onChange={(event) => void actions?.onStructure?.(line.id, { parentLineId: event.target.value || null }, 'parentLineId')}>
              <option value="">{t('line.notGrouped')}</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {lineName(choice)} {choice.item.name}
                </option>
              ))}
            </Select>
          ) : (
            <p className="fw-bmd-sub">{parent ? lineName(parent) : t('line.notGrouped')}</p>
          )}
        </Field>
      </div>

      <section className="fw-bmd-stack" aria-label={t('line.sub.title')}>
        <p className="fw-bmd-label">
          <Marked text={t('line.sub.title')} mark={mark('subAssembly')} />
        </p>
        {line.subAssembly ? (
          <div className="fw-bmd-chosen">
            <span className="fw-bmd-cell">
              <span>
                <b>{line.subAssembly.style.code}</b> {line.subAssembly.style.name}
              </span>
              <span className="fw-bmd-sub">
                {t('tree.revision', { revision: line.subAssembly.revision.revision, status: t(`revisionStatus.${line.subAssembly.revision.status}`) })} ·{' '}
                {t('tree.makes', { qty: line.subAssembly.outputQuantity, unit: tp(`uom.${line.subAssembly.outputUom}`) })}
              </span>
            </span>
            <span className="fw-bmd-inline">
              <Link className="fw-bmd-link" href={`${prefix}/products/styles/${line.subAssembly.style.id}?tab=bom&rev=${line.subAssembly.revision.id}`}>
                {t('tree.open')}
              </Link>
              {editable && (
                <Button size="sm" variant="quiet" onClick={() => void actions?.onStructure?.(line.id, { subAssembly: null }, 'subAssembly')}>
                  {t('line.sub.remove')}
                </Button>
              )}
            </span>
          </div>
        ) : subHeld ? (
          <p className="fw-bmd-hint">{t(subHeld, { line: line.seq })}</p>
        ) : editable ? (
          <SubAssemblyPicker model={model} actions={actions} line={line} />
        ) : (
          <p className="fw-bmd-hint">{t('line.sub.none')}</p>
        )}
        {line.subAssembly && editable && <SubAssemblyPicker model={model} actions={actions} line={line} again />}
      </section>

      <section className="fw-bmd-stack" aria-label={t('line.supply.title')}>
        <p className="fw-bmd-label">
          <Marked text={t('line.supply.title')} mark={mark('customer')} />
        </p>
        <p>{deep.customerSupplied ? t('supply.sentBy', { name: deep.customerSupplied.name }) : deep.subAssembly ? t('supply.weMake') : deep.supplier ? t('supply.boughtFrom', { name: deep.supplier.name }) : t('supply.weBuy')}</p>
        {custHeld ? (
          <p className="fw-bmd-hint">{t(custHeld)}</p>
        ) : editable ? (
          <>
            {deep.customerSupplied && (
              <span>
                <Button size="sm" onClick={() => void actions?.onSupply?.(line.id, { customerSuppliedByPartyId: null }, 'customer')}>
                  {t('line.supply.weBuyInstead')}
                </Button>
              </span>
            )}
            <CustomerPicker model={model} actions={actions} onPick={(partyId) => void actions?.onSupply?.(line.id, { customerSuppliedByPartyId: partyId }, 'customer')} />
          </>
        ) : null}
        <Field label={<Marked text={t('line.workshop')} mark={mark('workshop')} />} hint={deep.issueToSubcontract ? t(deep.kit === 'CUT' ? 'line.workshopCut' : 'line.workshopKit') : t('line.workshopHint')}>
          <span className="fw-bmd-inline">
            <Toggle checked={deep.issueToSubcontract} disabled={!editable} aria-label={t('line.workshop')} onChange={(next) => void actions?.onSupply?.(line.id, { issueToSubcontract: next }, 'workshop')} />
            {t(deep.issueToSubcontract ? 'common.yes' : 'common.no')}
          </span>
        </Field>
      </section>

      <section className="fw-bmd-stack" aria-label={t('line.option.title')}>
        <Field
          label={<Marked text={t('line.option.title')} mark={mark('option')} />}
          hint={
            <>
              {options.status === 'error' ? t('line.option.failed') : options.status === 'ready' && options.value.offers.filter((offer) => offer.status === 'ACTIVE').length === 0 ? t('line.option.none') : t('line.option.hint')}{' '}
              <Link className="fw-bmd-link" href={`${prefix}/products/options?style=${encodeURIComponent(styleId)}`}>
                {t('line.option.link')}
              </Link>
            </>
          }
        >
          {editable && options.status === 'ready' ? (
            <Select value={line.optionValueId ?? ''} onChange={(event) => void actions?.onOption?.(line.id, event.target.value || null)}>
              <option value="">{t('option.every')}</option>
              {options.value.offers
                .filter((offer) => offer.status === 'ACTIVE')
                .map((offer) => (
                  <optgroup key={offer.id} label={offer.group.nameI18n?.[locale] ?? offer.group.name}>
                    {offer.values
                      .filter((value) => value.status === 'ACTIVE' || value.id === line.optionValueId)
                      .map((value) => (
                        <option key={value.id} value={value.id}>
                          {value.nameI18n?.[locale] ?? value.name} ({value.code})
                        </option>
                      ))}
                  </optgroup>
                ))}
            </Select>
          ) : (
            <p className="fw-bmd-sub">{line.optionValueId ? ((options.status === 'ready' ? optionLabel(options.value.offers, line.optionValueId, locale) : null) ?? '—') : t('option.every')}</p>
          )}
        </Field>
      </section>
    </div>
  )
}

/** A search box that asks after a pause (never on every key). */
function useSearch(onQuery: ((query: string) => void) | undefined): [string, (value: string) => void, boolean] {
  const [query, setQuery] = useState('')
  const typed = useRef(false)
  const ask = useRef(onQuery)
  ask.current = onQuery
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => ask.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  return [
    query,
    (value: string) => {
      typed.current = true
      setQuery(value)
    },
    typed.current,
  ]
}

function SubAssemblyPicker({ model, actions, line, again = false }: Pick<Shared, 'model' | 'actions'> & { line: StructureLine; again?: boolean }) {
  const t = useT('products-bom-depth')
  const [open, setOpen] = useState(!again)
  const [query, setQuery, typed] = useSearch(actions?.onFindStyles)
  const [revisionId, setRevisionId] = useState('')
  const picked = model.subStyle
  useEffect(() => setRevisionId(''), [picked?.status === 'ready' ? picked.value.id : null])
  if (!open)
    return (
      <span>
        <Button size="sm" onClick={() => setOpen(true)}>
          {t('line.sub.another')}
        </Button>
      </span>
    )
  if (picked?.status === 'ready') {
    const revisions = subRevisions(picked.value)
    const chosen = revisionId || revisions[0]?.id || ''
    return (
      <div className="fw-bmd-stack">
        <div className="fw-bmd-chosen">
          <span>
            <b>{picked.value.code}</b> {picked.value.name}
          </span>
          <Button size="sm" variant="quiet" onClick={() => actions?.onPickStyle?.(null)}>
            {t('line.sub.change')}
          </Button>
        </div>
        {revisions.length === 0 ? (
          <p className="fw-bmd-hint">{t('line.sub.noRevision')}</p>
        ) : (
          <Field label={t('line.sub.revision')} hint={t('line.sub.revisionHint')}>
            <Select value={chosen} onChange={(event) => setRevisionId(event.target.value)}>
              {revisions.map((revision) => (
                <option key={revision.id} value={revision.id}>
                  {t('tree.revision', { revision: revision.revision, status: t(`revisionStatus.${revision.status}`) })}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <span>
          <Button
            size="sm"
            variant="primary"
            heldReason={chosen ? (model.busy ? t('hold.busy') : null) : t('line.sub.held.revision')}
            onClick={() => void actions?.onStructure?.(line.id, { subAssembly: { styleId: picked.value.id, revisionId: chosen } }, 'subAssembly').then((ok) => ok && actions?.onPickStyle?.(null))}
          >
            {t('line.sub.take', { revision: revisions.find((revision) => revision.id === chosen)?.revision ?? '—' })}
          </Button>
        </span>
      </div>
    )
  }
  const results = model.styles.results
  return (
    <div className="fw-bmd-stack">
      <Field label={t('line.sub.search')} hint={t('line.sub.searchHint', { line: line.seq })}>
        <Input type="search" leadingIcon={<Search size={13} aria-hidden />} value={query} placeholder={t('line.sub.placeholder')} onChange={(event) => setQuery(event.target.value)} />
      </Field>
      {picked?.status === 'loading' && (
        <p className="fw-bmd-hint" role="status">
          <Spinner size={14} /> {t('line.sub.reading')}
        </p>
      )}
      {picked?.status === 'error' && <Banner tone="danger" title={t('line.sub.failed')} />}
      {model.styles.problem ? (
        <Banner tone="danger" title={t('search.failed')} />
      ) : (
        <fieldset className="fw-bmd-choices">
          <legend className="fw-bmd-legend" aria-live="polite">
            {results === null ? (typed ? t('search.searching') : t('search.type')) : results.length === 0 ? t('search.none') : t('search.found', { count: results.length })}
          </legend>
          <div className="fw-bmd-results">
            {(results ?? []).map((row) => (
              <RadioCard key={row.id} variant="row" name="fw-bmd-sub" value={row.id} checked={false} onChange={() => actions?.onPickStyle?.(row.id)} title={`${row.code} · ${row.name}`} description={row.season ?? undefined} />
            ))}
          </div>
        </fieldset>
      )}
    </div>
  )
}

function CustomerPicker({ model, actions, onPick }: Pick<Shared, 'model' | 'actions'> & { onPick: (partyId: string) => void }) {
  const t = useT('products-bom-depth')
  const [query, setQuery, typed] = useSearch(actions?.onFindCustomers)
  const results = model.customers.results
  return (
    <div className="fw-bmd-stack">
      <Field label={t('line.supply.search')} hint={t('line.supply.searchHint')}>
        <Input type="search" leadingIcon={<Search size={13} aria-hidden />} value={query} placeholder={t('line.supply.placeholder')} onChange={(event) => setQuery(event.target.value)} />
      </Field>
      {model.customers.problem ? (
        <Banner tone="warning" title={t('line.supply.searchFailed')} />
      ) : typed || results !== null ? (
        <fieldset className="fw-bmd-choices">
          <legend className="fw-bmd-legend" aria-live="polite">
            {results === null ? t('search.searching') : results.length === 0 ? t('search.none') : t('search.found', { count: results.length })}
          </legend>
          <div className="fw-bmd-results">
            {(results ?? []).map((party) => (
              <RadioCard key={party.id} variant="row" name="fw-bmd-customer" value={party.id} checked={false} onChange={() => onPick(party.id)} title={`${party.code} · ${party.tradeName ?? party.legalName}`} description={party.tradeName ? party.legalName : undefined} />
            ))}
          </div>
        </fieldset>
      ) : null}
    </div>
  )
}

// ---- alternates ----------------------------------------------------------------------------------------------------------------

function AlternatesPart({ bom, model, actions, recordActions, materials, line, deep, editable }: Shared & { line: StructureLine; deep: DepthLine; editable: boolean }) {
  const t = useT('products-bom-depth')
  const tp = useT('products')
  const locale = useLocale()
  const w1 = bom.lines.find((entry) => entry.id === line.id)
  const addHeld = addAlternateHeld(deep, editable ? null : 'hold.frozen')
  const [query, setQuery, typed] = useSearch(actions?.onFindMaterials)
  const taken = new Set([deep.item.id, ...deep.alternates.map((alternate) => alternate.item.id)])
  const results = (model.materials.results ?? []).filter((row) => !taken.has(row.id))
  const loadMaterial = useRef(recordActions?.onLoadMaterial)
  loadMaterial.current = recordActions?.onLoadMaterial
  const needed = deep.alternates.map((alternate) => alternate.item.id).join(',')
  useEffect(() => {
    for (const id of needed.split(',')) if (id && !(id in materials)) loadMaterial.current?.(id)
  }, [needed])
  return (
    <div className="fw-bmd-stack">
      <p className="fw-bmd-hint">{t('alt.intro', { code: deep.item.code })}</p>
      {deep.alternates.length === 0 && <p className="fw-bmd-sub">{t('alt.empty')}</p>}
      {deep.alternates.map((alternate, index) => (
        <AlternateCard
          key={alternate.id}
          model={model}
          actions={actions}
          lineId={line.id}
          alternate={alternate}
          first={index === 0}
          last={index === deep.alternates.length - 1}
          editable={editable}
          material={materials[alternate.item.id] ?? null}
          lineQty={w1 ? `${decimalText(w1.qty, locale)} ${tp(`uom.${w1.uom}`)}` : '—'}
          unit={w1 ? tp(`uom.${w1.uom}`) : ''}
        />
      ))}
      <section className="fw-bmd-stack" aria-label={t('alt.add')}>
        <p className="fw-bmd-label">
          <b>{t('alt.add')}</b>
        </p>
        {addHeld ? (
          <p className="fw-bmd-hint">{t(addHeld)}</p>
        ) : (
          <>
            <Field label={t('alt.search')} hint={t('alt.searchHint')}>
              <Input type="search" leadingIcon={<Search size={13} aria-hidden />} value={query} placeholder={tp('bom.line.materialPlaceholder')} onChange={(event) => setQuery(event.target.value)} />
            </Field>
            {model.materials.problem ? (
              <Banner tone="danger" title={t('search.failed')} />
            ) : (
              <fieldset className="fw-bmd-choices">
                <legend className="fw-bmd-legend" aria-live="polite">
                  {model.materials.results === null ? (typed ? t('search.searching') : t('search.type')) : results.length === 0 ? t('search.none') : t('search.found', { count: results.length })}
                </legend>
                <div className="fw-bmd-results">
                  {results.map((row) => (
                    <RadioCard
                      key={row.id}
                      variant="row"
                      name="fw-bmd-alt"
                      value={row.id}
                      checked={false}
                      onChange={() => void actions?.onAddAlternate?.(line.id, { itemId: row.id })}
                      title={`${row.code} · ${row.name}`}
                      description={[tp(`kind.${row.kind}`), tp(`uom.${row.consumptionUom}`), row.defaultSupplier?.name].filter(Boolean).join(' · ')}
                    />
                  ))}
                </div>
              </fieldset>
            )}
          </>
        )}
      </section>
    </div>
  )
}

function AlternateCard({
  model,
  actions,
  lineId,
  alternate,
  first,
  last,
  editable,
  material,
  lineQty,
  unit,
}: {
  model: BomDepthModel
  actions?: BomDepthActions
  lineId: string
  alternate: Alternate
  first: boolean
  last: boolean
  editable: boolean
  material: MaterialView | null
  lineQty: string
  unit: string
}) {
  const t = useT('products-bom-depth')
  const locale = useLocale()
  const [qty, setQty] = useState(editText(alternate.qty, locale))
  const [note, setNote] = useState(alternate.note ?? '')
  const [qtyBad, setQtyBad] = useState(false)
  useEffect(() => setQty(editText(alternate.qty, locale)), [alternate.qty, locale])
  useEffect(() => setNote(alternate.note ?? ''), [alternate.note])
  const mark = (field: string) => model.marks[markKey(alternate.id, field)]
  const saveQty = () => {
    const value = alternateQty(qty)
    if (value === undefined) {
      setQtyBad(true)
      return
    }
    setQtyBad(false)
    if (value === (alternate.qty === null ? null : alternateQty(alternate.qty))) return
    void actions?.onAlternate?.(lineId, alternate.id, { qty: value }, 'qty')
  }
  const saveNote = () => {
    const value = note.trim() || null
    if (value === (alternate.note ?? null)) return
    void actions?.onAlternate?.(lineId, alternate.id, { note: value }, 'note')
  }
  const certHeld = certificateHeld(alternate)
  const colours = material?.colours.filter((colour) => colour.status === 'ACTIVE' || colour.id === alternate.itemColour?.id) ?? []
  const tags: ReactNode[] = []
  if (alternate.item.status !== 'ACTIVE') tags.push(<Tag key="s" tone="danger">{t(`materialStatus.${alternate.item.status}`)}</Tag>)
  if (alternate.item.approval !== 'APPROVED') tags.push(<Tag key="a" tone={alternate.item.approval === 'BLOCKED' ? 'danger' : 'warning'}>{t(`approval.${alternate.item.approval}`)}</Tag>)
  if (alternate.item.isPpeComponent) tags.push(<Tag key="p" tone="info">{t('alt.ppe')}</Tag>)
  return (
    <article className="fw-bmd-alt" aria-label={t('alt.label', { priority: alternate.priority, code: alternate.item.code })}>
      <div className="fw-bmd-alt-head">
        <span className="fw-bmd-cell">
          <span>
            <b>
              {alternate.priority} · {alternate.item.code}
            </b>{' '}
            {alternate.item.name}
          </span>
          <span className="fw-bmd-sub">{alternate.needs.length === 0 ? t('alt.needs.none') : alternate.needs.map((need) => t(`alt.needs.${need}`)).join(' · ')}</span>
        </span>
        <span className="fw-bmd-inline">
          {tags}
          {editable && (
            <>
              <Button size="sm" variant="quiet" heldReason={first ? t('alt.held.first') : model.busy ? t('hold.busy') : null} onClick={() => void actions?.onMoveAlternate?.(lineId, alternate.id, -1)} aria-label={t('alt.up', { code: alternate.item.code })}>
                <ArrowUp size={13} aria-hidden />
              </Button>
              <Button size="sm" variant="quiet" heldReason={last ? t('alt.held.last') : model.busy ? t('hold.busy') : null} onClick={() => void actions?.onMoveAlternate?.(lineId, alternate.id, 1)} aria-label={t('alt.down', { code: alternate.item.code })}>
                <ArrowDown size={13} aria-hidden />
              </Button>
              <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.({ kind: 'removeAlternate', lineId, alternateId: alternate.id })} aria-label={t('alt.remove', { code: alternate.item.code })}>
                <Trash2 size={13} aria-hidden />
              </Button>
            </>
          )}
        </span>
      </div>
      {editable ? (
        <div className="fw-bmd-form">
          <Field label={<Marked text={t('alt.when')} mark={mark('allowedWhen')} />}>
            <Select value={alternate.allowedWhen} onChange={(event) => isAlternateUse(event.target.value) && void actions?.onAlternate?.(lineId, alternate.id, { allowedWhen: event.target.value }, 'allowedWhen')}>
              {ALTERNATE_USES.map((use) => (
                <option key={use} value={use}>
                  {t(`alt.use.${use}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={<Marked text={t('alt.qty')} mark={mark('qty')} />} hint={t('alt.qtyHint', { qty: lineQty })} error={qtyBad ? t('alt.qtyBad') : undefined}>
            <Input
              inputMode="decimal"
              value={qty}
              placeholder={t('alt.qtyLine')}
              suffix={unit}
              onChange={(event) => setQty(event.target.value)}
              onBlur={saveQty}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveQty()
                }
              }}
            />
          </Field>
          <Field label={<Marked text={t('alt.colour')} mark={mark('itemColourId')} />} hint={material ? undefined : t('alt.colourLoading')}>
            <Select value={alternate.itemColour?.id ?? ''} disabled={!material} onChange={(event) => void actions?.onAlternate?.(lineId, alternate.id, { itemColourId: event.target.value || null }, 'itemColourId')}>
              <option value="">{t('alt.noColour')}</option>
              {colours.map((colour) => (
                <option key={colour.id} value={colour.id}>
                  {colour.code} · {colour.name}
                </option>
              ))}
              {alternate.itemColour && !colours.some((colour) => colour.id === alternate.itemColour!.id) && <option value={alternate.itemColour.id}>{alternate.itemColour.code}</option>}
            </Select>
          </Field>
          <Field label={<Marked text={t('alt.certificate')} mark={mark('certificateCheck')} />} hint={certHeld ? t(certHeld) : t('alt.certificateHint')}>
            <span className="fw-bmd-inline">
              <Toggle checked={alternate.certificateCheck} disabled={!!certHeld && alternate.certificateCheck} aria-label={t('alt.certificate')} onChange={(next) => void actions?.onAlternate?.(lineId, alternate.id, { certificateCheck: next }, 'certificateCheck')} />
              {t(alternate.certificateCheck ? 'common.yes' : 'common.no')}
            </span>
          </Field>
        </div>
      ) : (
        <p className="fw-bmd-sub">
          {t(`alt.use.${alternate.allowedWhen}`)} · {alternate.qty ? `${decimalText(alternate.qty, locale)} ${unit}` : t('alt.qtyLineRead', { qty: lineQty })} · {alternate.itemColour ? `${alternate.itemColour.code} · ${alternate.itemColour.name}` : t('alt.noColour')} · {t(alternate.certificateCheck ? 'alt.certificateOn' : 'alt.certificateOff')}
        </p>
      )}
      {alternate.item.isPpeComponent && (
        <p className={alternate.certificate ? 'fw-bmd-sub' : 'fw-bmd-sub fw-bmd-warn'}>
          {alternate.certificate ? t('alt.covered', { number: alternate.certificate.number, standard: alternate.certificate.standard, to: formatDate(alternate.certificate.validTo, { locale }) }) : t('alt.notCovered')}
        </p>
      )}
      {editable ? (
        <Field label={<Marked text={t('alt.note')} mark={mark('note')} />}>
          <Textarea value={note} rows={2} maxLength={ALTERNATE_NOTE_MAX} onChange={(event) => setNote(event.target.value)} onBlur={saveNote} />
        </Field>
      ) : alternate.note ? (
        <p className="fw-bmd-sub">{alternate.note}</p>
      ) : null}
    </article>
  )
}

function RemoveAlternateDialog({ model, actions, lineId, alternateId }: Shared & { lineId: string; alternateId: string }) {
  const t = useT('products-bom-depth')
  const depth = ready(model.depth)
  const line = depth?.lines.find((entry) => entry.id === lineId)
  const alternate = line?.alternates.find((entry) => entry.id === alternateId)
  const back = () => actions?.onDialog?.({ kind: 'line', lineId, part: 'alternates' })
  return (
    <Modal
      open
      onClose={back}
      size="sm"
      title={t('alt.removeTitle', { code: alternate?.item.code ?? '—', line: line ? lineName(line) : '—' })}
      footer={
        <>
          <Button onClick={back}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('hold.busy') : null} onClick={() => void actions?.onRemoveAlternate?.(lineId, alternateId)}>
            {t('alt.removeConfirm')}
          </Button>
        </>
      }
    >
      <RefusalBanner />
      <p>{t('alt.removeBody')}</p>
    </Modal>
  )
}

// ---- the selection --------------------------------------------------------------------------------------------------------------

function namesOf(bom: BomView, lineIds: readonly string[]): string {
  return bom.lines
    .filter((line) => lineIds.includes(line.id))
    .map((line) => lineName(line))
    .join(', ')
}

function SectionDialog({ bom, model, actions, lineIds }: Shared & { lineIds: string[] }) {
  const t = useT('products-bom-depth')
  const [section, setSection] = useState<string>('')
  const held = depthHeld(ready(model.structure), model.canManage, model.offline, model.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="md"
      title={t('bulk.sectionTitle', { count: lineIds.length })}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => void actions?.onChangeStructure?.(lineIds, { section: (section || null) as BomSection | null })}>
            {t('bulk.apply', { count: lineIds.length })}
          </Button>
        </>
      }
    >
      <div className="fw-bmd-stack">
        <RefusalBanner />
        <p className="fw-bmd-hint">{namesOf(bom, lineIds)}</p>
        <Field label={t('line.section')} hint={t('bulk.sectionHint')}>
          <Select value={section} onChange={(event) => setSection(event.target.value)}>
            <option value="">{t('bulk.sectionKind')}</option>
            {BOM_SECTIONS.map((one) => (
              <option key={one} value={one}>
                {t(`section.${one}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

function GroupDialog({ bom, model, actions, lineIds }: Shared & { lineIds: string[] }) {
  const t = useT('products-bom-depth')
  const structure = ready(model.structure)
  const choices = structure ? groupChoices(structure.lines, lineIds) : []
  const [parent, setParent] = useState<string>('')
  const held = depthHeld(structure, model.canManage, model.offline, model.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="md"
      title={t('bulk.groupTitle', { count: lineIds.length })}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => void actions?.onChangeStructure?.(lineIds, { parentLineId: parent || null })}>
            {parent ? t('bulk.groupApply', { count: lineIds.length }) : t('bulk.ungroupApply', { count: lineIds.length })}
          </Button>
        </>
      }
    >
      <div className="fw-bmd-stack">
        <RefusalBanner />
        <p className="fw-bmd-hint">{namesOf(bom, lineIds)}</p>
        <Field label={t('line.group')} hint={t('bulk.groupHint')}>
          <Select value={parent} onChange={(event) => setParent(event.target.value)}>
            <option value="">{t('line.notGrouped')}</option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {lineName(choice)} {choice.item.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

type Who = 'keep' | 'we' | 'customer'
type Mark = 'keep' | 'yes' | 'no'

function SupplyDialog({ bom, model, actions, lineIds }: Shared & { lineIds: string[] }) {
  const t = useT('products-bom-depth')
  const locale = useLocale()
  const [who, setWho] = useState<Who>('keep')
  const [partyId, setPartyId] = useState<string | null>(null)
  const [workshop, setWorkshop] = useState<Mark>('keep')
  const structure = ready(model.structure)
  const rows = lineRows(bom, structure, ready(model.depth), null, locale).filter((row) => lineIds.includes(row.id))
  const blocked = who === 'customer' ? supplyBlocked(rows) : []
  const party = model.customers.results?.find((entry) => entry.id === partyId) ?? null
  const base = depthHeld(structure, model.canManage, model.offline, model.busy)
  const held = base
    ? t(base)
    : who === 'keep' && workshop === 'keep'
      ? t('bulk.supplyNothing')
      : who === 'customer' && !partyId
        ? t('bulk.supplyChoose')
        : blocked.length > 0
          ? t('bulk.supplyBlocked', { lines: blocked.join(', ') })
          : null
  const apply = () =>
    void actions?.onChangeSupply?.(lineIds, {
      ...(who === 'we' ? { customerSuppliedByPartyId: null } : who === 'customer' && partyId ? { customerSuppliedByPartyId: partyId } : {}),
      ...(workshop === 'keep' ? {} : { issueToSubcontract: workshop === 'yes' }),
    })
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      size="lg"
      title={t('bulk.supplyTitle', { count: lineIds.length })}
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={apply}>
            {t('bulk.apply', { count: lineIds.length })}
          </Button>
        </>
      }
    >
      <div className="fw-bmd-stack">
        <RefusalBanner />
        <p className="fw-bmd-hint">{namesOf(bom, lineIds)}</p>
        <fieldset className="fw-bmd-choices">
          <legend className="fw-bmd-legend">{t('line.supply.title')}</legend>
          {(['keep', 'we', 'customer'] as const).map((value) => (
            <Radio key={value} name="fw-bmd-who" value={value} checked={who === value} onChange={() => setWho(value)} label={t(`bulk.who.${value}`)} />
          ))}
        </fieldset>
        {who === 'customer' &&
          (party ? (
            <div className="fw-bmd-chosen">
              <span>
                <b>{party.code}</b> {party.tradeName ?? party.legalName}
              </span>
              <Button size="sm" variant="quiet" onClick={() => setPartyId(null)}>
                {t('line.sub.change')}
              </Button>
            </div>
          ) : (
            <CustomerPicker model={model} actions={actions} onPick={setPartyId} />
          ))}
        <fieldset className="fw-bmd-choices">
          <legend className="fw-bmd-legend">{t('line.workshop')}</legend>
          {(['keep', 'yes', 'no'] as const).map((value) => (
            <Radio key={value} name="fw-bmd-workshop" value={value} checked={workshop === value} onChange={() => setWorkshop(value)} label={t(`bulk.workshop.${value}`)} />
          ))}
        </fieldset>
      </div>
    </Modal>
  )
}

// ---- fill from base by increment -------------------------------------------------------------------------------------------------

function FillDialog({ bom, model, actions, lineId }: Shared & { lineId: string }) {
  const t = useT('products-bom-depth')
  const tp = useT('products')
  const locale = useLocale()
  const ds = useDsWords()
  const line = bom.lines.find((entry) => entry.id === lineId)
  if (!line) return null
  const sizes = bom.sizes.map((size) => size.code)
  const values = Object.fromEntries(sizes.map((size) => [size, sizeQty(line, size)]))
  const held = depthHeld(ready(model.structure), model.canManage, model.offline, model.busy)
  return (
    <Modal open onClose={() => actions?.onDialog?.(null)} title={t('fill.title', { line: lineName(line) })} sheet>
      <div className="fw-bmd-stack">
        <RefusalBanner />
        <p className="fw-bmd-hint">{t('fill.intro', { unit: tp(`uom.${line.uom}`) })}</p>
        <SizeFill
          sizes={sizes}
          base={bom.style.baseSize}
          values={values}
          unit={tp(`uom.${line.uom}`)}
          scale={4}
          locale={INTL_LOCALE[locale]}
          heldReason={held ? t(held) : null}
          onApply={(changes) => void actions?.onFill?.(lineId, changes.map((change) => ({ size: change.size, qty: change.to })))}
          onCancel={() => actions?.onDialog?.(null)}
          labels={ds.sizeColumns}
        />
      </div>
    </Modal>
  )
}
