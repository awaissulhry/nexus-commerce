'use client'

/**
 * /design/language-axis — the language-axis design for the Product Edit Studio, MOCKED.
 *
 * Eight scenarios, each a surface the design (`docs/2026-09-11-language-axis-design.md`) names,
 * rendered from `./fixtures.ts` at true size. The page decides nothing and writes nothing: no API,
 * no database, no autosave — an edit in a grid cell changes a fixture row in memory and nothing else.
 *
 * ── DS ────────────────────────────────────────────────────────────────────────────────────────
 * Every control is a DS component: `ScopeBar`, `GridToolbar`, `FilterChip`, `Listbox`, `Pill`,
 * `Button`, `Banner`, `Card`, `DataGrid`, `SegmentedControl`, `SourceIndicator`; the sheets are
 * `NexusGrid` with the engine's `IdentityBand`, `ProvenanceMark`, `CompletenessPill` and the ONE
 * `provenanceClassRules`. Sizes come from `language-axis.module.css`, which reads the DS scale.
 * Nothing imports the grid engine's package directly (scripts/check-ag-grid-import-boundary.mjs).
 *
 * ── What is NEW here, on purpose ──────────────────────────────────────────────────────────────
 * 1. Language chips INSIDE every scope (today: a listbox on master/Shopify/Etsy, nothing on
 *    Amazon/eBay). 2. The Languages side-by-side view (approved 09-01, never built). 3. A channel
 *    scope that resolves THROUGH the shared language text. 4. One provenance member the build adds,
 *    `outdated` — mocked here with the existing `SourceIndicator` and labelled as new in the legend.
 *    5. Readiness per coordinate × language. 6. Compare targets fed. 7. A catalogue-level language
 *    column and a bulk translate verb with a preview. 8. The resolver chain, written out.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'

import { Button, FilterChip, Pill, SegmentedControl } from '@/design-system/primitives'
import { Banner, Card, DataGrid, Listbox, SourceIndicator } from '@/design-system/components'
import { GridToolbar, ScopeBar, type ScopeBarItem } from '@/design-system/patterns'
import {
  CompletenessPill,
  EmptyValue,
  IdentityBand,
  NexusGrid,
  ProvenanceMark,
  provenanceClassRules,
  provenanceTooltip,
  type CellProvenance,
  type ColDef,
  type ColGroupDef,
  type ICellRendererParams,
  type RowReadinessState,
  type ScopeReadinessState,
} from '@/design-system/grid'

import css from './language-axis.module.css'
import {
  CATALOGUE,
  CHANNEL_BE_NL,
  COMPARE_TITLE,
  CONTENT_FIELDS,
  FAMILY,
  LANGUAGES,
  MARKETS,
  READINESS,
  languageLabel,
  type CatalogueRow,
  type ChannelRow,
  type CompareTarget,
  type ContentField,
  type CoordinateReadiness,
  type FamilyRow,
  type LangState,
  type ScopeState,
} from './fixtures'

/* ── vocabulary bridges: the fixture's states → the DS's ─────────────────────────────────────── */

const SCOPE_STATE: Record<ScopeState, ScopeReadinessState> = { live: 'ready', ready: 'ready', pending: 'warn', errors: 'blocked' }
const ROW_STATE: Record<ScopeState, RowReadinessState> = { live: 'live', ready: 'ready', pending: 'missing', errors: 'errors' }

/** The one classification for a language cell. `outdated` is the member the build adds; until then its class is `own`. */
const provOfState = (state: LangState): CellProvenance =>
  state === 'inherited' ? 'inherited' : state === 'ai' ? 'ai' : state === 'aiStale' ? 'aiStale' : 'own'

const SOURCE = 'Italian · source'

/* ── scaffolding ─────────────────────────────────────────────────────────────────────────────── */

function Scenario({ id, title, hint, children }: { id: string; title: string; hint: ReactNode; children?: ReactNode }) {
  return (
    <section className={css.scenario} data-lx-scenario={id}>
      <h3 className={css.scenarioTitle}>
        {title} <span className={css.scenarioId}>#{id}</span>
      </h3>
      <p className={css.hint}>{hint}</p>
      {children}
    </section>
  )
}

function Stage({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className={css.stage}>
      <div className={css.stageLabel}>{label}</div>
      {children}
    </div>
  )
}

/**
 * The language control, the SAME on every scope: one chip per language the scope can carry. In the
 * single-language sheet exactly one is pressed; in the Languages view several are. Same component,
 * the multiplicity belongs to the view.
 */
