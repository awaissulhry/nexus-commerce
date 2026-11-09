'use client'

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Wand2 } from 'lucide-react'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { Banner, Card, Field } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { Button, Select } from '@nexus/ui/primitives'
import { NexusGrid, SHEET_GRID_OPTIONS, type ColDef, type ColGroupDef } from '@nexus/ui/grid'
import { VersionCompare, type VersionLine, type VersionTotal } from '@nexus/ui/patterns/VersionCompare/index'
import { RuleBuilder, rulePreview, type RuleDraft, type RuleField } from '@nexus/ui/patterns/RuleBuilder/index'
import { sizeColumnGroup, SizeFill, sizeValueText, type SizeFillChange, type SizeValue } from '@nexus/ui/grid/size-columns/index'
import { GarmentZoneMap, type GarmentZoneMark } from '@nexus/ui/components/GarmentZoneMap/index'
import { WithMessages } from '../../../../record-panels/i18n'
import { Modal, Textarea } from '../../../i18n/ds-parts'
import { useDsLabels } from '../../../i18n/ds-labels'
import { INTL_LOCALE, type Locale } from '../../../i18n/locales'
import { useLocale, useT } from '../../../i18n/provider'
import './ds-product-lab.css'

/**
 * The product parts lab (`/design/ds-product-parts`, B-W2b-207): VersionCompare (a BOM's Rev 3 against Rev 4, "Use as
 * change note" into the change's note), RuleBuilder (a quote approval rule and an option rule), SizeColumns (a measurement
 * spec in the DS grid, typed, pasted and filled from the base size) and GarmentZoneMap (pick a zone, a heat map, a risk
 * assessment) — each with the `ds-words` catalogue as its `labels`, in the gallery's language. In the browser the parts
 * work. Made-up data only.
 */
export interface DsProductLabModel {
  /** One part alone, or every part. */
  show?: 'all' | 'compare' | 'rules' | 'sizes' | 'zones'
  /** The comparison: changes (default), the same versions, a decided change (note held, unchanged lines shown). */
  compare?: 'changes' | 'same' | 'decided'
  /** The rule: approval (default), a row not finished, offline, read only, an option rule. */
  rule?: 'approval' | 'incomplete' | 'offline' | 'readonly' | 'options'
  /** The spec: complete with one value typed by hand (default), values missing, a released revision (read only). */
  sizes?: 'spec' | 'missing' | 'released'
  /** The zone map: every use (default), held with its reason, a heat map alone. */
  zones?: 'all' | 'held' | 'heat'
}

