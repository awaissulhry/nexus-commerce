'use client'

import type { ReactNode } from 'react'
import { KeyValue, SummaryTable, type KeyValueItem } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { decimalText, minutesText, moneyText, rangeWords } from '../../model'
import type { TechPackBomLine, TechPackPicture, TechPackView } from '../api'
import { coverageWords, NS, scopeWords, sizesText } from '../model'

/**
 * The composed sections of the live tech pack, read-only (design style.tp.outline; B-W2b-230's view by section). What the
 * audience never gets is absent from the answer and so absent here: a column shows only when its field came (a cost only on
 * the internal preview for the cost grain). Codes are said in our words; the copy's own texts (names, notes, care, settings,
 * checkpoints) come in the copy's language as typed. The design's editable "Construction details" grid and "Protection and
 * performance" form have no table yet (B-W2b-230's schema need): both are drawn from what the revision already holds.
 */

const DASH = '—'
const KNOWN = {
  bomSection: ['SHELL', 'LINING', 'INSULATION', 'PROTECTION', 'TRIMS', 'THREAD', 'LABELS', 'PACKAGING', 'OTHER'],
  lifecycle: ['CONCEPT', 'DEVELOPMENT', 'SAMPLING', 'APPROVED', 'IN_PRODUCTION', 'PHASE_OUT', 'DISCONTINUED'],
  gender: ['MEN', 'WOMEN', 'UNISEX'],
  pictureKind: ['SKETCH', 'PHOTO', 'PAGE'],
  patternKind: ['PATTERN', 'MARKER', 'CAD', 'OTHER'],
  labelKind: ['PPE_GARMENT', 'GLOVE_MARKING', 'FIBRE_CARE', 'PACKAGING'],
  testKind: ['SEAM_STRENGTH', 'POCKET_RETENTION', 'LABEL_DURABILITY', 'ABRASION', 'TEAR_STRENGTH', 'IMPACT', 'DIMENSIONS', 'COLOUR_FASTNESS', 'OTHER'],
  testResult: ['PASS', 'FAIL'],
  frequency: ['EVERY_BATCH', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ON_CHANGE', 'ONCE'],
  specStatus: ['DRAFT', 'APPROVED', 'ARCHIVED'],
  revisionStatus: ['DRAFT', 'RELEASED', 'OBSOLETE'],
  docState: ['CURRENT', 'OLDER_REVISION', 'MISSING'],
  docKind: ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'],
  colourwayStatus: ['ACTIVE', 'ARCHIVED'],
  approval: ['PENDING', 'APPROVED', 'CONDITIONAL', 'BLOCKED'],
} as const satisfies Record<string, readonly string[]>
export const CODE_GROUPS = KNOWN

const PRODUCT_WORDS = {
  kind: ['LEATHER', 'TEXTILE', 'LINING', 'MEMBRANE', 'PADDING', 'THREAD', 'TRIM', 'HARDWARE', 'PROTECTOR', 'LABEL', 'PACKAGING', 'COMPONENT'],
  uom: ['PCS', 'PAIR', 'SET', 'M', 'CM', 'MM', 'M2', 'DM2', 'FT2', 'KG', 'G', 'L', 'HIDE', 'SIDE'],
  department: ['CUTTING', 'SEWING', 'ASSEMBLY', 'FINISHING', 'INSPECTION', 'PACKING', 'SUBCONTRACT'],
  productType: ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'],
  certStatus: ['DRAFT', 'VALID', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED'],
  labelStatus: ['DRAFT', 'ACTIVE', 'RETIRED'],
} as const satisfies Record<string, readonly string[]>
const POCKETS = ['SHOULDER', 'ELBOW', 'BACK', 'CHEST', 'HIP', 'KNEE'] as const
const PPE = ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III'] as const

/** A code in our words when we know it, else the code itself (data the API may add later). */
function useWords() {
  const t = useT(NS)
  const tp = useT('products')
  const tpp = useT('products-prepacks')
  return {
    t,
    code: (group: keyof typeof KNOWN, code: string | null | undefined): string => (code ? ((KNOWN[group] as readonly string[]).includes(code) ? t(`techpack.${group}.${code}`) : code) : DASH),
    product: (group: keyof typeof PRODUCT_WORDS, code: string | null | undefined): string => (code ? ((PRODUCT_WORDS[group] as readonly string[]).includes(code) ? tp(`${group}.${code}`) : code) : DASH),
    pocket: (code: string): string => ((POCKETS as readonly string[]).includes(code) ? tpp(`protectors.pocket.${code}`) : code),
    ppe: (code: string): string => ((PPE as readonly string[]).includes(code) ? tp(`ppe.short.${code}`) : code),
  }
}

const day = (value: string | null | undefined, locale: 'it' | 'en'): string => (value ? formatDate(value.length === 10 ? `${value}T12:00:00Z` : value, { locale }) : DASH)
const both = (...parts: Array<string | null | undefined | false>): string => parts.filter((part): part is string => !!part).join(' · ') || DASH

function Sub({ children }: { children: ReactNode }) {
  return <span className="nds-summary-sub">{children}</span>
}

function Cell({ main, sub }: { main: ReactNode; sub?: ReactNode }) {
  return (
    <span className="fw-tp-cell">
      <span>{main}</span>
      {sub ? <Sub>{sub}</Sub> : null}
    </span>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="fw-tp-hint">{text}</p>
}

/** "1 PCS" (the API's quantity and unit code) as people read it: "1 pz". */
function outputText(output: string, locale: 'it' | 'en', w: ReturnType<typeof useWords>): string {
  const [qty, unit] = output.split(' ')
  return qty && unit ? `${decimalText(qty, locale)} ${w.product('uom', unit)}` : output
}

// ---- cover ---------------------------------------------------------------------------------------------------------------------

export function CoverSection({ view }: { view: TechPackView }) {
  const w = useWords()
  const locale = useLocale()
  const { style, revision } = view
  const items: KeyValueItem[] = [
    { label: w.t('techpack.cover.style'), value: both(style.code, style.name) },
    { label: w.t('techpack.cover.type'), value: style.productTypeName ?? w.product('productType', style.productType) },
    { label: w.t('techpack.cover.season'), value: style.season ?? DASH },
    {
      label: w.t('techpack.cover.brand'),
      value: style.brand ? (
        <span className="fw-tp-inline">
          {both(style.brand.code, style.brand.name)} {style.privateLabel && <Tag tone="info">{w.t('techpack.cover.privateLabel')}</Tag>}
        </span>
      ) : (
        w.t('techpack.cover.ownCollection')
      ),
    },
    { label: w.t('techpack.cover.sizes'), value: style.sizes.length > 0 ? w.t('techpack.cover.sizesValue', { range: rangeWords(style.sizes.map((size) => size.code)), base: style.baseSize ?? DASH }) : DASH },
    { label: w.t('techpack.cover.lifecycle'), value: w.code('lifecycle', style.lifecycle) },
    { label: w.t('techpack.cover.gender'), value: w.code('gender', style.gender) },
    { label: w.t('techpack.cover.customs'), value: both(style.hsCode, style.originCountry) },
    { label: w.t('techpack.cover.revision'), value: w.t('techpack.cover.revisionValue', { revision: revision.revision, status: w.code('revisionStatus', revision.status) }) },
    { label: w.t('techpack.cover.released'), value: revision.releasedAt ? day(revision.releasedAt, locale) : w.t('techpack.cover.notReleased') },
    { label: w.t('techpack.cover.effective'), value: day(revision.effectiveFrom, locale) },
    { label: w.t('techpack.cover.scope'), value: (() => { const s = scopeWords(revision, style.sizes.map((size) => size.code)); return w.t(s.key, s.params) })() },
    { label: w.t('techpack.cover.completeness'), value: revision.completenessPct !== null ? `${decimalText(revision.completenessPct, locale, 0)} %` : DASH },
    { label: w.t('techpack.cover.output'), value: outputText(revision.output, locale, w) },
  ]
  if (revision.changeNote !== undefined) items.push({ label: w.t('techpack.cover.changeNote'), value: revision.changeNote ?? DASH })
  return (
    <div className="fw-tp-stack">
      {style.shortDescription && <p className="fw-tp-text">{style.shortDescription}</p>}
      <KeyValue items={items} columns={3} phoneColumns={1} labelCase="sentence" />
    </div>
  )
}

// ---- pictures --------------------------------------------------------------------------------------------------------------------

export function PicturesTable({ pictures, label }: { pictures: readonly TechPackPicture[]; label: string }) {
  const w = useWords()
  if (pictures.length === 0) return <Empty text={w.t('techpack.pictures.none')} />
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={[w.t('techpack.pictures.col.picture'), w.t('techpack.pictures.col.colourway'), w.t('techpack.pictures.col.callouts')]}
      widths={['34%', '18%', undefined]}
      align={['left', 'left', 'left']}
      rows={pictures.map((picture) => ({
        id: picture.id,
        cells: [
          <Cell
            key="p"
            main={
              <span className="fw-tp-inline">
                {picture.caption ?? w.code('pictureKind', picture.kind)}
                {picture.isMain && <Tag tone="info">{w.t('techpack.pictures.main')}</Tag>}
              </span>
            }
            sub={both(w.code('pictureKind', picture.kind), picture.ofRevision ? w.t('techpack.pictures.ofRevision') : w.t('techpack.pictures.ofStyle'))}
          />,
          picture.colourway ? both(picture.colourway.code, picture.colourway.name) : w.t('techpack.pictures.everyColourway'),
          picture.callouts.length === 0 ? (
            DASH
          ) : (
            <ol key="c" className="fw-tp-callouts">
              {picture.callouts.map((callout) => (
                <li key={callout.n} value={callout.n}>
                  {callout.text}
                </li>
              ))}
            </ol>
          ),
        ],
      }))}
    />
  )
}

// ---- BOM -------------------------------------------------------------------------------------------------------------------------

function quantityOf(line: TechPackBomLine, locale: 'it' | 'en', w: ReturnType<typeof useWords>): ReactNode {
  const unit = w.product('uom', line.uom)
  const main = line.sizeDependent ? w.t('techpack.bom.bySize', { qty: decimalText(line.qty, locale), unit }) : `${decimalText(line.qty, locale)} ${unit}`
  const sizes = line.sizeDependent ? line.bySize.map((entry) => `${entry.size}: ${entry.qty === null ? w.t('techpack.bom.missing') : decimalText(entry.qty, locale)}`).join(' · ') : null
  return <Cell main={main} sub={both(Number(line.wastagePct) > 0 ? w.t('techpack.bom.wastage', { pct: decimalText(line.wastagePct, locale, 2) }) : null, sizes)} />
}

function colourOf(line: TechPackBomLine, w: ReturnType<typeof useWords>): ReactNode {
  if (line.colourDependent) return <Cell main={w.t('techpack.bom.byColourway')} sub={line.colours.map((entry) => `${entry.colourway}: ${entry.colour ? entry.colour.code : DASH}`).join(' · ')} />
  return line.colour ? both(line.colour.code, line.colour.name) : DASH
}

function detailsOf(line: TechPackBomLine, w: ReturnType<typeof useWords>): ReactNode {
  const tags: ReactNode[] = []
  if (line.kit) tags.push(<Tag key="kit" tone="info">{w.t('techpack.bom.kit')}</Tag>)
  if (line.customerSupplied) tags.push(<Tag key="cs" tone="neutral">{line.customerParty ? w.t('techpack.bom.customerSuppliedBy', { party: line.customerParty.code }) : w.t('techpack.bom.customerSupplied')}</Tag>)
  if (line.colourwayOnly) tags.push(<Tag key="only" tone="neutral">{w.t('techpack.bom.onlyIn', { colourway: line.colourwayOnly.code })}</Tag>)
  const words = [
    line.option ? w.t('techpack.bom.option', { option: line.option }) : null,
    line.routingStep ? w.t('techpack.bom.step', { seq: line.routingStep.seq, code: line.routingStep.code }) : null,
    line.subAssembly ? w.t('techpack.bom.subAssembly', { code: line.subAssembly.styleCode, revision: line.subAssembly.revision }) : null,
    line.supplierParty ? w.t('techpack.bom.supplier', { party: both(line.supplierParty.code, line.supplierParty.name) }) : null,
    line.alternateMaterials && line.alternateMaterials.length > 0 ? w.t('techpack.bom.alternates', { list: line.alternateMaterials.map((entry) => entry.material.code).join(', ') }) : null,
    line.material.approval ? w.t('techpack.bom.approval', { state: w.code('approval', line.material.approval) }) : null,
    line.note ?? null,
  ].filter((entry): entry is string => !!entry)
  if (tags.length === 0 && words.length === 0) return DASH
  return (
    <span className="fw-tp-cell">
      {tags.length > 0 && <span className="fw-tp-tags">{tags}</span>}
      {words.length > 0 && <Sub>{words.join(' · ')}</Sub>}
    </span>
  )
}

export function BomLinesTable({ lines, label }: { lines: readonly TechPackBomLine[]; label: string }) {
  const w = useWords()
  const locale = useLocale()
  if (lines.length === 0) return <Empty text={w.t('techpack.bom.noLines')} />
  // A cost column only when the API sent one (the internal preview, the cost grain).
  const costs = lines.some((line) => line.unitCost !== undefined || line.lineCost !== undefined)
  const columns = [w.t('techpack.bom.col.seq'), w.t('techpack.bom.col.material'), w.t('techpack.bom.col.placement'), w.t('techpack.bom.col.quantity'), w.t('techpack.bom.col.colour'), w.t('techpack.bom.col.details'), ...(costs ? [w.t('techpack.bom.col.cost')] : [])]
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={columns}
      widths={['6%', '22%', '13%', '17%', '14%', undefined, ...(costs ? ['12%'] : [])]}
      align={['left', 'left', 'left', 'left', 'left', 'left', ...(costs ? (['right'] as const) : [])]}
      rows={lines.map((line) => ({
        id: line.id,
        cells: [
          String(line.seq),
          <Cell key="m" main={both(line.material.code, line.material.name)} sub={w.product('kind', line.material.kind)} />,
          line.placement ?? DASH,
          quantityOf(line, locale, w),
          colourOf(line, w),
          detailsOf(line, w),
          ...(costs ? [<Cell key="c" main={moneyText(line.lineCost, 'EUR', locale)} sub={line.unitCost ? w.t('techpack.bom.unitCost', { cost: moneyText(line.unitCost, 'EUR', locale) }) : null} />] : []),
        ],
      }))}
    />
  )
}

export function BomSection({ bom }: { bom: NonNullable<TechPackView['bom']> }) {
  const w = useWords()
  if (bom.sections.length === 0) return <Empty text={w.t('techpack.bom.noLines')} />
  return (
    <div className="fw-tp-stack">
      {bom.sections.map((group) => (
        <section key={group.section} className="fw-tp-group" aria-label={w.code('bomSection', group.section)}>
          <h4 className="fw-tp-h4">
            {w.code('bomSection', group.section)} <span className="fw-tp-hint">· {w.t('techpack.bom.lines', { count: group.lines.length })}</span>
          </h4>
          <BomLinesTable lines={group.lines} label={w.code('bomSection', group.section)} />
        </section>
      ))}
    </div>
  )
}

// ---- colourways -------------------------------------------------------------------------------------------------------------------

export function ColourwaysSection({ colourways }: { colourways: NonNullable<TechPackView['colourways']> }) {
  const w = useWords()
  if (colourways.length === 0) return <Empty text={w.t('techpack.colourways.none')} />
  return (
    <SummaryTable
      label={w.t('techpack.section.COLOURWAYS')}
      stackOnPhone
      columns={[w.t('techpack.colourways.col.colourway'), w.t('techpack.colourways.col.colour'), w.t('techpack.colourways.col.materials')]}
      widths={['26%', '26%', undefined]}
      align={['left', 'left', 'left']}
      rows={colourways.map((colourway) => ({
        id: colourway.id,
        cells: [
          <Cell key="c" main={both(colourway.code, colourway.name)} sub={both(w.code('colourwayStatus', colourway.status), colourway.description)} />,
          colourway.colour ? <Cell key="k" main={both(colourway.colour.code, colourway.colour.name)} sub={both(colourway.colour.system, colourway.colour.reference)} /> : DASH,
          colourway.colours.length === 0
            ? DASH
            : colourway.colours.map((entry) => `${entry.seq} ${entry.material.code}: ${entry.used ? (entry.colour ? entry.colour.code : DASH) : w.t('techpack.colourways.notUsed')}`).join(' · '),
        ],
      }))}
    />
  )
}

// ---- size spec -------------------------------------------------------------------------------------------------------------------

export function SizeSpecSection({ spec, locale }: { spec: NonNullable<TechPackView['sizeSpec']>; locale: 'it' | 'en' }) {
  const w = useWords()
  const value = (entry: NonNullable<TechPackView['sizeSpec']>['points'][number]['values'][number]) => {
    if (!entry) return <span className="fw-tp-missing">{w.t('techpack.spec.missing')}</span>
    const nominal = decimalText(entry.nominal, locale)
    const tolerance = entry.minus === entry.plus ? `±${decimalText(entry.plus, locale)}` : `−${decimalText(entry.minus, locale)} / +${decimalText(entry.plus, locale)}`
    return <Cell main={nominal} sub={tolerance} />
  }
  return (
    <div className="fw-tp-stack">
      <KeyValue
        columns={3}
        phoneColumns={1}
        labelCase="sentence"
        items={[
          { label: w.t('techpack.spec.state'), value: w.code('specStatus', spec.status) },
          { label: w.t('techpack.spec.base'), value: spec.baseSize },
          { label: w.t('techpack.spec.grade'), value: spec.gradeRule ?? DASH },
          { label: w.t('techpack.spec.missingCount'), value: spec.missing === 0 ? w.t('techpack.spec.noneMissing') : w.t('techpack.spec.missingValues', { count: spec.missing }) },
        ]}
      />
      {spec.points.length === 0 ? (
        <Empty text={w.t('techpack.spec.noPoints')} />
      ) : (
        <div className="fw-tp-scroll">
          <SummaryTable
            label={w.t('techpack.section.SIZE_SPEC')}
            columns={[w.t('techpack.spec.col.point'), ...spec.sizes.map((size) => (size === spec.baseSize ? w.t('techpack.spec.baseMark', { size }) : size))]}
            widths={['22%', ...spec.sizes.map(() => undefined)]}
            align={['left', ...spec.sizes.map(() => 'right' as const)]}
            rows={spec.points.map((point) => ({
              id: point.code,
              cells: [<Cell key="p" main={both(point.code, point.name)} sub={both(point.unit, point.howTo)} />, ...spec.sizes.map((size, index) => <span key={size}>{value(point.values[index] ?? null)}</span>)],
            }))}
          />
        </div>
      )}
    </div>
  )
}

// ---- construction ----------------------------------------------------------------------------------------------------------------

export function ConstructionSection({ construction, locale }: { construction: NonNullable<TechPackView['construction']>; locale: 'it' | 'en' }) {
  const w = useWords()
  const minutes = construction.steps.some((step) => step.standardMinutes !== undefined)
  const workshops = construction.steps.some((step) => step.workshopParty !== undefined)
  return (
    <div className="fw-tp-stack">
      <p className="fw-tp-hint">{w.t('techpack.construction.composed')}</p>
      {construction.steps.length === 0 ? (
        <Empty text={w.t('techpack.construction.noSteps')} />
      ) : (
        <SummaryTable
          label={w.t('techpack.construction.steps')}
          stackOnPhone
          columns={[w.t('techpack.construction.col.seq'), w.t('techpack.construction.col.operation'), w.t('techpack.construction.col.settings'), w.t('techpack.construction.col.checkpoint'), w.t('techpack.construction.col.instruction'), ...(minutes ? [w.t('techpack.construction.col.minutes')] : [])]}
          widths={['6%', '24%', '26%', '16%', undefined, ...(minutes ? ['9%'] : [])]}
          align={['left', 'left', 'left', 'left', 'left', ...(minutes ? (['right'] as const) : [])]}
          rows={construction.steps.map((step) => ({
            id: `${step.seq}:${step.code}`,
            cells: [
              String(step.seq),
              <Cell
                key="o"
                main={both(step.code, step.name)}
                sub={both(
                  w.product('department', step.workCentre),
                  step.forCells ?? w.t('techpack.construction.everyCell'),
                  step.subcontracted ? (workshops && step.workshopParty ? w.t('techpack.construction.subcontractedTo', { party: step.workshopParty.code }) : w.t('techpack.construction.subcontracted')) : null,
                  step.instructions,
                )}
              />,
              step.settings.length === 0 ? DASH : <Cell key="s" main={step.settings[0]!.line} sub={step.settings.slice(1).map((setting) => setting.line).join(' · ') || null} />,
              step.checkpoint ?? DASH,
              step.instruction ? (
                <Cell
                  key="i"
                  main={w.t('techpack.construction.instruction', { number: step.instruction.number, version: step.instruction.version })}
                  sub={both(
                    w.t('techpack.construction.instructionSteps', { count: step.instruction.steps.length }),
                    step.instruction.steps.some((entry) => entry.critical) ? w.t('techpack.construction.critical', { count: step.instruction.steps.filter((entry) => entry.critical).length }) : null,
                    step.instruction.steps.some((entry) => entry.safety) ? w.t('techpack.construction.safety') : null,
                  )}
                />
              ) : (
                w.t('techpack.construction.noInstruction')
              ),
              ...(minutes ? [step.standardMinutes !== undefined ? w.t('techpack.construction.minutes', { minutes: minutesText(step.standardMinutes, locale) }) : DASH] : []),
            ],
          }))}
        />
      )}
      <h4 className="fw-tp-h4">{w.t('techpack.construction.pages')}</h4>
      <PicturesTable pictures={construction.pages} label={w.t('techpack.construction.pages')} />
      <h4 className="fw-tp-h4">{w.t('techpack.construction.patterns')}</h4>
      {construction.patterns.length === 0 ? (
        <Empty text={w.t('techpack.construction.noPatterns')} />
      ) : (
        <SummaryTable
          label={w.t('techpack.construction.patterns')}
          stackOnPhone
          columns={[w.t('techpack.construction.col.file'), w.t('techpack.construction.col.kind'), w.t('techpack.construction.col.sizes'), w.t('techpack.construction.col.note')]}
          widths={['32%', '18%', '18%', undefined]}
          align={['left', 'left', 'left', 'left']}
          rows={construction.patterns.map((entry) => ({ id: entry.id, cells: [entry.fileName, both(w.code('patternKind', entry.kind), entry.format), entry.sizes.length === 0 ? w.t('techpack.construction.everySize') : entry.sizes.join(', '), entry.note ?? DASH] }))}
        />
      )}
    </div>
  )
}

// ---- labels and packaging --------------------------------------------------------------------------------------------------------

export function LabelsSection({ labels }: { labels: NonNullable<TechPackView['labels']> }) {
  const w = useWords()
  const template = labels.template
  return (
    <div className="fw-tp-stack">
      <h4 className="fw-tp-h4">{w.t('techpack.labels.template')}</h4>
      {template ? (
        <KeyValue
          columns={3}
          phoneColumns={1}
          labelCase="sentence"
          items={[
            { label: w.t('techpack.labels.label'), value: <Cell main={both(`${template.code} r${template.revision}`, template.name)} sub={both(w.code('labelKind', template.kind), w.product('labelStatus', template.status))} /> },
            { label: w.t('techpack.labels.languages'), value: template.languages.join(', ').toUpperCase() || DASH },
            { label: w.t('techpack.labels.size'), value: template.size },
            { label: w.t('techpack.labels.maker'), value: template.maker },
            { label: w.t('techpack.labels.composition'), value: template.composition.length === 0 ? DASH : template.composition.map((part) => `${part.part}: ${part.fibres.map((fibre) => `${fibre.percent}% ${fibre.fibre}`).join(', ')}`).join(' · ') },
            { label: w.t('techpack.labels.care'), value: template.care.length === 0 ? DASH : template.care.map((care) => care.text || care.symbol).join(' · ') },
            { label: w.t('techpack.labels.animalOrigin'), value: template.animalOriginPhrase ? w.t('techpack.labels.yes') : w.t('techpack.labels.no') },
            { label: w.t('techpack.labels.qr'), value: template.qrTarget },
          ]}
        />
      ) : (
        <Empty text={w.t('techpack.labels.noTemplate')} />
      )}
      <h4 className="fw-tp-h4">{w.t('techpack.labels.lines')}</h4>
      <BomLinesTable lines={labels.lines} label={w.t('techpack.labels.lines')} />
      <h4 className="fw-tp-h4">{w.t('techpack.labels.branding')}</h4>
      {labels.branding ? (
        <div className="fw-tp-stack">
          <KeyValue
            columns={3}
            phoneColumns={1}
            labelCase="sentence"
            items={[
              { label: w.t('techpack.labels.brandingSet'), value: both(labels.branding.code, labels.branding.name) },
              { label: w.t('techpack.labels.brand'), value: both(labels.branding.brand.code, labels.branding.brand.name) },
              { label: w.t('techpack.labels.artwork'), value: w.t('techpack.labels.artworkCount', { logos: labels.branding.logoFileIds.length, artwork: labels.branding.artworkFileIds.length }) },
            ]}
          />
          {labels.branding.rules.length > 0 && (
            <SummaryTable
              label={w.t('techpack.labels.rules')}
              stackOnPhone
              columns={[w.t('techpack.labels.col.rule'), w.t('techpack.labels.col.material'), w.t('techpack.labels.col.quantity')]}
              widths={['50%', '25%', undefined]}
              align={['left', 'left', 'left']}
              rows={labels.branding.rules.map((rule, index) => ({ id: `${rule.key}:${index}`, cells: [rule.text || rule.key, rule.material ? both(rule.material.code, rule.material.name) : DASH, both(rule.quantity, rule.per)] }))}
            />
          )}
        </div>
      ) : (
        <Empty text={w.t('techpack.labels.noBranding')} />
      )}
    </div>
  )
}

// ---- protection and performance ----------------------------------------------------------------------------------------------------

export function ProtectionSection({ protection, range, locale }: { protection: NonNullable<TechPackView['protection']>; range: readonly string[]; locale: 'it' | 'en' }) {
  const w = useWords()
  const people = protection.tests.some((test) => test.testedBy !== undefined)
  const coverage = coverageWords(protection.coverage)
  return (
    <div className="fw-tp-stack">
      <p className="fw-tp-hint">{w.t('techpack.protection.composed')}</p>
      <KeyValue
        columns={2}
        phoneColumns={1}
        labelCase="sentence"
        items={[
          { label: w.t('techpack.protection.class'), value: both(w.ppe(protection.classification.category), protection.classification.standard, protection.classification.ppeClass) },
          { label: w.t('techpack.protection.coverage'), value: w.t(coverage.key, coverage.params) },
        ]}
      />
      <h4 className="fw-tp-h4">{w.t('techpack.protection.zones')}</h4>
      {protection.placements.length === 0 ? (
        <Empty text={w.t('techpack.protection.noPlacements')} />
      ) : (
        <SummaryTable
          label={w.t('techpack.protection.zones')}
          stackOnPhone
          columns={[w.t('techpack.protection.col.pocket'), w.t('techpack.protection.col.protector'), w.t('techpack.protection.col.level'), w.t('techpack.protection.col.sizes'), w.t('techpack.protection.col.position')]}
          widths={['14%', '28%', '20%', '14%', undefined]}
          align={['left', 'left', 'left', 'left', 'left']}
          rows={protection.placements.map((entry) => ({
            id: String(entry.seq),
            cells: [`${entry.seq}. ${w.pocket(entry.pocket)}`, both(entry.protector.code, entry.protector.name), w.t('techpack.protection.levelValue', { standard: entry.standard, level: entry.level }), entry.sizes.length === 0 ? w.t('techpack.protection.allSizes') : sizesText(entry.sizes, range), entry.positionNote ?? DASH],
          }))}
        />
      )}
      <h4 className="fw-tp-h4">{w.t('techpack.protection.protectors')}</h4>
      <BomLinesTable lines={protection.protectors} label={w.t('techpack.protection.protectors')} />
      <h4 className="fw-tp-h4">{w.t('techpack.protection.certificates')}</h4>
      {protection.certificates.length === 0 ? (
        <Empty text={w.t('techpack.protection.noCertificates')} />
      ) : (
        <SummaryTable
          label={w.t('techpack.protection.certificates')}
          stackOnPhone
          columns={[w.t('techpack.protection.col.certificate'), w.t('techpack.protection.col.body'), w.t('techpack.protection.col.valid'), w.t('techpack.protection.col.covers'), w.t('techpack.protection.col.levels')]}
          widths={['22%', '22%', '18%', '18%', undefined]}
          align={['left', 'left', 'left', 'left', 'left']}
          rows={protection.certificates.map((entry) => ({
            id: entry.number,
            cells: [
              <Cell key="n" main={entry.number} sub={both(entry.standard, entry.ppeClass, w.product('certStatus', entry.status))} />,
              both(entry.notifiedBody, entry.notifiedBodyNumber),
              w.t('techpack.protection.validRange', { from: day(entry.validFrom, locale), to: day(entry.validTo, locale) }),
              both(entry.colourways.length === 0 ? w.t('techpack.protection.everyColourway') : entry.colourways.join(', '), entry.sizes.length === 0 ? w.t('techpack.protection.allSizes') : sizesText(entry.sizes, range)),
              Object.keys(entry.performanceLevels).length === 0 ? DASH : Object.entries(entry.performanceLevels).map(([zone, level]) => `${zone}: ${level}`).join(' · '),
            ],
          }))}
        />
      )}
      <h4 className="fw-tp-h4">{w.t('techpack.protection.tests')}</h4>
      {protection.tests.length === 0 ? (
        <Empty text={w.t('techpack.protection.noTests')} />
      ) : (
        <SummaryTable
          label={w.t('techpack.protection.tests')}
          stackOnPhone
          columns={[w.t('techpack.protection.col.test'), w.t('techpack.protection.col.due'), w.t('techpack.protection.col.result'), w.t('techpack.protection.col.report'), ...(people ? [w.t('techpack.protection.col.by')] : [])]}
          widths={['30%', '18%', '18%', undefined, ...(people ? ['14%'] : [])]}
          align={['left', 'left', 'left', 'left', ...(people ? (['left'] as const) : [])]}
          rows={protection.tests.map((test, index) => ({
            id: `${test.test}:${test.dueOn}:${index}`,
            cells: [
              <Cell key="t" main={test.name ?? w.code('testKind', test.test)} sub={both(test.name ? w.code('testKind', test.test) : null, test.standardClause, w.code('frequency', test.frequency))} />,
              day(test.dueOn, locale),
              test.result ? (
                <Cell key="r" main={<Tag tone={test.result === 'PASS' ? 'success' : 'danger'}>{w.code('testResult', test.result)}</Tag>} sub={test.testedOn ? day(test.testedOn, locale) : null} />
              ) : (
                w.t('techpack.protection.notTested')
              ),
              both(test.reportNumber, test.hasReport ? w.t('techpack.protection.reportOnFile') : null, test.resultNote),
              ...(people ? [test.testedBy ?? DASH] : []),
            ],
          }))}
        />
      )}
    </div>
  )
}

// ---- compliance and the revision log ---------------------------------------------------------------------------------------------------

export function ComplianceSection({ compliance, view }: { compliance: NonNullable<TechPackView['compliance']>; view: TechPackView }) {
  const w = useWords()
  const scope = scopeWords(view.revision, view.style.sizes.map((size) => size.code))
  return (
    <div className="fw-tp-stack">
      <KeyValue
        columns={3}
        phoneColumns={1}
        labelCase="sentence"
        items={[
          { label: w.t('techpack.compliance.class'), value: both(w.ppe(compliance.classification.category), compliance.classification.standard, compliance.classification.ppeClass) },
          { label: w.t('techpack.compliance.scope'), value: w.t(scope.key, scope.params) },
          { label: w.t('techpack.compliance.blockers'), value: compliance.blockers.length === 0 ? w.t('techpack.compliance.noBlockers') : w.t('techpack.compliance.blockersCount', { count: compliance.blockers.length }) },
        ]}
      />
      {!compliance.documentsRequired ? (
        <Empty text={w.t('techpack.compliance.noDocuments')} />
      ) : compliance.documents.length === 0 ? (
        <Empty text={w.t('techpack.compliance.documentsNone')} />
      ) : (
        <SummaryTable
          label={w.t('techpack.compliance.documents')}
          stackOnPhone
          columns={[w.t('techpack.compliance.col.document'), w.t('techpack.compliance.col.language'), w.t('techpack.compliance.col.state')]}
          widths={['50%', '20%', undefined]}
          align={['left', 'left', 'left']}
          rows={compliance.documents.map((entry) => ({
            id: `${entry.kind}:${entry.language}`,
            cells: [w.code('docKind', entry.kind), entry.language.toUpperCase(), <Tag key="s" tone={entry.state === 'CURRENT' ? 'success' : entry.state === 'MISSING' ? 'danger' : 'warning'}>{w.code('docState', entry.state)}</Tag>],
          }))}
        />
      )}
    </div>
  )
}

export function RevisionLogSection({ log, locale }: { log: NonNullable<TechPackView['revisionLog']>; locale: 'it' | 'en' }) {
  const w = useWords()
  const notes = log.some((entry) => entry.changeNote !== undefined)
  const people = log.some((entry) => entry.releasedBy !== undefined)
  return (
    <SummaryTable
      label={w.t('techpack.section.REVISION_LOG')}
      stackOnPhone
      columns={[w.t('techpack.log.col.revision'), w.t('techpack.log.col.released'), w.t('techpack.log.col.effective'), ...(notes ? [w.t('techpack.log.col.note')] : []), ...(people ? [w.t('techpack.log.col.by')] : [])]}
      widths={['18%', '16%', '20%', ...(notes ? [undefined] : []), ...(people ? ['16%'] : [])]}
      align={['left', 'left', 'left', ...(notes ? (['left'] as const) : []), ...(people ? (['left'] as const) : [])]}
      rows={log.map((entry) => ({
        id: String(entry.revision),
        cells: [
          w.t('techpack.cover.revisionValue', { revision: entry.revision, status: w.code('revisionStatus', entry.status) }),
          entry.releasedAt ? day(entry.releasedAt, locale) : DASH,
          entry.effectiveFrom ? w.t('techpack.log.effective', { from: day(entry.effectiveFrom, locale), to: entry.effectiveTo ? day(entry.effectiveTo, locale) : w.t('techpack.log.open') }) : DASH,
          ...(notes ? [entry.changeNote ?? DASH] : []),
          ...(people ? [entry.releasedBy ?? DASH] : []),
        ],
      }))}
    />
  )
}