function LanguageChips({ languages, active, onToggle, multi }: { languages: string[]; active: string[]; onToggle: (code: string) => void; multi?: boolean }) {
  return (
    <span className={css.langChips} role="group" aria-label={multi ? 'Languages shown' : 'Content language'}>
      {languages.map((code) => {
        const primary = LANGUAGES.find((l) => l.code === code)?.primary
        return (
          <FilterChip key={code} pressed={active.includes(code)} onClick={() => onToggle(code)} title={`${languageLabel(code)} (${code})${primary ? ' — the source language' : ''}`}>
            {languageLabel(code)}{primary ? <span className={css.primaryMark}> · source</span> : null}
          </FilterChip>
        )
      })}
    </span>
  )
}

/** Readiness of ONE coordinate in ONE language, as the scope bar's chip states it. */
function scopeReadiness(coordinateId: string, language: string): ScopeBarItem['readiness'] {
  const coord = READINESS.find((c) => c.id === coordinateId)
  const cell = coord?.byLanguage[language]
  if (!coord) return { pct: null, state: 'absent', note: 'No listing on this coordinate yet.' }
  if (!cell) return { pct: null, state: 'absent', note: `${coord.label} does not sell in ${languageLabel(language)}.` }
  const missing = cell.missing?.length ? ` · missing: ${cell.missing.join(', ')}` : ''
  return { pct: cell.pct, state: SCOPE_STATE[cell.state], note: `${languageLabel(language)} — ${cell.pct}% of required fields filled${missing}` }
}

function channelItems(market: string, language: string): ScopeBarItem[] {
  const mk = MARKETS.find((m) => m.code === market)
  return [
    { id: 'master', label: 'Shared product', readiness: scopeReadiness('master', language) },
    { id: 'AMAZON', label: 'Amazon', readiness: mk?.channels.includes('AMAZON') ? scopeReadiness(`amazon-${market.toLowerCase()}`, language) : undefined },
    { id: 'EBAY', label: 'eBay', readiness: mk?.channels.includes('EBAY') ? scopeReadiness(`ebay-${market.toLowerCase()}`, language) : undefined },
  ]
}

const marketOptions = (channel: string) => MARKETS.filter((m) => m.channels.includes(channel)).map((m) => ({ value: m.code, label: `${m.label} (${m.code})` }))

/* ── S1: the scope bar, three states ─────────────────────────────────────────────────────────── */