export function DsProductLab({ model }: { model: DsProductLabModel }) {
  return (
    <WithMessages namespaces={['ds-words', 'ds-product-lab']}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Section({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <Card padded header={title} className="fw-dpl-card">
      <p className="fw-dpl-note">{note}</p>
      {children}
    </Card>
  )
}

function Lab({ model }: { model: DsProductLabModel }) {
  const t = useT('ds-product-lab')
  const show = model.show ?? 'all'
  const on = (part: NonNullable<DsProductLabModel['show']>) => show === 'all' || show === part
  return (
    <main id="main-content" className="fw-dpl">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {on('compare') ? (
        <Section title={t('section.compare')} note={t('section.compareNote')}>
          <CompareParts mode={model.compare ?? 'changes'} />
        </Section>
      ) : null}
      {on('rules') ? (
        <Section title={t('section.rules')} note={t('section.rulesNote')}>
          <RuleParts mode={model.rule ?? 'approval'} />
        </Section>
      ) : null}
      {on('sizes') ? (
        <Section title={t('section.sizes')} note={t('section.sizesNote')}>
          <SizeParts mode={model.sizes ?? 'spec'} />
        </Section>
      ) : null}
      {on('zones') ? (
        <Section title={t('section.zones')} note={t('section.zonesNote')}>
          <ZoneParts mode={model.zones ?? 'all'} />
        </Section>
      ) : null}
    </main>
  )
}

/* ── VersionCompare ─────────────────────────────────────────────────────────────────────────────────────────────── */

function useNumbers() {
  const locale = useLocale() as Locale
  return useMemo(() => {
    const intl = INTL_LOCALE[locale]
    const decimal = new Intl.NumberFormat(intl, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    const money = new Intl.NumberFormat(intl, { style: 'currency', currency: 'EUR' })
    return { intl, area: (n: number) => `${decimal.format(n)} m²`, pieces: (n: number) => `${n} pz`, money: (n: number) => money.format(n) }
  }, [locale])
}

function CompareParts({ mode }: { mode: 'changes' | 'same' | 'decided' }) {
  const t = useT('ds-product-lab')
  const ds = useDsLabels()
  const n = useNumbers()
  const [note, setNote] = useState('')
  const fields = useMemo(
    () => [
      { id: 'qty', label: t('compare.qty') },
      { id: 'supplier', label: t('compare.supplier') },
      { id: 'placement', label: t('compare.placement') },
    ],
    [t],
  )
  const lines = useMemo<VersionLine[]>(() => {
    const leather = (m: string, l: string, qty: number) => ({ fields: { qty: n.area(qty), supplier: t('compare.tannery'), placement: t('compare.body') }, sizes: { '46': '1.05', '48': '1.1', '50': '1.2', '52': m, '54': l, '56': '1.42' } })
    const zip = { fields: { qty: n.pieces(1), placement: t('compare.body') } }
    const thread = (supplier: string) => ({ fields: { qty: n.pieces(2), supplier } })
    if (mode === 'same') {
      return [
        { id: 'l10', label: t('compare.leather'), detail: t('compare.body'), before: leather('1.26', '1.32', 1.2), after: leather('1.26', '1.32', 1.2) },
        { id: 'l20', label: t('compare.zip'), before: zip, after: zip },
      ]
    }
    return [
      { id: 'l10', label: t('compare.leather'), detail: t('compare.body'), before: leather('1.26', '1.32', 1.2), after: leather('1.3', '1.36', 1.3) },
      { id: 'l20', label: t('compare.zip'), before: zip, after: zip },
      { id: 'l30', label: t('compare.elbow'), detail: t('compare.sleeves'), before: null, after: { fields: { qty: n.pieces(2), supplier: t('compare.protect'), placement: t('compare.sleeves') } } },
      { id: 'l40', label: t('compare.care'), detail: t('compare.neck'), before: { fields: { qty: n.pieces(1), placement: t('compare.neck') } }, after: null },
      { id: 'l50', label: t('compare.thread'), before: thread(t('compare.threadsA')), after: thread(t('compare.threadsB')) },
    ]
  }, [mode, n, t])
  const totals = useMemo<VersionTotal[]>(
    () => [
      { id: 'cost', label: t('compare.cost'), before: n.money(41.2), after: mode === 'same' ? n.money(41.2) : n.money(43.1) },
      { id: 'lines', label: t('compare.lines'), before: '4', after: '4' },
    ],
    [mode, n, t],
  )
  return (
    <div className="fw-dpl-stack">
      <VersionCompare
        before={{ label: t('compare.rev3'), note: t('compare.rev3Note') }}
        after={{ label: t('compare.rev4'), note: t('compare.rev4Note') }}
        lines={lines}
        fields={fields}
        sizes={['46', '48', '50', '52', '54', '56']}
        totals={totals}
        locale={n.intl}
        onUseAsNote={setNote}
        noteHeldReason={mode === 'decided' ? t('compare.decided') : null}
        defaultShowUnchanged={mode === 'decided'}
        labels={ds.versionCompare}
      />
      <Field label={t('compare.note')}>
        <Textarea value={note} placeholder={t('compare.notePlaceholder')} rows={6} onChange={(event) => setNote(event.target.value)} />
      </Field>
    </div>
  )
}

/* ── RuleBuilder ────────────────────────────────────────────────────────────────────────────────────────────────── */

function RuleParts({ mode }: { mode: 'approval' | 'incomplete' | 'offline' | 'readonly' | 'options' }) {
  const t = useT('ds-product-lab')
  const ds = useDsLabels()
  const n = useNumbers()
  const approvalFields = useMemo<RuleField[]>(
    () => [
      { id: 'margin', label: t('rules.margin'), kind: 'number', unit: '%', min: 0, max: 100 },
      { id: 'discount', label: t('rules.discount'), kind: 'number', unit: '%', min: 0, max: 100 },
      { id: 'amount', label: t('rules.amount'), kind: 'number', unit: '€', min: 0 },
      {
        id: 'special',
        label: t('rules.special'),
        kind: 'choice',
        operators: ['in'],
        options: [
          { value: 'MTM', label: t('rules.mtm') },
          { value: 'UNRELEASED', label: t('rules.unreleased') },
          { value: 'UNDER_LIST', label: t('rules.underList') },
        ],
      },
      { id: 'cost', label: t('rules.cost'), kind: 'number', unit: '€', heldReason: t('rules.notInRole') },
    ],
    [t],
  )
  const optionFields = useMemo<RuleField[]>(
    () => [
      {
        id: 'option',
        label: t('rules.option'),
        kind: 'choice',
        options: [
          { value: 'PERF', label: t('rules.perf') },
          { value: 'LINER', label: t('rules.liner') },
          { value: 'HUMP', label: t('rules.hump') },
        ],
      },
      { id: 'mtm', label: t('rules.madeToMeasure'), kind: 'yesNo' },
    ],
    [t],
  )
  const options = mode === 'options'
  const fields = options ? optionFields : approvalFields
  const [draft, setDraft] = useState<RuleDraft>(() =>
    options
      ? { combinator: 'and', rows: [{ id: 'o1', field: 'option', operator: 'in', value: ['PERF'] }, { id: 'o2', field: 'mtm', operator: 'isFalse', value: null }] }
      : {
          combinator: 'or',
          rows:
            mode === 'incomplete'
              ? [{ id: 'a1', field: 'margin', operator: 'lt', value: '20' }, { id: 'a2', field: 'discount', operator: 'gt', value: '' }]
              : [{ id: 'a1', field: 'margin', operator: 'lt', value: '20' }, { id: 'a2', field: 'discount', operator: 'gt', value: '15' }, { id: 'a3', field: 'special', operator: 'in', value: ['MTM', 'UNRELEASED'] }],
        },
  )
  const [saved, setSaved] = useState<string | null>(null)
  const formatNumber = useCallback((value: string) => new Intl.NumberFormat(n.intl, { maximumFractionDigits: 6 }).format(Number(value)), [n.intl])
  const lead = options ? t('rules.optionsLead') : t('rules.lead')
  const outcome = options ? t('rules.optionsOutcome') : null
  return (
    <div className="fw-dpl-stack">
      <RuleBuilder
        label={options ? t('rules.optionsLabel') : t('rules.label')}
        fields={fields}
        value={draft}
        onChange={
          mode === 'readonly'
            ? undefined
            : (next) => {
                setDraft(next)
                setSaved(null)
              }
        }
        onApply={(rule) => setSaved(rulePreview(rule, fields, ds.ruleBuilder, { lead, outcome, formatNumber }))}
        applyLabel={t('rules.apply')}
        applyHeldReason={mode === 'offline' ? t('rules.offline') : null}
        readOnly={mode === 'readonly'}
        readOnlyReason={mode === 'readonly' ? t('rules.readOnly') : null}
        lead={lead}
        outcome={outcome}
        locale={n.intl}
        labels={ds.ruleBuilder}
      />
      <p className="fw-dpl-status" role="status">
        {saved ? t('rules.saved', { rule: saved }) : ''}
      </p>
    </div>
  )
}

/* ── SizeColumns ────────────────────────────────────────────────────────────────────────────────────────────────── */

const SIZES = ['46', '48', '50', '52', '54', '56']
const BASE = '50'

interface PomRow {
  id: string
  pom: string
  tolerance: string
  values: Record<string, SizeValue>
  typed: string[]
}

function startRows(mode: 'spec' | 'missing' | 'released', words: (key: string) => string): PomRow[] {
  const rows: PomRow[] = [
    { id: 'A', pom: words('sizes.chest'), tolerance: '1', values: { '46': '54', '48': '56', '50': '58', '52': '60', '54': '62', '56': '64' }, typed: [] },
    { id: 'B', pom: words('sizes.back'), tolerance: '1', values: { '46': '68', '48': '69', '50': '70', '52': '71', '54': '72', '56': '73' }, typed: [] },
    { id: 'C', pom: words('sizes.sleeve'), tolerance: '0.5', values: { '46': '61', '48': '62', '50': '63', '52': '64', '54': '65', '56': '66.5' }, typed: ['56'] },
    { id: 'D', pom: words('sizes.shoulder'), tolerance: '0.5', values: { '46': '14.6', '48': '15', '50': '15.4', '52': '15.8', '54': '16.2', '56': '16.6' }, typed: [] },
  ]
  if (mode !== 'missing') return rows
  return rows.map((row) => (row.id === 'B' ? { ...row, values: { ...row.values, '46': null, '48': null, '56': null } } : row.id === 'D' ? { ...row, values: { ...row.values, '54': null } } : row))
}

function SizeParts({ mode }: { mode: 'spec' | 'missing' | 'released' }) {
  const t = useT('ds-product-lab')
  const ds = useDsLabels()
  const n = useNumbers()
  const [rows, setRows] = useState<PomRow[]>(() => startRows(mode, t))
  const [status, setStatus] = useState('')
  const [fillRow, setFillRow] = useState('B')
  const [filling, setFilling] = useState(false)
  const released = mode === 'released'
  const held = released ? t('sizes.released') : null
  const setValue = useCallback((row: PomRow, size: string, value: SizeValue) => {
    setRows((now) => now.map((one) => (one.id === row.id ? { ...one, values: { ...one.values, [size]: value }, typed: one.typed.includes(size) ? one.typed : [...one.typed, size] } : one)))
    setStatus(value === null ? t('sizes.cleared', { pom: row.pom, size }) : t('sizes.saved', { pom: row.pom, size, value: sizeValueText(value, n.intl) ?? '' }))
  }, [n.intl, t])
  const columns = useMemo<Array<ColDef<PomRow> | ColGroupDef<PomRow>>>(
    () => [
      { colId: 'pom', headerName: t('sizes.pom'), field: 'pom', pinned: 'left', minWidth: 190, flex: 1, sortable: false },
      { colId: 'tolerance', headerName: t('sizes.tolerance'), width: 132, sortable: false, valueGetter: (params) => (params.data ? `± ${sizeValueText(params.data.tolerance, n.intl)} cm` : '') },
      sizeColumnGroup<PomRow>({
        sizes: SIZES,
        base: BASE,
        unit: 'cm',
        value: (row, size) => row.values[size] ?? null,
        editable: !released,
        isOverride: (row, size) => row.typed.includes(size),
        onChange: setValue,
        onRefused: (_row, size, text) => setStatus(ds.sizeColumns.notNumber(size, text)),
        locale: n.intl,
        scale: 2,
        cellLabel: (row, size) => t('sizes.cell', { pom: row.pom, size }),
        labels: ds.sizeColumns,
      }),
    ],
    [ds.sizeColumns, n.intl, released, setValue, t],
  )
  const row = rows.find((one) => one.id === fillRow) ?? rows[0]!
  const applyFill = (changes: SizeFillChange[]) => {
    setRows((now) => now.map((one) => (one.id === row.id ? { ...one, values: { ...one.values, ...Object.fromEntries(changes.map((change) => [change.size, change.to])) }, typed: one.typed.filter((size) => !changes.some((change) => change.size === size)) } : one)))
    setStatus(t('sizes.filled', { count: changes.length, pom: row.pom }))
    setFilling(false)
  }
  return (
    <div className="fw-dpl-stack">
      {held ? <Banner tone="info" title={held} /> : null}
      <div className="fw-dpl-grid-box" role="region" aria-label={t('sizes.grid')}>
        <NexusGrid<PomRow>
          {...SHEET_GRID_OPTIONS}
          rowData={rows}
          columnDefs={columns}
          getRowId={(params) => params.data.id}
          cellSelection
          domLayout="autoHeight"
        />
      </div>
      <p className="fw-dpl-note">{t('sizes.hint')}</p>
      <div className="fw-dpl-row">
        <label className="fw-dpl-label" htmlFor="fw-dpl-fill-row">
          {t('sizes.fillRow')}
        </label>
        <Select id="fw-dpl-fill-row" size="sm" value={fillRow} onChange={(event) => setFillRow(event.target.value)}>
          {rows.map((one) => (
            <option key={one.id} value={one.id}>
              {one.pom}
            </option>
          ))}
        </Select>
        <Button size="sm" heldReason={held} onClick={() => setFilling(true)} aria-haspopup="dialog">
          <Wand2 size={13} aria-hidden /> {t('sizes.fillOpen')}
        </Button>
      </div>
      <p className="fw-dpl-status" role="status">
        {status}
      </p>
      {released ? (
        <SizeFill sizes={SIZES} base={BASE} values={row.values} unit="cm" scale={2} locale={n.intl} defaultIncrement="1" heldReason={held} onApply={() => undefined} labels={ds.sizeColumns} />
      ) : null}
      <Modal open={filling} onClose={() => setFilling(false)} title={row.pom} sheet>
        {filling ? (
          <SizeFill
            sizes={SIZES}
            base={BASE}
            values={row.values}
            unit="cm"
            scale={2}
            locale={n.intl}
            overrides={row.typed}
            defaultIncrement={row.id === 'B' ? '1' : ''}
            onApply={applyFill}
            onCancel={() => setFilling(false)}
            labels={ds.sizeColumns}
          />
        ) : null}
      </Modal>
    </div>
  )
}

/* ── GarmentZoneMap ─────────────────────────────────────────────────────────────────────────────────────────────── */

function ZoneParts({ mode }: { mode: 'all' | 'held' | 'heat' }) {
  const t = useT('ds-product-lab')
  const ds = useDsLabels()
  const locale = useLocale()
  const zones = useMemo(() => GARMENT_ZONES.map((zone) => ({ id: zone.id, label: locale === 'it' ? zone.it : zone.en })), [locale])
  const [picked, setPicked] = useState<string | null>(mode === 'held' ? 'CUFF' : null)
  const heat: GarmentZoneMark[] = [
    { zone: 'ZIP', value: 9 },
    { zone: 'CUFF', value: 5 },
    { zone: 'ELBOW_L', value: 3 },
    { zone: 'COLLAR', value: 2 },
    { zone: 'LINING', value: 1 },
  ]
  const risk: GarmentZoneMark[] = [
    { zone: 'ELBOW_L', text: t('zones.impact') },
    { zone: 'ELBOW_R', text: t('zones.impact') },
    { zone: 'SHOULDER', text: t('zones.impact') },
    { zone: 'SEAT', text: t('zones.abrasion') },
    { zone: 'ZIP', text: t('zones.seam') },
  ]
  const heatMap = (
    <div className="fw-dpl-part">
      <span className="fw-dpl-label">{t('zones.heat')}</span>
      <GarmentZoneMap zones={zones} value={null} readOnly label={t('zones.heatLabel')} marks={heat} labels={{ ...ds.garmentZoneMap, marks: t('zones.heatLabel'), marksValue: t('zones.heatValue') }} />
    </div>
  )
  if (mode === 'heat') return <div className="fw-dpl-zones">{heatMap}</div>
  return (
    <div className="fw-dpl-zones">
      <div className="fw-dpl-part">
        <span className="fw-dpl-label">{t('zones.pick')}</span>
        <GarmentZoneMap zones={zones} value={picked} onChange={setPicked} label={t('zones.pickLabel')} heldReason={mode === 'held' ? t('zones.held') : null} labels={ds.garmentZoneMap} />
      </div>
      {mode === 'all' ? heatMap : null}
      {mode === 'all' ? (
        <div className="fw-dpl-part">
          <span className="fw-dpl-label">{t('zones.risk')}</span>
          <GarmentZoneMap zones={zones} value={null} readOnly compact label={t('zones.riskLabel')} marks={risk} labels={{ ...ds.garmentZoneMap, marks: t('zones.riskLabel'), marksValue: t('zones.riskValue') }} />
        </div>
      ) : null}
    </div>
  )
}