function ScopeBarScenarios() {
  const [masterLang, setMasterLang] = useState('de')
  const [beLang, setBeLang] = useState('nl')
  const allLanguages = LANGUAGES.map((l) => l.code)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Stage label={<><b>Shared product</b> · the union of every active market's languages · one pressed</>}>
        <ScopeBar className="nds-workspace-scope" label="Editing" items={channelItems('DE', masterLang)} active="master" onChange={() => undefined}
          right={<LanguageChips languages={allLanguages} active={[masterLang]} onToggle={setMasterLang} />} />
      </Stage>
      <Stage label={<><b>Amazon · Germany</b> · a one-language market · the chip is the market's language, stated, not implied</>}>
        <ScopeBar className="nds-workspace-scope" label="Editing" items={channelItems('DE', 'de')} active="AMAZON" onChange={() => undefined}
          right={<>
            <Listbox size="sm" width="auto" options={marketOptions('AMAZON')} value="DE" onChange={() => undefined} ariaLabel="Market" />
            <LanguageChips languages={['de']} active={['de']} onToggle={() => undefined} />
          </>} />
      </Stage>
      <Stage label={<><b>Amazon · Belgium</b> · a two-language market · both languages addressable, one pressed — impossible in today's model</>}>
        <ScopeBar className="nds-workspace-scope" label="Editing" items={channelItems('BE', beLang)} active="AMAZON" onChange={() => undefined}
          right={<>
            <Listbox size="sm" width="auto" options={marketOptions('AMAZON')} value="BE" onChange={() => undefined} ariaLabel="Market" />
            <LanguageChips languages={['fr', 'nl']} active={[beLang]} onToggle={setBeLang} />
          </>} />
      </Stage>
    </div>
  )
}

/* ── S2: the Languages view on the master sheet ──────────────────────────────────────────────── */

const rowId = <T extends { id: string }>(p: { data: T }) => p.data.id

function LangCellView({ p, field, code }: { p: ICellRendererParams<FamilyRow>; field: ContentField; code: string }) {
  const row = p.data
  if (!row) return null
  const cell = row.content[field][code]
  const source = row.content[field].it.value
  const shown = cell.state === 'inherited' ? source : cell.value
  const prov = provOfState(cell.state)
  return (
    <span className="nds-cell-value">
      {cell.state === 'outdated' ? (
        <SourceIndicator kind="warning" tabIndex={-1} label="Out of date"
          description="The Italian source changed after this translation was written. Open Compare to see what moved, or translate again." />
      ) : (
        <ProvenanceMark provenance={prov} from={prov === 'inherited' ? SOURCE : prov === 'aiStale' ? 'the Italian source' : undefined} />
      )}
      <span className="nds-cell-value-text">{shown == null || shown === '' ? <EmptyValue /> : shown}</span>
    </span>
  )
}

function LanguagesSheet() {
  const [rows] = useState<FamilyRow[]>(() => JSON.parse(JSON.stringify(FAMILY)) as FamilyRow[])
  const [pressed, setPressed] = useState<string[]>(['it', 'de', 'fr'])
  const [view, setView] = useState<'one' | 'languages'>('languages')
  const [filter, setFilter] = useState<'all' | 'missing' | 'ai' | 'outdated'>('all')

  const toggle = (code: string) => setPressed((cur) => (cur.includes(code) ? (cur.length > 1 ? cur.filter((c) => c !== code) : cur) : [...cur, code]))
  const shownLanguages = view === 'languages' ? pressed : [pressed.find((c) => c !== 'it') ?? pressed[0]]

  const counts = useMemo(() => {
    let missing = 0, ai = 0, outdated = 0
    for (const r of rows) for (const f of CONTENT_FIELDS) for (const code of shownLanguages) {
      const s = r.content[f.key][code]?.state
      if (s === 'inherited') missing++
      else if (s === 'ai' || s === 'aiStale') ai++
      else if (s === 'outdated') outdated++
    }
    return { missing, ai, outdated }
  }, [rows, shownLanguages])

  const columnDefs = useMemo<(ColDef<FamilyRow> | ColGroupDef<FamilyRow>)[]>(() => {
    const prov = provenanceClassRules<FamilyRow>((row, colId) => {
      const [field, code] = colId.split('@') as [ContentField, string]
      const cell = row.content[field]?.[code]
      return cell ? provOfState(cell.state) : 'own'
    })
    const identity: ColDef<FamilyRow> = {
      colId: '__identity', headerName: 'Variation', pinned: 'left', width: 292, lockPosition: true, suppressMovable: true, editable: false,
      cellClass: 'nds-ag-cell',
      cellRenderer: (p: ICellRendererParams<FamilyRow>) => p.data ? (
        <IdentityBand role={<Pill tone="neutral">C</Pill>} noImage sku={p.data.sku} secondary={p.data.axes} secondaryTitle={p.data.axes}
          trailing={<CompletenessPill pct={familyPct(p.data, shownLanguages)} state={familyPct(p.data, shownLanguages) === 100 ? 'ready' : 'missing'} tip={`${familyPct(p.data, shownLanguages)}% of the shown languages filled`} />} />
      ) : null,
    }
    const groups: ColGroupDef<FamilyRow>[] = CONTENT_FIELDS.map((f) => ({
      headerName: f.label,
      groupId: f.key,
      marryChildren: true,
      children: shownLanguages.map((code): ColDef<FamilyRow> => ({
        colId: `${f.key}@${code}`,
        headerName: code === 'it' ? SOURCE : languageLabel(code),
        width: f.long ? 320 : 236,
        editable: true,
        cellClass: 'nds-ag-cell',
        cellClassRules: prov,
        valueGetter: (p) => (p.data ? (p.data.content[f.key][code].state === 'inherited' ? p.data.content[f.key].it.value : p.data.content[f.key][code].value) : null),
        valueSetter: (p) => {
          if (!p.data) return false
          // 🔴 Mutate the row the grid holds (reference_ag_value_setter_must_mutate_params_data).
          p.data.content[f.key][code] = { value: p.newValue == null || p.newValue === '' ? null : String(p.newValue), state: 'own' }
          return true
        },
        tooltipValueGetter: (p) => {
          const cell = p.data?.content[f.key][code]
          if (!cell) return ''
          if (cell.state === 'outdated') return 'Out of date — the Italian source changed after this translation was written'
          const prov = provOfState(cell.state)
          return prov === 'own' ? '' : provenanceTooltip(prov, prov === 'inherited' ? SOURCE : prov === 'aiStale' ? 'the Italian source' : undefined)
        },
        cellRenderer: (p: ICellRendererParams<FamilyRow>) => <LangCellView p={p} field={f.key} code={code} />,
      })),
    }))
    return [identity, ...groups]
  }, [shownLanguages])

  const filteredRows = useMemo(() => {
    if (filter === 'all') return rows
    const want: LangState[] = filter === 'missing' ? ['inherited'] : filter === 'ai' ? ['ai', 'aiStale'] : ['outdated']
    return rows.filter((r) => CONTENT_FIELDS.some((f) => shownLanguages.some((code) => want.includes(r.content[f.key][code]?.state))))
  }, [rows, filter, shownLanguages])

  const chip = (id: typeof filter) => ({ pressed: filter === id, onClick: () => setFilter(filter === id ? 'all' : id) })

  return (
    <Stage label={<><b>Shared product</b> · Information · the <b>Languages</b> view · {shownLanguages.length} of {LANGUAGES.length} languages side by side · edits stay in this page</>}>
      <ScopeBar className="nds-workspace-scope" label="Editing" items={channelItems('DE', 'de')} active="master" onChange={() => undefined}
        right={<LanguageChips multi languages={LANGUAGES.map((l) => l.code)} active={view === 'languages' ? pressed : shownLanguages} onToggle={toggle} />} />
      <GridToolbar
        count={<>{filteredRows.length} of {rows.length} variations · <b>{shownLanguages.length}</b> languages</>}
        right={<>
          <Button size="sm" variant="ghost">Customise</Button>
          <Button size="sm" variant="ghost">Export</Button>
          <Button size="sm" variant="secondary">Translate <ChevronDown size={14} aria-hidden /></Button>
        </>}
      >
        <SegmentedControl size="sm" ariaLabel="Sheet view" value={view} onChange={(v) => setView(v as 'one' | 'languages')}
          options={[{ value: 'one', label: 'One language' }, { value: 'languages', label: 'Languages' }]} />
        <FilterChip {...chip('missing')} count={counts.missing}>Needs translation</FilterChip>
        <FilterChip {...chip('ai')} count={counts.ai}>AI drafts</FilterChip>
        <FilterChip {...chip('outdated')} count={counts.outdated}>Out of date</FilterChip>
      </GridToolbar>
      <div className={css.sheetHost}>
        <NexusGrid<FamilyRow>
          rows="text"
          domLayout="autoHeight"
          rowData={filteredRows}
          getRowId={rowId}
          columnDefs={columnDefs}
          defaultColDef={DEFAULT_COL}
          suppressCellFocus={false}
          stopEditingWhenCellsLoseFocus
          enterNavigatesVertically
          enterNavigatesVerticallyAfterEdit
          tooltipShowDelay={300}
        />
      </div>
    </Stage>
  )
}

const DEFAULT_COL: ColDef = { resizable: true, sortable: false, suppressHeaderMenuButton: true }

function familyPct(row: FamilyRow, languages: string[]): number {
  let filled = 0, total = 0
  for (const f of CONTENT_FIELDS) for (const code of languages) {
    total++
    if (row.content[f.key][code]?.state !== 'inherited') filled++
  }
  return total ? Math.round((filled / total) * 100) : 0
}

/* ── S3: a channel scope resolving THROUGH the language tier ─────────────────────────────────── */

const CHANNEL_PROV: Record<ChannelRow['title']['state'], { prov: CellProvenance; from: string }> = {
  inheritedLanguage: { prov: 'inherited', from: 'Dutch · shared' },
  inheritedSource: { prov: 'inherited', from: 'Italian · source — no Dutch text yet' },
  pinned: { prov: 'pinned', from: 'Dutch · shared' },
  mapped: { prov: 'mapped', from: 'the rule "Dutch bullet caps"' },
}

function ChannelSheet() {
  const [rows] = useState<ChannelRow[]>(() => JSON.parse(JSON.stringify(CHANNEL_BE_NL)) as ChannelRow[])
  const columnDefs = useMemo<ColDef<ChannelRow>[]>(() => {
    const fields: { key: 'title' | 'description' | 'bullet1'; label: string; width: number }[] = [
      { key: 'title', label: 'Title', width: 340 }, { key: 'description', label: 'Description', width: 360 }, { key: 'bullet1', label: 'Bullet 1', width: 320 },
    ]
    const prov = provenanceClassRules<ChannelRow>((row, colId) => CHANNEL_PROV[row[colId as 'title' | 'description' | 'bullet1']?.state]?.prov ?? 'own')
    const identity: ColDef<ChannelRow> = {
      colId: '__identity', headerName: 'Listing', pinned: 'left', width: 292, lockPosition: true, suppressMovable: true, editable: false, cellClass: 'nds-ag-cell',
      cellRenderer: (p: ICellRendererParams<ChannelRow>) => p.data ? (
        <IdentityBand role={<Pill tone="info">P</Pill>} noImage sku={p.data.sku} secondary={`${p.data.axes} · ${p.data.listingId}`} secondaryTitle={p.data.listingId}
          trailing={<CompletenessPill pct={p.data.title.state === 'inheritedSource' ? 8 : 100} state={p.data.title.state === 'inheritedSource' ? 'errors' : 'ready'} tip="Dutch — required fields filled" />} />
      ) : null,
    }
    return [identity, ...fields.map((f): ColDef<ChannelRow> => ({
      colId: f.key, headerName: f.label, width: f.width, editable: true, cellClass: 'nds-ag-cell', cellClassRules: prov,
      valueGetter: (p) => p.data?.[f.key].value ?? null,
      valueSetter: (p) => { if (!p.data) return false; p.data[f.key] = { value: String(p.newValue ?? ''), state: 'pinned' }; return true },
      tooltipValueGetter: (p) => { const s = p.data?.[f.key].state; return s ? provenanceTooltip(CHANNEL_PROV[s].prov, CHANNEL_PROV[s].from) : '' },
      cellRenderer: (p: ICellRendererParams<ChannelRow>) => {
        const c = p.data?.[f.key]
        if (!c) return null
        const m = CHANNEL_PROV[c.state]
        return <span className="nds-cell-value"><ProvenanceMark provenance={m.prov} from={m.from} /><span className="nds-cell-value-text">{c.value}</span></span>
      },
    }))]
  }, [])
  return (
    <Stage label={<><b>Amazon · Belgium · Dutch</b> · Listing information · the same sheet, reading pin → shared Dutch → Italian source</>}>
      <ScopeBar className="nds-workspace-scope" label="Editing" items={channelItems('BE', 'nl')} active="AMAZON" onChange={() => undefined}
        right={<>
          <Listbox size="sm" width="auto" options={marketOptions('AMAZON')} value="BE" onChange={() => undefined} ariaLabel="Market" />
          <LanguageChips languages={['fr', 'nl']} active={['nl']} onToggle={() => undefined} />
        </>} />
      <GridToolbar count={<>{rows.length} listings · <b>Dutch</b></>} right={<><Button size="sm" variant="ghost">Customise</Button><Button size="sm" variant="ghost">Export</Button><Button size="sm" variant="primary">Publish</Button></>}>
        <FilterChip count={5}>Follows Italian source</FilterChip>
        <FilterChip count={1}>Pinned here</FilterChip>
      </GridToolbar>
      <div className={css.sheetHost}>
        <NexusGrid<ChannelRow> rows="text" domLayout="autoHeight" rowData={rows} getRowId={rowId} columnDefs={columnDefs} defaultColDef={DEFAULT_COL}
          suppressCellFocus={false} stopEditingWhenCellsLoseFocus enterNavigatesVertically enterNavigatesVerticallyAfterEdit tooltipShowDelay={300} />
      </div>
      <div style={{ padding: 12 }}>
        <Banner tone="warning" title="This cell follows the shared Dutch text"
          action={<><Button size="sm" variant="primary">Edit the shared Dutch</Button><Button size="sm" variant="secondary">Pin on Amazon · BE · nl</Button></>}>
          Editing it here changes Dutch on every listing that follows it: Amazon · NL and Amazon · BE (nl). Pin it on this listing to change only this listing. Declining reverts the cell.
        </Banner>
      </div>
    </Stage>
  )
}

/* ── S4: the cell vocabulary, one table ──────────────────────────────────────────────────────── */

interface LegendRow { mark: ReactNode; name: string; isNew?: boolean; tooltip: string; next: string }

function Legend() {
  const rows: LegendRow[] = [
    { mark: <span className={css.muted}>—</span>, name: 'own', tooltip: 'No mark. The value is this cell\'s own, in this language.', next: 'Edit changes this value.' },
    { mark: <ProvenanceMark provenance="inherited" from={SOURCE} />, name: 'inherited · from the source language', tooltip: provenanceTooltip('inherited', SOURCE), next: 'Edit writes this language\'s own value; the source is untouched.' },
    { mark: <ProvenanceMark provenance="inherited" from="Dutch · shared" />, name: 'inherited · from the shared language text', tooltip: provenanceTooltip('inherited', 'Dutch · shared'), next: 'On a channel scope: acknowledge (edit the shared text) or pin on this coordinate. Declining reverts.' },
    { mark: <ProvenanceMark provenance="pinned" from="Dutch · shared" />, name: 'pinned · on (channel, market, language)', tooltip: provenanceTooltip('pinned', 'Dutch · shared'), next: 'Edit changes the pin; Reset returns the cell to the shared text.' },
    { mark: <ProvenanceMark provenance="ai" />, name: 'ai · machine draft awaiting review', tooltip: provenanceTooltip('ai'), next: 'Approve, edit, or reject. It never reaches a listing unreviewed.' },
    { mark: <ProvenanceMark provenance="aiStale" from="the Italian source" />, name: 'aiStale · draft from an older source', tooltip: provenanceTooltip('aiStale', 'the Italian source'), next: 'Compare with the source before approving.' },
    { mark: <SourceIndicator kind="warning" tabIndex={-1} label="Out of date" description="The source changed after this translation was written." />, name: 'outdated · translation older than its source', isNew: true, tooltip: 'Out of date — the Italian source changed after this translation was written.', next: 'Compare with the source; translate again or mark reviewed.' },
    { mark: <ProvenanceMark provenance="mapped" from="a mapping rule" />, name: 'mapped · derived by a rule', tooltip: provenanceTooltip('mapped', 'a mapping rule'), next: 'Unchanged. Language never changes where a rule is edited.' },
    { mark: <ProvenanceMark provenance="formula" from="=UPPER(title)" />, name: 'formula', tooltip: provenanceTooltip('formula', '=UPPER(title)'), next: 'Unchanged. A formula can target one language (ruled D16).' },
    { mark: <ProvenanceMark provenance="refused" from="German title exceeds 200 bytes for Amazon · DE" />, name: 'refused', tooltip: 'The server\'s own sentence, verbatim.', next: 'Unchanged.' },
  ]
  return (
    <div className={css.legend}>
      {rows.map((r) => (
        <div key={r.name} className={css.legendRow}>
          <span className={css.legendMark}>{r.mark}</span>
          <span>
            <div className={css.legendName}>{r.name}{r.isNew && <Pill tone="info" className={css.legendNew}>new member</Pill>}</div>
            <div className={css.legendText}>{r.tooltip}</div>
            <div className={css.legendNext}>Next click: {r.next}</div>
          </span>
        </div>
      ))}
    </div>
  )
}

/* ── S5: readiness per coordinate × language ─────────────────────────────────────────────────── */

function ReadinessMatrix() {
  const languages = LANGUAGES.map((l) => l.code)
  const columns = [
    { key: 'coordinate', label: 'Coordinate', width: 180, render: (r: CoordinateReadiness) => <b>{r.label}</b> },
    ...languages.map((code) => ({
      key: code, label: languageLabel(code),
      render: (r: CoordinateReadiness) => {
        const c = r.byLanguage[code]
        if (!c) return <span className={css.muted} title={`${r.label} does not sell in ${languageLabel(code)}`}>—</span>
        return <CompletenessPill pct={c.pct} state={ROW_STATE[c.state]} tip={c.missing?.length ? `Missing: ${c.missing.join(', ')}` : `${c.pct}% filled`} />
      },
    })),
  ]
  const attention = READINESS.flatMap((r) => languages.flatMap((code) => {
    const c = r.byLanguage[code]
    return c && c.state !== 'ready' && c.state !== 'live' ? [{ id: `${r.id}:${code}`, coordinate: r.label, language: languageLabel(code), pct: c.pct, missing: c.missing?.join(', ') ?? '' }] : []
  }))
  return (
    <div className={css.two}>
      <Card header="Readiness per coordinate and language" description="A market with untranslated content cannot read “ready”. The scope bar's chip shows the pressed language; this matrix shows all of them.">
        <DataGrid<CoordinateReadiness> ariaLabel="Readiness by coordinate and language" columns={columns} rows={READINESS} rowKey={(r) => r.id} />
      </Card>
      <Card header="Needs attention" description="One row per (coordinate, language) below ready — the list the Needs-attention page and the catalogue grid both read.">
        <DataGrid ariaLabel="Needs attention" rows={attention} rowKey={(r) => r.id} columns={[
          { key: 'coordinate', label: 'Coordinate', render: (r) => r.coordinate },
          { key: 'language', label: 'Language', render: (r) => r.language },
          { key: 'pct', label: 'Filled', numeric: true, render: (r) => `${r.pct}%` },
          { key: 'missing', label: 'Missing', render: (r) => r.missing },
        ]} />
      </Card>
    </div>
  )
}

/* ── S6: the compare pane with language targets ──────────────────────────────────────────────── */

function ComparePane() {
  const kindPill = (k: CompareTarget['kind']) => k === 'source' ? <Pill tone="neutral">source</Pill> : k === 'language' ? <Pill tone="info">language</Pill> : <Pill tone="warning">coordinate</Pill>
  return (
    <Card header="Compare · Title · GALE-JACKET-M-BLK" description="Every language of the field and every coordinate that carries it, in one list. Copy-across goes through the one write path; a copy onto a coordinate is a pin.">
      <DataGrid<CompareTarget> ariaLabel="Compare targets" rows={COMPARE_TITLE} rowKey={(r) => r.id} columns={[
        { key: 'target', label: 'Target', width: 200, render: (r) => <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>{r.label}{kindPill(r.kind)}</span> },
        { key: 'value', label: 'Value', render: (r) => <span className={css.value} title={r.value}>{r.value}</span> },
        { key: 'note', label: 'Provenance', render: (r) => <span className={css.muted}>{r.note}</span> },
        { key: 'copy', label: '', width: 120, render: (r) => r.kind === 'source' ? null : <Button size="sm" variant="ghost">Copy here</Button> },
      ]} />
    </Card>
  )
}

/* ── S7: catalogue level — a language column and a bulk verb with a preview ──────────────────── */

function CatalogueGrid() {
  const [language, setLanguage] = useState('de')
  const cell = (c: CatalogueRow['titleDe'], source: string) => (
    <span className="nds-cell-value">
      {c.state === 'outdated'
        ? <SourceIndicator kind="warning" tabIndex={-1} label="Out of date" description="The Italian source changed after this translation was written." />
        : <ProvenanceMark provenance={provOfState(c.state)} from={c.state === 'inherited' ? SOURCE : undefined} />}
      <span className="nds-cell-value-text">{c.state === 'inherited' ? source : c.value}</span>
    </span>
  )
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="nds-gridcard">
        <GridToolbar count={<>Viewing <b>1–5</b> of 3,142 products</>} right={<><Button size="sm" variant="ghost">Customise</Button><Button size="sm" variant="secondary">Translate to {languageLabel(language)} <ChevronDown size={14} aria-hidden /></Button></>}>
          <Listbox size="sm" width="auto" ariaLabel="Language column" value={language} onChange={setLanguage}
            options={LANGUAGES.filter((l) => !l.primary).map((l) => ({ value: l.code, label: `Language · ${l.label}` }))} />
          <FilterChip count={1208}>Missing {languageLabel(language)} title</FilterChip>
          <FilterChip count={96}>AI drafts</FilterChip>
        </GridToolbar>
        <DataGrid<CatalogueRow> ariaLabel="Products" rows={CATALOGUE} rowKey={(r) => r.id} selectable columns={[
          { key: 'product', label: 'Product', width: 260, render: (r) => <span style={{ display: 'grid' }}><b>{r.name}</b><span className={`${css.mono} ${css.muted}`}>{r.sku} · {r.family}</span></span> },
          { key: 'variations', label: 'Variations', numeric: true, render: (r) => r.variations },
          { key: 'titleIt', label: 'Title · Italian · source', render: (r) => r.titleIt },
          { key: 'titleDe', label: `Title · ${languageLabel(language)}`, render: (r) => cell(r.titleDe, r.titleIt) },
          { key: 'readiness', label: `${languageLabel(language)} readiness`, width: 150, render: (r) => <CompletenessPill pct={r.readinessDe.pct} state={ROW_STATE[r.readinessDe.state]} tip={`${r.readinessDe.pct}% of required ${languageLabel(language)} fields filled`} /> },
        ]} />
      </div>
      <Card header={`Preview · Translate to ${languageLabel(language)}`} description="Filter-scoped, not selection-scoped: the verb applies to every product the grid's filter matches, and it says what it will do before it does it."
        headerAction={<><Button size="sm" variant="primary">Run as drafts</Button><Button size="sm" variant="ghost">Cancel</Button></>}>
        <div className={css.previewGrid}>
          <div className={css.previewStat}><span className={css.previewNum}>3,142</span><span className={css.previewLabel}>products in the filter</span></div>
          <div className={css.previewStat}><span className={css.previewNum}>1,208</span><span className={css.previewLabel}>get a {languageLabel(language)} title as a ✦ draft</span></div>
          <div className={css.previewStat}><span className={css.previewNum}>1,934</span><span className={css.previewLabel}>already have one · skipped</span></div>
          <div className={css.previewStat}><span className={css.previewNum}>€4.10</span><span className={css.previewLabel}>estimated, from the rate card</span></div>
          <div className={css.previewStat}><span className={css.previewNum}>7 days</span><span className={css.previewLabel}>revert window for the whole run</span></div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Banner tone="info" title="Drafts land on the shared language text">
            Nothing reaches a listing until a draft is reviewed. Every listing that follows the shared {languageLabel(language)} text inherits the approved value the moment it is approved — Amazon, eBay and the store alike.
          </Banner>
        </div>
      </Card>
    </div>
  )
}

/* ── S8: the chain, written out ──────────────────────────────────────────────────────────────── */

function ResolverChain() {
  return (
    <div className={css.two}>
      <Card header="How any cell resolves, on any scope" description="One function, one order. The five cascades in the tree today collapse behind it.">
        <ol className={css.chain}>
          <li><b>Pin</b> at (channel, market, language) — the listing's own text, when the operator pinned it.</li>
          <li><b>Language layer</b> at (product, field, language) — the shared text every destination in that language inherits.</li>
          <li><b>Source</b> — the master's primary-language value (Italian for this catalogue).</li>
          <li><b>Computed</b> — a mapping rule, a formula, a default.</li>
        </ol>
        <p className={css.hint} style={{ marginTop: 10 }}>The mark on the cell names the tier that answered and where the next click lands. A channel scope reads through the chain in the language(s) its market speaks; nothing else about the sheet changes.</p>
      </Card>
      <Card header="One market → languages table" description="Marketplace.languages[] is the only place a market's languages are stated. The eleven code maps are deleted; publish derives language_tag from it.">
        <DataGrid ariaLabel="Markets and their languages" rows={MARKETS} rowKey={(m) => m.code} columns={[
          { key: 'market', label: 'Market', render: (m) => <b>{m.label} ({m.code})</b> },
          { key: 'languages', label: 'Languages', render: (m) => <span style={{ display: 'inline-flex', gap: 6 }}>{m.languages.map((l) => <Pill key={l} tone={m.languages.length > 1 ? 'info' : 'neutral'}>{languageLabel(l)}</Pill>)}</span> },
          { key: 'tags', label: 'language_tag at publish', render: (m) => <span className={css.mono}>{m.languages.map((l) => `${l}_${m.code === 'UK' ? 'GB' : m.code}`).join(' · ')}</span> },
          { key: 'channels', label: 'Channels', render: (m) => m.channels.map((c) => (c === 'AMAZON' ? 'Amazon' : 'eBay')).join(' · ') },
        ]} />
      </Card>
    </div>
  )
}

/* ── the page ────────────────────────────────────────────────────────────────────────────────── */

export function LanguageAxisClient() {
  const [dark, setDark] = useState(false)
  return (
    <div className={`${css.page}${dark ? ' dark' : ''}`}>
      <header className={css.head}>
        <span className={css.eyebrow}>Product Edit Studio · design mock · 2026-09-11</span>
        <h1 className={css.title}>Language as an axis of the sheet</h1>
        <p className={css.lead}>
          Eight surfaces from <span className={css.mono}>docs/2026-09-11-language-axis-design.md</span>, rendered from a frozen fixture on the design system. Nothing here reads or writes an API. Every edit stays in this page.
        </p>
        <div className={css.controls}>
          <SegmentedControl size="sm" ariaLabel="Theme" value={dark ? 'dark' : 'light'} onChange={(v) => setDark(v === 'dark')} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          <span className={`${css.hint}`}>Family: GALE-JACKET, 6 variations · markets as production holds them, plus Belgium's second language</span>
        </div>
      </header>

      <Scenario id="S1" title="The scope bar: language chips inside every scope"
        hint="Today the language is a listbox on the shared product, Shopify and Etsy, and nothing on Amazon and eBay. Here it is the same chip control on every scope. A one-language market shows one chip, stated. A two-language market shows two. The chips derive from the market's language list; the shared product shows the union of every active market's languages.">
        <ScopeBarScenarios />
      </Scenario>

      <Scenario id="S2" title="The Information sheet in the Languages view"
        hint="The approved 09-01 line, built: localizable columns widen to one column per pressed language, grouped by field so a translator reads the source beside each language. The single-language sheet is unchanged; this is a view. Chips filter to the work: what still falls back to the source, what a machine drafted, what went out of date.">
        <LanguagesSheet />
      </Scenario>

      <Scenario id="S3" title="A channel scope reading through the language tier"
        hint="Amazon · Belgium · Dutch. A cell that follows the shared Dutch text says so and names it; a cell with no Dutch yet says it is showing the Italian source; a pin names what it stopped following. Editing an inherited cell asks one question, with both answers on it, and declining reverts the cell.">
        <ChannelSheet />
      </Scenario>

      <Scenario id="S4" title="One cell vocabulary on both scopes"
        hint="Today the master sheet and the channel sheet describe the same translation fact in two vocabularies and two tones. This is the one list: the existing DS members, their tooltip sentence verbatim, and the one member the build adds. Every mark names its source and where the next click lands.">
        <Legend />
      </Scenario>

      <Scenario id="S5" title="Readiness per coordinate and language"
        hint="Readiness is scored per (channel, market, language) and materialised, so the scope bar, the catalogue grid and the Needs-attention page all read one row instead of recomputing a sheet. A dash means the coordinate does not sell in that language; it is never zero.">
        <ReadinessMatrix />
      </Scenario>

      <Scenario id="S6" title="The compare pane, fed"
        hint="The drawer's Compare pane already supports a language target in its types and its query; no host builds one. Here the hosts feed it every language of the field and every coordinate that carries it.">
        <ComparePane />
      </Scenario>

      <Scenario id="S7" title="Thousands of products: the catalogue grid and one bulk verb"
        hint="A language column selector on the products grid shows the shared text and its readiness for one language across the catalogue. Translate is filter-scoped, previews its effect, lands drafts on the shared language text, and is revertible as one run.">
        <CatalogueGrid />
      </Scenario>

      <Scenario id="S8" title="The chain, and the one table"
        hint="What the build replaces sixteen stores, five resolvers and twelve market-to-language definitions with.">
        <ResolverChain />
      </Scenario>

      <p className={css.footnote}>
        Mock only. The design and the implementation plan are in <span className={css.mono}>docs/2026-09-11-language-axis-design.md</span>; the build prompt in <span className={css.mono}>docs/2026-09-11-language-axis-build-prompt.md</span>. The audit behind both is the 2026-09-11 “Studio Language Audit”.
      </p>
    </div>
  )
}
