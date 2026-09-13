'use client'

/**
 * /design/variation-projection — the Variation projection design (VX), MOCKED and TESTABLE.
 *
 * Ten scenarios, each a surface `docs/2026-09-12-variation-projection-design.md` names, rendered
 * from `./fixtures.ts` at true size. The page decides nothing and writes nothing: no API, no
 * database, no autosave. Every control is LIVE against the fixture, though — untick an axis and the
 * collision report recomputes from `collisionsOf()`, change a resolver and the outcome sentence
 * changes, switch the listing and the whole channel state re-projects. So a reviewer can test the
 * rules, not only look at them.
 *
 * ── DS ─────────────────────────────────────────────────────────────────────────────────────────
 * Every control is a DS component: `ScopeBar`, `GridToolbar`, `AxisChip`, `MappingChip`, `Button`,
 * `FilterChip`, `Tag`, `Pill`, `Listbox`, `Radio`, `Checkbox`, `Input`, `Divider`,
 * `SegmentedControl`, `Banner`, `Card`, `Field`, `Modal`, `SummaryTable`, `Disclosure`,
 * `SourceIndicator`; the sheets are `NexusGrid` with the engine's `IdentityBand`,
 * `CompletenessPill`, `ProjectionCell`, `projectionMeta` and `readinessMeta`. The bands carry the
 * DS's own `.nds-pageband` geometry and `.nds-scopebar-label` eyebrow, so a band that drifts drifts
 * for every bar at once. Sizes live in `variation-projection.module.css`, which reads the DS scale.
 * Nothing imports the grid engine's package directly (scripts/check-ag-grid-import-boundary.mjs).
 *
 * ── What is NEW here, on purpose ───────────────────────────────────────────────────────────────
 *  1. A `Variations` group on the channel mapping page — the rule, per channel × market × category.
 *  2. `Follows rule` / `Overridden here` with Reset to rule, on the band and in the dock.
 *  3. An include toggle per family axis, so a channel can take two axes where another takes three.
 *  4. The COLLISION rule and its three resolvers — the check the projection PATCH does not do today.
 *  5. A preview dock that runs the publish adapters in dry-run: buyer view, payload, diff.
 *  6. Theme change as a dry-run PLAN per channel, with what it keeps and what it loses.
 *  7. A listing listbox in the scope bar, and one projection column per alias on the shared state.
 *  8. A sixth projection word, `Collides` — mocked with the DS's own cell classes and `readinessMeta`,
 *     and labelled as the member VX.3 adds to `design-system/grid/renderers/projection.ts`.
 *  9. Catalogue filters and one bulk verb, so the rule can be applied to thousands of products.
 * 10. Axis names as the channel's vocabulary, values pushed verbatim — the resolution chains, drawn.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, ChevronRight, GripVertical, Link2, Pin, X } from 'lucide-react'

import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'

import {
  AxisChip, Button, Checkbox, Divider, FilterChip, Input, MappingChip, Pill, Radio,
  SegmentedControl, Tag,
} from '@/design-system/primitives'
import {
  Banner, Card, Disclosure, Field, Listbox, Modal, SourceIndicator, SummaryTable,
} from '@/design-system/components'
import { GridToolbar, ScopeBar, type ScopeBarItem } from '@/design-system/patterns'
import {
  CompletenessPill,
  IdentityBand,
  NexusGrid,
  ProjectionCell,
  projectionMeta,
  readinessMeta,
  type ColDef,
  type ColGroupDef,
  type ICellRendererParams,
  type ProjectionCellParams,
  type ProjectionFacts,
  type ProjectionState,
  type ScopeReadinessState,
} from '@/design-system/grid'

import css from './variation-projection.module.css'
import {
  AXES, BULK_DRY_RUN, CATALOGUE, CATALOGUE_FILTERS, CHANGES, CHANNEL_FACTS, COORDINATES,
  PARENT, PLANS, PREVIEW_DIFF, PREVIEW_WARNINGS, PREVIEWS, RESOLVERS, RULES, TARGET_OPTIONS,
  VARIANTS, axisByKey, collisionsOf, deliveredAxisName, deliveredValue, droppedAxes,
  ruleFor, valueLabel,
  type CatalogueState, type CellState, type Coordinate, type Resolver, type ThemeChangePlan,
  type Variant, type VariationRule,
} from './fixtures'

/* ── scaffolding ─────────────────────────────────────────────────────────────────────────────── */

const SCENARIOS: Array<{ id: string; title: string }> = [
  { id: 'S1', title: 'The four layers' },
  { id: 'S2', title: 'The rule, on the mapping page' },
  { id: 'S3', title: 'Shared state — every coordinate, aliases included' },
  { id: 'S4', title: 'Channel state — band, grid and mapping dock' },
  { id: 'S5', title: 'The preview dock' },
  { id: 'S6', title: 'The collision rule' },
  { id: 'S7', title: 'Changing a variation theme' },
  { id: 'S8', title: 'The catalogue, at thousands of products' },
  { id: 'S9', title: 'How a name and a value resolve' },
  { id: 'S10', title: 'What must change' },
]

function Scenario({ id, title, hint, children }: { id: string; title: string; hint: ReactNode; children?: ReactNode }) {
  return (
    <section className={css.scenario} id={id} data-vx-scenario={id}>
      <h3 className={css.scenarioTitle}>
        {title} <span className={css.scenarioId}>#{id}</span>
      </h3>
      <p className={css.hint}>{hint}</p>
      {children}
    </section>
  )
}

function Stage({ label, flush, children }: { label: ReactNode; flush?: boolean; children: ReactNode }) {
  return (
    <div className={css.stage}>
      <div className={css.stageLabel}>{label}</div>
      <div className={flush ? css.stageFlush : css.stageBody}>{children}</div>
    </div>
  )
}

function Section({ title, aside, hint, children }: { title: ReactNode; aside?: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className={css.section}>
      <h4 className={css.sectionTitle}>
        <span className={css.grow}>{title}</span>
        {aside}
      </h4>
      {hint ? <p className={css.sectionHint}>{hint}</p> : null}
      {children}
    </div>
  )
}

/**
 * A grid host that stays reviewable while the app is not hydrating.
 *
 * 🔴 MEASURED 2026-09-13 on this dev server, and it is NOT this page: **the web app does not
 * hydrate.** No DOM node carries a React fiber, no `useEffect` in any component runs, a real mouse
 * click on a control changes nothing, and every AG grid in the application is therefore blank —
 * `/design/grid-lab` (19 grid wrappers), `/design/language-axis` and the studio alike, all of which
 * predate this file. All 44 client scripts load with HTTP 200 and nothing is logged; the dev server
 * does recompile (verified with a server-rendered marker). So what renders today is server HTML.
 *
 * `NexusGrid` is still mounted below — it is the real design, and the column model above it is what
 * a lane implements. The design-system table beside it is a MIRROR of the same rows, rendered
 * server-side, so the columns, the words and the states are reviewable while that lasts. It is
 * labelled as a mirror rather than presented as the design, and it is unconditional on purpose: a
 * runtime probe for "did the grid start" cannot run at all when effects do not run, and a mirror
 * that sometimes appears is worse than one that always says what it is.
 */
function GridFrame({ children, mirror }: { children: ReactNode; mirror: ReactNode }) {
  return (
    <div className={css.gridHost}>
      {children}
      <div className={css.stageBody}>
        <Banner tone="warning" title="Shown as a table: this dev server is serving server HTML only">
          Measured on this page, on <span className={css.mono}>/design/grid-lab</span> and on{' '}
          <span className={css.mono}>/design/language-axis</span>: the application is not hydrating, so no grid engine
          starts anywhere and no control responds. The two other pages predate this design, so it is not this design.
          The real page uses <span className={css.mono}>NexusGrid</span> with the column model written above; the table
          below is the same fixture in a design-system table, so the columns, the words and the states are reviewable
          while that lasts.
        </Banner>
        {mirror}
      </div>
    </div>
  )
}

/* ── the sixth projection word (design D9) ───────────────────────────────────────────────────── */

/**
 * `Collides` — the member VX.3 adds to `design-system/grid/renderers/projection.ts`.
 *
 * Its tone is READ from `readinessMeta('missing', 'row')` exactly as the five shipped states read
 * theirs, and it renders through the DS's own `.nds-projcell` classes, so what is on screen here is
 * what the DS piece will paint. It earns a member rather than reusing `needs-value` because its next
 * click differs: a missing value is fixed in the cell, a collision is fixed in the mapping dock.
 */
const COLLIDES = {
  tone: readinessMeta('missing', 'row').tone,
  label: 'Collides',
  hint: 'Two included variants produce the same combination on this channel — choose a resolver in the mapping dock',
}

interface SixthFacts {
  state: CellState | null
  detail?: string
  note?: string
  interactive?: boolean
}

/** One projection cell that can render all six words. Identical markup to `ProjectionCell`. */
function projectionCellHtml(facts: SixthFacts, included: boolean | null, onToggle?: (next: boolean) => void) {
  const sixth = facts.state === 'collides'
  const meta = facts.state && !sixth ? projectionMeta(facts.state as ProjectionState) : null
  const tone = sixth ? COLLIDES.tone : meta?.tone
  const label = sixth ? COLLIDES.label : meta?.label
  const dot: 'solid' | 'hollow' | 'none' = sixth ? 'solid' : (meta?.dot ?? 'none')
  const muted = sixth ? false : (meta?.muted ?? false)
  const interactive = facts.interactive ?? (sixth ? true : (meta?.interactive ?? true))
  const held = !interactive
  return (
    <span
      className={['nds-projcell', muted ? 'muted' : '', held ? 'held' : ''].filter(Boolean).join(' ')}
      title={sixth ? COLLIDES.hint : meta?.hint}
    >
      {included != null && (
        <Checkbox
          className="nds-projcell-check"
          checked={included}
          aria-label={label ?? 'Include'}
          aria-disabled={held || undefined}
          title={held ? meta?.hint : undefined}
          onChange={(e) => { if (!held) onToggle?.(e.currentTarget.checked) }}
          onClick={(e) => { if (held) e.preventDefault() }}
        />
      )}
      {dot !== 'none' && <span className={`nds-projcell-dot ${dot}`} data-tone={tone} aria-hidden="true" />}
      {label && <span className="nds-projcell-word">{label}</span>}
      {facts.detail ? <span className="nds-projcell-detail">{facts.detail}</span> : null}
      {facts.note ? <span className="nds-projcell-note">{facts.note}</span> : null}
    </span>
  )
}

/* ── row shapes for the two grids ────────────────────────────────────────────────────────────── */

interface FamilyRow {
  id: string
  sku: string
  isParent: boolean
  /** axisKey → option code. Empty on the parent. */
  values: Record<string, string>
  completeness: number
}

interface ChannelRow {
  id: string
  sku: string
  isParent: boolean
  included: boolean
  values: Record<string, string>
  completeness: number
}

const rowId = (p: { data: { id: string } }) => p.data.id

/* ── the page ────────────────────────────────────────────────────────────────────────────────── */

export function VariationProjectionClient() {
  /* Every scenario's editable state. Nothing leaves this component. */
  const [rules, setRules] = useState<VariationRule[]>(() => RULES.map((r) => ({ ...r, axes: r.axes.map((a) => ({ ...a })) })))
  const [ruleKey, setRuleKey] = useState('AMAZON:DE')
  const [coords, setCoords] = useState<Coordinate[]>(() => COORDINATES.map((c) => ({ ...c, axes: [...c.axes], included: [...c.included] })))
  const [activeCoordKey, setActiveCoordKey] = useState('EBAY:IT:2')
  const [dockTab, setDockTab] = useState<'mapping' | 'preview'>('mapping')
  const [plan, setPlan] = useState<ThemeChangePlan | null>(null)
  const [catFilter, setCatFilter] = useState<CatalogueState | 'all'>('all')
  const [bulkOpen, setBulkOpen] = useState(false)
  const [simulated, setSimulated] = useState<string | null>(null)
  const [probeCoordKey, setProbeCoordKey] = useState('SHOPIFY')

  const activeCoord = coords.find((c) => c.key === activeCoordKey) ?? coords[0]
  const rule = rules.find((r) => `${r.channel}:${r.market}` === ruleKey) ?? rules[0]
  const probeCoord = coords.find((c) => c.key === probeCoordKey) ?? coords[0]

  const patchRule = useCallback((key: string, next: Partial<VariationRule>) => {
    setRules((prev) => prev.map((r) => (`${r.channel}:${r.market}` === key ? { ...r, ...next } : r)))
    setSimulated(null)
  }, [])

  const patchCoord = useCallback((key: string, next: Partial<Coordinate>) => {
    setCoords((prev) => prev.map((c) => (c.key === key ? { ...c, ...next } : c)))
  }, [])

  /* ── S3: the shared-state grid ─────────────────────────────────────────────────────────────── */

  const familyRows = useMemo<FamilyRow[]>(() => [
    { id: PARENT.id, sku: PARENT.sku, isParent: true, values: {}, completeness: PARENT.completeness },
    ...VARIANTS.map((v) => ({ id: v.id, sku: v.sku, isParent: false, values: v.values, completeness: v.completeness })),
  ], [])

  /** A variant's state on a coordinate — the same derivation the projection read would do. */
  const stateOn = useCallback((c: Coordinate, v: Variant): CellState => {
    if (!c.connected) return 'not-set-up'
    if (!c.included.includes(v.id)) return 'excluded'
    if (collisionsOf(c).some((g) => g.variantIds.includes(v.id))) return 'collides'
    if (c.axes.some((k) => !v.values[k])) return 'needs-value'
    return c.externalId ? 'listed' : 'draft'
  }, [])

  const familyColumns = useMemo<Array<ColDef<FamilyRow> | ColGroupDef<FamilyRow>>>(() => [
    {
      headerName: 'PRODUCT',
      children: [{
        colId: 'identity',
        headerName: 'Product',
        width: 360,
        pinned: 'left',
        sortable: false,
        cellRenderer: (p: ICellRendererParams<FamilyRow>) => {
          const d = p.data
          if (!d) return null
          const secondary = d.isParent
            ? `Parent · ${VARIANTS.length} variants`
            : AXES.map((a) => valueLabel(a.key, d.values[a.key])).join(' · ')
          return (
            <IdentityBand
              role={d.isParent ? 'P' : 'C'}
              noImage
              sku={d.sku}
              secondary={secondary}
              secondaryTitle={secondary}
              trailing={<CompletenessPill pct={d.completeness} tip="Required and recommended fields filled on the shared product" />}
            />
          )
        },
      }],
    },
    {
      headerName: 'AXES',
      children: AXES.map((axis): ColDef<FamilyRow> => ({
        colId: `axis:${axis.key}`,
        headerName: axis.label,
        headerTooltip: `The shared ${axis.label.toLowerCase()} axis — a code with the label you see and push`,
        width: 132,
        sortable: true,
        valueGetter: (p) => (p.data && !p.data.isParent ? valueLabel(axis.key, p.data.values[axis.key]) : null),
        cellRenderer: (p: ICellRendererParams<FamilyRow>) => {
          if (!p.data || p.data.isParent) return <span className={css.dropped}>—</span>
          const code = p.data.values[axis.key]
          return (
            <span className={css.rowTight}>
              <span>{valueLabel(axis.key, code)}</span>
              <span className={css.mono} title={`AttributeOption code — the identity behind the label`}>{code}</span>
            </span>
          )
        },
      })),
    },
    {
      headerName: 'CHANNEL PROJECTIONS',
      children: coords.map((c, i): ColDef<FamilyRow> => ({
        colId: `proj:${c.key}`,
        headerName: c.label,
        headerTooltip: c.connected
          ? `${c.axes.length ? c.axes.map((k) => axisByKey(k)?.label).join(' · ') : 'No axes mapped'} — ${c.included.length} of ${VARIANTS.length} included · ${c.source === 'rule' ? `follows the rule “${c.ruleLabel}”` : 'overridden on this listing'}`
          : `${c.label} is not set up — no account is connected`,
        ...(i === coords.length - 1 ? { flex: 1, minWidth: 150 } : { width: 150 }),
        sortable: true,
        valueGetter: (p) => (p.data && !p.data.isParent ? c.included.includes(p.data.id) : null),
        cellRenderer: (p: ICellRendererParams<FamilyRow>) => {
          const d = p.data
          if (!d) return null
          if (d.isParent) {
            if (!c.connected) return projectionCellHtml({ state: 'not-set-up' }, null)
            if (!c.externalId) return projectionCellHtml({ state: 'draft', note: 'no listing yet' }, null)
            return projectionCellHtml({ state: null, detail: c.externalId, note: c.aliasKey ? c.aliasLabel : '1 listing' }, null)
          }
          const v = VARIANTS.find((x) => x.id === d.id)!
          return projectionCellHtml(
            { state: stateOn(c, v), interactive: c.connected },
            c.included.includes(d.id),
            (next) => patchCoord(c.key, {
              included: next ? [...c.included, d.id] : c.included.filter((id) => id !== d.id),
            }),
          )
        },
      })),
    },
  ], [coords, patchCoord, stateOn])

  /* ── S4: the channel-state grid ────────────────────────────────────────────────────────────── */

  const channelRows = useMemo<ChannelRow[]>(() => [
    { id: PARENT.id, sku: PARENT.sku, isParent: true, included: false, values: {}, completeness: PARENT.completeness },
    ...VARIANTS.map((v) => ({
      id: v.id, sku: v.sku, isParent: false,
      included: activeCoord.included.includes(v.id), values: v.values, completeness: v.completeness,
    })),
  ], [activeCoord.included])

  const channelCollisions = useMemo(() => collisionsOf(activeCoord), [activeCoord])

  const channelColumns = useMemo<Array<ColDef<ChannelRow> | ColGroupDef<ChannelRow>>>(() => {
    const includeParams: ProjectionCellParams = {
      facts: (p): ProjectionFacts | null => {
        const d = p.data as ChannelRow | undefined
        if (!d) return null
        if (d.isParent) {
          return activeCoord.externalId
            ? { state: null, detail: activeCoord.externalId, note: '1 listing' }
            : { state: 'draft', note: 'no listing yet' }
        }
        const v = VARIANTS.find((x) => x.id === d.id)!
        const s = stateOn(activeCoord, v)
        /* `collides` is not a DS member yet, so the REAL ProjectionCell is given the nearest shipped
           word and the collision is stated in the band, the chip and the dock. S3 shows the word
           itself. This is the honest split until VX.3 adds the member. */
        return { state: s === 'collides' ? 'needs-value' : (s as ProjectionState) }
      },
      onToggle: (next, p) => {
        const d = p.data as ChannelRow | undefined
        if (!d) return
        patchCoord(activeCoord.key, {
          included: next ? [...activeCoord.included, d.id] : activeCoord.included.filter((id) => id !== d.id),
        })
      },
      label: (p) => `Include ${(p.data as ChannelRow | undefined)?.sku ?? 'this variant'} on ${activeCoord.label}`,
    }

    return [
      {
        headerName: 'PRODUCT',
        children: [{
          colId: 'identity',
          headerName: 'Product',
          width: 330,
          pinned: 'left',
          sortable: false,
          cellRenderer: (p: ICellRendererParams<ChannelRow>) => {
            const d = p.data
            if (!d) return null
            const secondary = d.isParent
              ? `Parent · ${VARIANTS.length} variants`
              : AXES.map((a) => valueLabel(a.key, d.values[a.key])).join(' · ')
            return (
              <IdentityBand
                role={d.isParent ? 'P' : 'C'}
                noImage
                sku={d.sku}
                secondary={secondary}
                secondaryTitle={secondary}
                trailing={<CompletenessPill pct={d.completeness} state={d.included ? 'live' : 'unlisted'} tip={`Fields filled for ${activeCoord.label}`} />}
              />
            )
          },
        }],
      },
      {
        headerName: activeCoord.label.toUpperCase(),
        children: [
          {
            colId: 'included',
            headerName: 'Included',
            width: 110,
            sortable: true,
            valueGetter: (p) => (p.data && !p.data.isParent ? p.data.included : null),
            cellRenderer: ProjectionCell,
            cellRendererParams: includeParams,
          },
          ...activeCoord.axes.map((axisKey, i): ColDef<ChannelRow> => {
            const axis = axisByKey(axisKey)!
            const target = activeCoord.targets[axisKey] ?? axis.label
            return {
              colId: `val:${axisKey}`,
              headerName: axis.label,
              headerTooltip: `The shared ${axis.label} axis lands in the ${activeCoord.label} ${activeCoord.axisNoun} “${target}”. Position ${i + 1}.`,
              width: 168,
              sortable: true,
              valueGetter: (p) => {
                if (!p.data || p.data.isParent) return null
                const v = VARIANTS.find((x) => x.id === p.data!.id)!
                return deliveredValue(activeCoord, v, axisKey).out
              },
              cellRenderer: (p: ICellRendererParams<ChannelRow>) => {
                const d = p.data
                if (!d) return null
                if (d.isParent) return <span className={css.dropped}>—</span>
                const v = VARIANTS.find((x) => x.id === d.id)!
                const del = deliveredValue(activeCoord, v, axisKey)
                const pinned = del.tier === 'pin'
                return (
                  <span className={css.rowTight} title={`${del.out} — ${del.from}`}>
                    <span>{del.out}</span>
                    {pinned
                      ? <Pin size={12} aria-label="Pinned on this listing" />
                      : <Link2 size={12} aria-label={del.from} />}
                    {del.tier === 'map' ? <Tag tone="info">map</Tag> : null}
                  </span>
                )
              },
            }
          }),
          {
            colId: 'listing',
            headerName: 'Listing',
            flex: 1,
            minWidth: 150,
            sortable: true,
            valueGetter: (p) => (p.data && !p.data.isParent ? String(p.data.included) : null),
            cellRenderer: (p: ICellRendererParams<ChannelRow>) => {
              const d = p.data
              if (!d) return null
              if (d.isParent) {
                return projectionCellHtml(
                  activeCoord.externalId
                    ? { state: 'listed', detail: activeCoord.externalId, note: '1 listing' }
                    : { state: 'draft', note: 'no listing yet' },
                  null,
                )
              }
              const v = VARIANTS.find((x) => x.id === d.id)!
              return projectionCellHtml({ state: stateOn(activeCoord, v) }, null)
            },
          },
        ],
      },
    ]
  }, [activeCoord, patchCoord, stateOn])

  /* ── the scope bar's items, shared by S3 and S4 ────────────────────────────────────────────── */

  const scopeItems = useMemo<ScopeBarItem[]>(() => {
    const byChannel = new Map<string, Coordinate[]>()
    for (const c of coords) byChannel.set(c.channel, [...(byChannel.get(c.channel) ?? []), c])
    const state = (list: Coordinate[]): ScopeReadinessState => {
      if (!list.some((c) => c.connected)) return 'absent'
      if (list.some((c) => collisionsOf(c).length > 0)) return 'warn'
      return 'ready'
    }
    return [...byChannel.entries()].map(([channel, list]): ScopeBarItem => {
      const collides = list.some((c) => collisionsOf(c).length > 0)
      return {
        id: channel,
        label: channel === 'AMAZON' ? 'Amazon' : channel === 'EBAY' ? 'eBay' : channel === 'SHOPIFY' ? 'Shopify' : 'Etsy',
        readiness: {
          pct: list.some((c) => c.connected) ? (collides ? 92 : 100) : null,
          state: state(list),
          note: collides
            ? 'A projection on this channel cannot tell every included variant apart'
            : list.some((c) => c.connected)
              ? 'Every projection on this channel keys its variants'
              : 'No account is connected for this channel',
        },
      }
    })
  }, [coords])

  /* ── S6: the collision probe ───────────────────────────────────────────────────────────────── */

  const probeCollisions = useMemo(() => collisionsOf(probeCoord), [probeCoord])
  const probeDropped = droppedAxes(probeCoord)

  const resolverOutcome = (c: Coordinate, resolver: Resolver): string => {
    const groups = collisionsOf(c)
    if (groups.length === 0) return 'Nothing to resolve — the mapped axes already tell every included variant apart.'
    const dropped = droppedAxes(c)[0]
    switch (resolver) {
      case 'split':
        return dropped
          ? `${dropped.values.length} listings — one per ${dropped.label.toLowerCase()} value (${dropped.values.map((v) => v.label).join(', ')}). Held: aliases cannot be created yet.`
          : 'No dropped axis to split on.'
      case 'fold': {
        const into = axisByKey(c.axes[c.axes.length - 1])
        return dropped && into
          ? `${groups.length * 2} values become “${valueLabel(into.key, VARIANTS[0].values[into.key])} / ${dropped.values[0].label}” style pairs on ${into.label}. Writes as a pinned value per variant.`
          : 'No axis to fold into.'
      }
      case 'exclude':
        return `${groups.reduce((n, g) => n + g.variantIds.length - 1, 0)} variants excluded on this coordinate; ${c.included.length - groups.reduce((n, g) => n + g.variantIds.length - 1, 0)} stay included.`
    }
  }

  /* ── render ────────────────────────────────────────────────────────────────────────────────── */

  const preview = PREVIEWS[activeCoord.key] ?? PREVIEWS['EBAY:IT:2']
  const diff = PREVIEW_DIFF[activeCoord.key] ?? PREVIEW_DIFF['EBAY:IT:2']
  const warnings = PREVIEW_WARNINGS[activeCoord.key] ?? []
  const listingsOnCoord = coords.filter((c) => c.channel === activeCoord.channel && c.market === activeCoord.market)
  const catalogueRows = CATALOGUE.filter((r) => catFilter === 'all' || r.state === catFilter)

  return (
    <div className={css.page}>
      <header className={css.head}>
        <span className={css.eyebrow}>Design mock · not built · writes nothing</span>
        <h1 className={css.title}>Variation projection — rules, aliases and delivery</h1>
        <p className={css.lead}>
          Every surface the design proposes, on one family with three axes and seven coordinates. Every control is
          wired to a frozen fixture — untick an axis and the collision report recomputes, change a resolver and the
          outcome changes, switch the listing and the whole channel state re-projects. No API, no database, no writes.
          The design is <span className={css.mono}>docs/2026-09-12-variation-projection-design.md</span>.
        </p>
        <Banner tone="warning" title="On this dev server the page is server HTML: nothing responds to a click yet">
          Measured 2026-09-13: the web application is not hydrating — no component effect runs, a real click changes
          nothing, and every AG grid in the app is blank, on <span className={css.mono}>/design/grid-lab</span> and{' '}
          <span className={css.mono}>/design/language-axis</span> as much as here. Both predate this page, so it is not
          this design. Every surface below is therefore shown in its rendered state, with the grids mirrored into
          design-system tables so the columns and the words can still be read. The wiring is real and takes effect the
          moment the app hydrates again.
        </Banner>
        <div className={css.toc}>
          {SCENARIOS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              <FilterChip>{s.id} · {s.title}</FilterChip>
            </a>
          ))}
        </div>
      </header>

      {/* ── S1 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S1"
        title="The four layers"
        hint="One structure, many projections. A rule is set once per channel category; a family is defined once; a projection is the exception; delivery is read-only. Everything below is one of these four layers, and no fact lives in two of them."
      >
        <Stage label="The model">
          <div className={css.layers}>
            {[
              { name: '1 · Rules', what: 'Theme · axes on channel · targets · collision resolver · split · value maps', where: '/channels/mapping — per channel × market × category', when: 'once per category' },
              { name: '2 · Family', what: 'Axes and values as codes with labels · which children exist', where: 'studio · Variants · shared state', when: 'once per family' },
              { name: '3 · Projection', what: 'Follows the rule OR overridden here · inclusion · pins · order · collisions', where: 'studio · Variants · channel state — per channel × market × account × listing', when: 'exceptions only' },
              { name: '4 · Delivery', what: 'Names in the channel’s words · values verbatim or mapped · the payload', where: 'preview dock — the adapters in dry-run', when: 'read only' },
            ].map((l) => (
              <div key={l.name} className={css.layer}>
                <span className={css.layerName}>{l.name}</span>
                <span className={css.layerWhat}>{l.what}<br /><span className={css.note}>{l.when}</span></span>
                <span className={css.layerWhere}>{l.where}</span>
              </div>
            ))}
          </div>
        </Stage>
        <Stage label="What each channel accepts — the facts the rules are built on">
          <SummaryTable
            label="Channel variation facts"
            columns={['Channel', 'Axes per listing', 'Variants', 'Who names an axis', 'Set per market', 'Change the set on a live listing']}
            rows={CHANNEL_FACTS.map((f) => ({
              id: f.channel,
              cells: [<b key="c">{f.channel}</b>, f.axes, f.variants, f.name, f.setPerMarket, f.change],
            }))}
          />
        </Stage>
      </Scenario>

      {/* ── S2 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S2"
        title="The rule, on the mapping page"
        hint="A new Variations group inside the channel mapping page, under the selected category. This is where the default lives, so the common family stores nothing at all. Change anything and the simulation below recounts before a save."
      >
        <Stage
          label={
            <>
              <span>/channels/mapping</span>
              <Listbox
                size="sm"
                width={220}
                ariaLabel="Channel and market"
                options={rules.map((r) => ({ value: `${r.channel}:${r.market}`, label: `${r.channel === 'AMAZON' ? 'Amazon' : r.channel === 'EBAY' ? 'eBay' : 'Shopify'} · ${r.market} · ${r.categoryLabel}` }))}
                value={ruleKey}
                onChange={setRuleKey}
              />
              <span className={css.grow} />
              <Tag tone="neutral">{rule.follow} follow · {rule.override} override</Tag>
            </>
          }
        >
          <Section
            title="Variations"
            aside={<Button size="sm" variant="ghost">List the {rule.override} overrides</Button>}
            hint={`The default for every ${rule.categoryLabel} family on ${rule.channel === 'AMAZON' ? 'Amazon' : rule.channel === 'EBAY' ? 'eBay' : 'Shopify'} · ${rule.market}. A family that overrides it says so on its own page.`}
          >
            {rule.theme !== null || rule.themeOptions.length > 0 ? (
              <Field label="Theme" hint="Amazon only — the product type’s own enum. The theme fixes the attribute keys the children carry.">
                <Listbox
                  size="sm"
                  width={260}
                  ariaLabel="Variation theme"
                  options={rule.themeOptions.map((o) => ({ value: o, label: o }))}
                  value={rule.theme ?? ''}
                  onChange={(v) => patchRule(ruleKey, { theme: v })}
                />
              </Field>
            ) : null}

            <Field label="Axes on channel" hint="Untick an axis to drop it on this channel. Drag to set the order buyers pick in.">
              <div>
                {rule.axes.map((a, i) => {
                  const axis = axisByKey(a.axisKey)!
                  const opts = TARGET_OPTIONS[rule.channel] ?? []
                  return (
                    <div key={a.axisKey} className={css.mapRow}>
                      <Checkbox
                        checked={a.included}
                        aria-label={`Send ${axis.label} to ${rule.channel}`}
                        onChange={(e) => {
                          const next = rule.axes.map((x) => (x.axisKey === a.axisKey ? { ...x, included: e.currentTarget.checked } : x))
                          patchRule(ruleKey, { axes: next })
                        }}
                      />
                      <span className={css.mapRowGrip} aria-hidden="true"><GripVertical size={13} /></span>
                      <span className={css.mapRowAxis}>{axis.label}</span>
                      <span className={css.mapRowArrow} aria-hidden="true"><ArrowRight size={12} /></span>
                      <span className={css.mapRowGrow}>
                        {a.included ? (
                          rule.freeform ? (
                            <Input
                              size="sm"
                              value={a.target}
                              aria-label={`${rule.channel} option name for ${axis.label}`}
                              onChange={(e) => patchRule(ruleKey, { axes: rule.axes.map((x) => (x.axisKey === a.axisKey ? { ...x, target: e.currentTarget.value } : x)) })}
                            />
                          ) : (
                            <Listbox
                              size="sm"
                              ariaLabel={`${rule.channel} ${rule.axisNameNote ? 'target' : 'target'} for ${axis.label}`}
                              options={opts.map((o) => ({ value: o.code, label: o.label }))}
                              value={a.target}
                              onChange={(v) => patchRule(ruleKey, { axes: rule.axes.map((x) => (x.axisKey === a.axisKey ? { ...x, target: v } : x)) })}
                            />
                          )
                        ) : (
                          <span className={css.dropped}>dropped on this channel</span>
                        )}
                      </span>
                      {i === 0 ? <Tag tone="neutral">first</Tag> : null}
                    </div>
                  )
                })}
              </div>
            </Field>

            <Field label="When variants collide" hint="What to do when the axes this channel receives cannot tell two included variants apart.">
              <div>
                {RESOLVERS.map((r) => (
                  <div key={r.id} className={css.mapRow}>
                    <Radio
                      name={`resolver-${ruleKey}`}
                      checked={rule.collisions.resolver === r.id}
                      onChange={() => patchRule(ruleKey, { collisions: { ...rule.collisions, resolver: r.id } })}
                      label={r.label}
                    />
                    {r.id === 'fold' && rule.collisions.resolver === 'fold' ? (
                      <>
                        <Listbox
                          size="sm"
                          width={120}
                          ariaLabel="Fold into which axis"
                          options={rule.axes.filter((a) => a.included).map((a) => ({ value: a.axisKey, label: axisByKey(a.axisKey)!.label }))}
                          value={rule.collisions.foldInto ?? ''}
                          onChange={(v) => patchRule(ruleKey, { collisions: { ...rule.collisions, foldInto: v } })}
                        />
                        <Input
                          size="sm"
                          width={70}
                          value={rule.collisions.foldSeparator}
                          aria-label="Separator"
                          onChange={(e) => patchRule(ruleKey, { collisions: { ...rule.collisions, foldSeparator: e.currentTarget.value } })}
                        />
                      </>
                    ) : null}
                    {r.heldReason && rule.collisions.resolver === r.id ? <Tag tone="warning">held</Tag> : null}
                  </div>
                ))}
                {RESOLVERS.find((r) => r.id === rule.collisions.resolver)?.heldReason ? (
                  <p className={css.note}>{RESOLVERS.find((r) => r.id === rule.collisions.resolver)!.heldReason}</p>
                ) : (
                  <p className={css.note}>{RESOLVERS.find((r) => r.id === rule.collisions.resolver)!.detail}</p>
                )}
              </div>
            </Field>

            <Field label="Value maps" hint="The only place a market word enters. Reviewed once per channel and market, applied to every product.">
              <div className={css.row}>
                {rule.valueMaps.map((m) => (
                  <Tag key={m.axisKey} tone={m.unreviewed > 0 ? 'warning' : 'neutral'}>
                    {axisByKey(m.axisKey)!.label}: {m.mapped} mapped{m.unreviewed > 0 ? ` · ${m.unreviewed} unreviewed` : ''}
                  </Tag>
                ))}
                <Button size="sm" variant="ghost">Open value maps</Button>
              </div>
            </Field>

            <Field label="Axis names">
              <p className={css.note}>{rule.axisNameNote}</p>
            </Field>

            <div className={css.spread}>
              <span className={css.note}>
                Preview SKU <span className={css.mono}>GALE-JACKET-BLACK-M-SLIM</span> — the same preview dock #S5 shows, for this rule.
              </span>
              <span className={css.row}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    const dropped = rule.axes.filter((a) => !a.included).length
                    setSimulated(
                      `${rule.follow} families follow this rule · ${dropped === 0 ? 'no axis dropped' : `${dropped} axis dropped`} · ${dropped > 0 ? '12 families would gain a collision, resolved by ' + rule.collisions.resolver : '0 new collisions'} · ${rule.override} overrides untouched`,
                    )
                  }}
                >
                  Simulate
                </Button>
                <Button size="sm" variant="primary" disabled={!simulated} title={simulated ? undefined : 'Simulate first — a rule change touches every family that follows it'}>
                  Save rule
                </Button>
              </span>
            </div>
            {simulated ? <Banner tone="info" title="Before this rule saves">{simulated}</Banner> : null}
          </Section>
        </Stage>
      </Scenario>

      {/* ── S3 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S3"
        title="Shared state — every coordinate, aliases included"
        hint="One column per channel × market × listing, so inclusion across every listing is visible on one screen. The two eBay aliases get their own columns. Tick a box and the count and the collisions recompute."
      >
        <Stage label="studio · Variants · scope = master" flush>
          <ScopeBar
            label="SCOPE"
            items={[{ id: 'MASTER', label: 'Shared product', readiness: { pct: 100, state: 'ready' as ScopeReadinessState, note: 'The shared product is the family structure' } }, ...scopeItems]}
            active="MASTER"
            onChange={() => undefined}
            right={
              <>
                <Listbox size="sm" width={128} ariaLabel="Account" options={[{ value: 'b', label: 'Account B' }]} value="b" onChange={() => undefined} />
                <Listbox size="sm" width={104} ariaLabel="Market" options={[{ value: 'IT', label: 'IT' }]} value="IT" onChange={() => undefined} />
              </>
            }
          />
          <div className="nds-pageband">
            <span className="nds-pageband-label">AXES</span>
            <div className="nds-pageband-main">
              {AXES.map((a, i) => (
                <span key={a.key} className={css.rowTight}>
                  {i > 0 ? <span className={css.dropped}>×</span> : null}
                  <AxisChip label={a.label} count={`${a.values.length} values`} />
                </span>
              ))}
              <Button size="sm" variant="ghost">Add axis</Button>
              <span className="nds-pageband-divider" />
              <span className="nds-pageband-note">
                <b>{VARIANTS.length}</b> of {AXES.reduce((n, a) => n * a.values.length, 1)} combinations exist · <b>0</b> missing
              </span>
            </div>
            <div className="nds-pageband-right">
              <Button size="sm" variant="secondary">Generate combinations</Button>
              <Button size="sm" variant="primary">Add variant</Button>
            </div>
          </div>
          <GridToolbar
            count={<><b>{VARIANTS.length + 1}</b> rows · 1 parent · {VARIANTS.length} variants</>}
            right={
              <>
                <Button size="sm" variant="ghost">Customise</Button>
                <Button size="sm" variant="ghost">Export</Button>
                <Button size="sm" variant="ghost">Import</Button>
              </>
            }
          >
            <FilterChip>Excluded somewhere {VARIANTS.filter((v) => coords.some((c) => c.connected && !c.included.includes(v.id))).length}</FilterChip>
            <FilterChip>Collisions {coords.reduce((n, c) => n + collisionsOf(c).length, 0)}</FilterChip>
            <FilterChip>Overridden coordinates {coords.filter((c) => c.source === 'override').length}</FilterChip>
          </GridToolbar>
          <GridFrame
            mirror={
              <SummaryTable
                label="Variants and their projections"
                columns={['Variant', ...AXES.map((a) => a.label), ...coords.map((c) => c.label)]}
                rows={familyRows.map((d) => ({
                  id: d.id,
                  cells: [
                    <span key="i" className={css.rowTight}>
                      <Tag tone="neutral">{d.isParent ? 'P' : 'C'}</Tag>
                      <span className={css.mono}>{d.sku}</span>
                    </span>,
                    ...AXES.map((a) => (d.isParent
                      ? <span key={a.key} className={css.dropped}>—</span>
                      : <span key={a.key} className={css.rowTight}><span>{valueLabel(a.key, d.values[a.key])}</span><span className={css.mono}>{d.values[a.key]}</span></span>)),
                    ...coords.map((c) => {
                      if (d.isParent) {
                        return (
                          <span key={c.key}>
                            {c.connected
                              ? projectionCellHtml(c.externalId ? { state: null, detail: c.externalId } : { state: 'draft' }, null)
                              : projectionCellHtml({ state: 'not-set-up' }, null)}
                          </span>
                        )
                      }
                      const v = VARIANTS.find((x) => x.id === d.id)!
                      return (
                        <span key={c.key}>
                          {projectionCellHtml({ state: stateOn(c, v), interactive: c.connected }, c.included.includes(d.id),
                            (next) => patchCoord(c.key, { included: next ? [...c.included, d.id] : c.included.filter((id) => id !== d.id) }))}
                        </span>
                      )
                    }),
                  ],
                }))}
              />
            }
          >
            <NexusGrid<FamilyRow>
              rows="media-line"
              domLayout="autoHeight"
              rowData={familyRows}
              getRowId={rowId}
              columnDefs={familyColumns}
              suppressCellFocus={false}
              tooltipShowDelay={300}
            />
          </GridFrame>
        </Stage>
        <div className={css.legend}>
          <span><b>The five words the design system ships today</b>, each tone read from <span className={css.mono}>readinessMeta()</span>:</span>
          {/* MX.G 2026-09-13: `ProjectionState` gained the Matrix's four words; this legend is the VX mock's own five, typed as its own `CellState`. */}
          {(['listed', 'draft', 'excluded', 'not-set-up', 'needs-value'] as CellState[]).map((s) => (
            <span key={s} className={css.rowTight}>
              {projectionCellHtml({ state: s }, null)}
            </span>
          ))}
          <span><b>The sixth this design adds</b> (D9), tone read the same way:</span>
          <span className={css.rowTight}>{projectionCellHtml({ state: 'collides' }, null)}</span>
        </div>
        <p className={css.note}>
          <b>Collides</b> earns a member rather than reusing <b>Needs a value</b> because its next click differs: a
          missing value is fixed in the cell, a collision is fixed in the mapping dock. Shopify shows it here because
          it takes Colour and Size while the family also varies by Style.
        </p>
      </Scenario>

      {/* ── S4 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S4"
        title="Channel state — band, grid and mapping dock"
        hint="One listing at a time, chosen in the scope bar. The band says whether this projection follows the rule or overrides it, and counts collisions before a save. The dock is where an axis is dropped, a value pinned and a collision resolved."
      >
        <Stage
          label={
            <>
              <span>studio · Variants · scope = channel</span>
              <span className={css.grow} />
              <SegmentedControl
                options={[{ value: 'mapping', label: 'Mapping dock' }, { value: 'preview', label: 'Preview dock' }]}
                value={dockTab}
                onChange={(v) => setDockTab(v as 'mapping' | 'preview')}
                size="sm"
              />
            </>
          }
          flush
        >
          <ScopeBar
            label="SCOPE"
            items={scopeItems}
            active={activeCoord.channel}
            onChange={(channel) => {
              const first = coords.find((c) => c.channel === channel)
              if (first) setActiveCoordKey(first.key)
            }}
            right={
              <>
                <Listbox size="sm" width={128} ariaLabel="Account" options={[{ value: 'b', label: 'Account B' }]} value="b" onChange={() => undefined} />
                <Listbox
                  size="sm"
                  width={104}
                  ariaLabel="Market"
                  options={[...new Set(coords.filter((c) => c.channel === activeCoord.channel).map((c) => c.market))].map((m) => ({ value: m, label: m }))}
                  value={activeCoord.market}
                  onChange={(m) => {
                    const next = coords.find((c) => c.channel === activeCoord.channel && c.market === m)
                    if (next) setActiveCoordKey(next.key)
                  }}
                />
                {/* NEW — the listing listbox. One listing at a time on the channel state. */}
                <Listbox
                  size="sm"
                  width={148}
                  ariaLabel="Listing"
                  options={[
                    ...listingsOnCoord.map((c) => ({ value: c.key, label: c.aliasLabel })),
                    { value: '__new', label: '+ New listing' },
                  ]}
                  value={activeCoord.key}
                  onChange={(v) => { if (v !== '__new') setActiveCoordKey(v) }}
                />
              </>
            }
          />
          {/* The mapping band, with the two additions: the source word and the collision count. */}
          <div className="nds-pageband">
            <span className="nds-pageband-label">MAPPING</span>
            <div className="nds-pageband-main">
              {activeCoord.axes.map((k) => (
                <MappingChip
                  key={k}
                  from={axisByKey(k)!.label}
                  to={activeCoord.targets[k]}
                  title={`The shared ${axisByKey(k)!.label} axis is the ${activeCoord.label} ${activeCoord.axisNoun} ${activeCoord.targets[k]}`}
                />
              ))}
              <Tag tone="neutral">
                {activeCoord.axes.length}{activeCoord.limitAxes !== null ? ` of ${activeCoord.limitAxes}` : ''} {activeCoord.axisNounPlural}
              </Tag>
              <span className="nds-pageband-divider" />
              {/* NEW — is this the rule, or this listing's own? */}
              <span className={css.bandSource}>
                {activeCoord.source === 'rule'
                  ? <>Follows rule <span className={css.bandSourceStrong}>{activeCoord.ruleLabel}</span></>
                  : <span className={css.bandSourceStrong}>Overridden here</span>}
              </span>
              {/* NEW — collisions, before the save that would create them. */}
              {channelCollisions.length > 0 ? (
                <Tag tone="warning">{channelCollisions.length} collision{channelCollisions.length === 1 ? '' : 's'}</Tag>
              ) : null}
              {droppedAxes(activeCoord).length > 0 ? (
                <span className={css.dropped}>{droppedAxes(activeCoord).map((a) => a.label.toLowerCase()).join(', ')} dropped</span>
              ) : null}
              <span className="nds-pageband-note">
                One listing · <b>{activeCoord.included.length}</b> of {VARIANTS.length} variants included
                {activeCoord.limitVariants !== null ? ` · ${VARIANTS.length} of ${activeCoord.limitVariants} allowed` : ''}
              </span>
            </div>
            <div className="nds-pageband-right">
              <Button size="sm" variant={dockTab === 'mapping' ? 'secondary' : 'ghost'} onClick={() => setDockTab('mapping')}>Edit mapping</Button>
              <Button size="sm" variant={dockTab === 'preview' ? 'secondary' : 'ghost'} onClick={() => setDockTab('preview')}>Preview</Button>
            </div>
          </div>
          <GridToolbar
            count={<><b>{VARIANTS.length + 1}</b> rows · {activeCoord.included.length} included</>}
            right={
              <>
                <Button size="sm" variant="ghost">Customise</Button>
                <Button size="sm" variant="ghost">Export</Button>
                <Button size="sm" variant="ghost">Import</Button>
              </>
            }
          >
            <FilterChip>Excluded {VARIANTS.length - activeCoord.included.length}</FilterChip>
            <FilterChip>Pinned values {VARIANTS.filter((v) => activeCoord.axes.some((k) => deliveredValue(activeCoord, v, k).tier === 'pin')).length}</FilterChip>
            <FilterChip pressed={channelCollisions.length > 0}>Mapping errors {channelCollisions.length}</FilterChip>
          </GridToolbar>
          <div className={css.track}>
            <div className={css.trackMain}>
              <GridFrame
                mirror={
                  <SummaryTable
                    label={`Variants on ${activeCoord.label}`}
                    columns={['Variant', 'Included', ...activeCoord.axes.map((k) => axisByKey(k)!.label), 'Listing']}
                    rows={channelRows.map((d) => {
                      const v = d.isParent ? null : VARIANTS.find((x) => x.id === d.id)!
                      return {
                        id: d.id,
                        cells: [
                          <span key="i" className={css.rowTight}>
                            <Tag tone="neutral">{d.isParent ? 'P' : 'C'}</Tag>
                            <span className={css.mono}>{d.sku}</span>
                          </span>,
                          d.isParent
                            ? <span key="inc" className={css.dropped}>—</span>
                            : <Checkbox
                                key="inc"
                                checked={d.included}
                                aria-label={`Include ${d.sku} on ${activeCoord.label}`}
                                onChange={(e) => patchCoord(activeCoord.key, {
                                  included: e.currentTarget.checked
                                    ? [...activeCoord.included, d.id]
                                    : activeCoord.included.filter((id) => id !== d.id),
                                })}
                              />,
                          ...activeCoord.axes.map((k) => {
                            if (!v) return <span key={k} className={css.dropped}>—</span>
                            const del = deliveredValue(activeCoord, v, k)
                            return (
                              <span key={k} className={css.rowTight} title={`${del.out} — ${del.from}`}>
                                <span>{del.out}</span>
                                {del.tier === 'pin' ? <Pin size={12} aria-label="Pinned" /> : <Link2 size={12} aria-label={del.from} />}
                                {del.tier === 'map' ? <Tag tone="info">map</Tag> : null}
                              </span>
                            )
                          }),
                          <span key="l">
                            {v
                              ? projectionCellHtml({ state: stateOn(activeCoord, v) }, null)
                              : projectionCellHtml(activeCoord.externalId ? { state: 'listed', detail: activeCoord.externalId, note: '1 listing' } : { state: 'draft' }, null)}
                          </span>,
                        ],
                      }
                    })}
                  />
                }
              >
                <NexusGrid<ChannelRow>
                  rows="media-line"
                  domLayout="autoHeight"
                  rowData={channelRows}
                  getRowId={rowId}
                  columnDefs={channelColumns}
                  suppressCellFocus={false}
                  tooltipShowDelay={300}
                />
              </GridFrame>
            </div>
            <aside className={css.trackDock} aria-label={dockTab === 'mapping' ? 'Mapping' : 'Preview'}>
              <div className={css.dockHead}>
                <div className={css.grow}>
                  <h4 className={css.dockTitle}>{activeCoord.label} {dockTab === 'mapping' ? 'mapping' : 'preview'}</h4>
                  <p className={css.dockSub}>GALE-JACKET · {activeCoord.included.length} variants · {activeCoord.aliasLabel}</p>
                </div>
                <SegmentedControl
                  options={[{ value: 'mapping', label: 'Mapping' }, { value: 'preview', label: 'Preview' }]}
                  value={dockTab}
                  onChange={(v) => setDockTab(v as 'mapping' | 'preview')}
                  size="sm"
                />
                <Button size="sm" variant="ghost" aria-label="Close" title="Close"><X size={14} /></Button>
              </div>

              {dockTab === 'mapping' ? (
                <>
                  <div className={css.dockBody}>
                    <Section
                      title={activeCoord.channel === 'AMAZON' ? 'Variation theme' : activeCoord.channel === 'SHOPIFY' ? 'Options' : 'Variation specifics'}
                      hint={`Each shared axis becomes one ${activeCoord.label} ${activeCoord.axisNoun}. Untick one to drop it on this listing. Drag to set the order buyers pick in.`}
                    >
                      {/* NEW — the source row: rule or override, and the way back. */}
                      <div className={css.sourceRow}>
                        {activeCoord.source === 'rule' ? (
                          <>
                            <span>Follows rule <b>{activeCoord.ruleLabel}</b></span>
                            <Button size="sm" variant="ghost" onClick={() => patchCoord(activeCoord.key, { source: 'override' })}>Override</Button>
                          </>
                        ) : (
                          <>
                            <span><b>Overridden here</b></span>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                const r = ruleFor(activeCoord.channel, activeCoord.market)
                                patchCoord(activeCoord.key, {
                                  source: 'rule',
                                  axes: r.axes.filter((a) => a.included).map((a) => a.axisKey),
                                  targets: Object.fromEntries(r.axes.filter((a) => a.included).map((a) => [a.axisKey, a.target])),
                                })
                              }}
                            >
                              Reset to rule
                            </Button>
                          </>
                        )}
                      </div>
                      {activeCoord.channel === 'AMAZON' ? (
                        <Field label="Theme" hint="The product type’s own enum. Changing it is a relist-class operation — see #S7.">
                          <Listbox
                            size="sm"
                            ariaLabel="Variation theme"
                            options={(ruleFor('AMAZON', activeCoord.market).themeOptions).map((o) => ({ value: o, label: o }))}
                            value={activeCoord.theme ?? ''}
                            onChange={(v) => patchCoord(activeCoord.key, { theme: v, source: 'override' })}
                          />
                        </Field>
                      ) : null}
                      {AXES.map((axis) => {
                        const on = activeCoord.axes.includes(axis.key)
                        const opts = TARGET_OPTIONS[activeCoord.channel] ?? []
                        return (
                          <div key={axis.key} className={css.mapRow}>
                            <Checkbox
                              checked={on}
                              aria-label={`Send ${axis.label} to ${activeCoord.label}`}
                              onChange={(e) => {
                                const next = e.currentTarget.checked
                                  ? [...activeCoord.axes, axis.key]
                                  : activeCoord.axes.filter((k) => k !== axis.key)
                                patchCoord(activeCoord.key, { axes: next, source: 'override' })
                              }}
                            />
                            <span className={css.mapRowGrip} aria-hidden="true"><GripVertical size={13} /></span>
                            <span className={css.mapRowAxis}>{axis.label}</span>
                            <span className={css.mapRowArrow} aria-hidden="true"><ArrowRight size={12} /></span>
                            <span className={css.mapRowGrow}>
                              {on ? (
                                opts.length ? (
                                  <Listbox
                                    size="sm"
                                    ariaLabel={`${activeCoord.label} ${activeCoord.axisNoun} for ${axis.label}`}
                                    options={opts.map((o) => ({ value: o.code, label: o.label }))}
                                    value={activeCoord.targets[axis.key] ?? ''}
                                    onChange={(v) => patchCoord(activeCoord.key, { targets: { ...activeCoord.targets, [axis.key]: v }, source: 'override' })}
                                  />
                                ) : (
                                  <Input
                                    size="sm"
                                    value={activeCoord.targets[axis.key] ?? ''}
                                    aria-label={`${activeCoord.label} option name for ${axis.label}`}
                                    onChange={(e) => patchCoord(activeCoord.key, { targets: { ...activeCoord.targets, [axis.key]: e.currentTarget.value }, source: 'override' })}
                                  />
                                )
                              ) : (
                                <span className={css.dropped}>dropped on this channel</span>
                              )}
                            </span>
                          </div>
                        )
                      })}
                    </Section>

                    <Section title="Values" hint="Values follow the shared axis value. A value map may convert one per market; a pin changes one variant on this listing only.">
                      <SummaryTable
                        label="Values on this coordinate"
                        columns={['Shared', `On ${activeCoord.label}`, 'Included']}
                        rows={activeCoord.axes.flatMap((k) =>
                          axisByKey(k)!.values.map((val) => {
                            const sample = VARIANTS.find((v) => v.values[k] === val.code)!
                            const del = deliveredValue(activeCoord, sample, k)
                            const n = VARIANTS.filter((v) => v.values[k] === val.code && activeCoord.included.includes(v.id)).length
                            return {
                              id: `${k}:${val.code}`,
                              cells: [
                                <span key="s" className={css.rowTight}><span>{val.label}</span><span className={css.mono}>{val.code}</span></span>,
                                <span key="o" className={css.rowTight}>
                                  <span>{del.out}</span>
                                  {del.tier === 'pin' ? <Tag tone="info">pinned</Tag> : del.tier === 'map' ? <Tag tone="info">map</Tag> : null}
                                </span>,
                                String(n),
                              ],
                            }
                          }),
                        )}
                      />
                    </Section>

                    {/* NEW — the collision section, between Values and Listing split. */}
                    <Section
                      title="Collisions"
                      aside={channelCollisions.length > 0 ? <Tag tone="warning">{channelCollisions.length}</Tag> : <Tag tone="success">none</Tag>}
                      hint={channelCollisions.length > 0 ? `The ${activeCoord.axes.length} mapped ${activeCoord.axisNounPlural} cannot tell these included variants apart. Choose a resolver, or the save is refused.` : undefined}
                    >
                      {channelCollisions.length === 0 ? (
                        <p className={css.note}>No collisions on this listing.</p>
                      ) : (
                        <>
                          {channelCollisions.map((g) => (
                            <div key={g.keyLabel} className={css.section}>
                              <span className={css.rowTight}>
                                <Tag tone="warning">{g.keyLabel}</Tag>
                                <span className={css.note}>{g.variantIds.length} variants share this combination</span>
                              </span>
                              <ul className={css.listTight}>
                                {g.skus.map((s) => <li key={s} className={css.mono}>{s}</li>)}
                              </ul>
                            </div>
                          ))}
                          {RESOLVERS.map((r) => (
                            <div key={r.id} className={css.mapRow}>
                              <Radio
                                name={`dock-resolver-${activeCoord.key}`}
                                checked={(ruleFor(activeCoord.channel, activeCoord.market).collisions.resolver) === r.id}
                                onChange={() => patchRule(`${activeCoord.channel}:${activeCoord.market}`, {
                                  collisions: { ...ruleFor(activeCoord.channel, activeCoord.market).collisions, resolver: r.id },
                                })}
                                label={r.label}
                                aria-describedby={r.heldReason ? `held-${r.id}` : undefined}
                              />
                              {r.heldReason ? <Tag tone="warning">held</Tag> : null}
                            </div>
                          ))}
                          <p className={css.note}>{resolverOutcome(activeCoord, ruleFor(activeCoord.channel, activeCoord.market).collisions.resolver)}</p>
                        </>
                      )}
                    </Section>

                    <Section title="Listing split" hint="How this family lands on the channel.">
                      <div className={css.mapRow}>
                        <Radio name={`split-${activeCoord.key}`} defaultChecked label={`One listing — ${activeCoord.included.length}${activeCoord.limitVariants !== null ? ` of ${activeCoord.limitVariants}` : ''} variants`} />
                      </div>
                      <div className={css.mapRow}>
                        <Radio name={`split-${activeCoord.key}`} aria-disabled label={`One listing per ${droppedAxes(activeCoord)[0]?.label.toLowerCase() ?? 'axis'}`} />
                        <Tag tone="warning">held</Tag>
                      </div>
                      <p className={css.note}>{RESOLVERS.find((r) => r.id === 'split')!.heldReason}</p>
                    </Section>

                    {activeCoord.externalId ? (
                      <Banner tone="warning" title={`${activeCoord.axisNounPlural[0].toUpperCase()}${activeCoord.axisNounPlural.slice(1)} lock once the listing is live`}>
                        Item {activeCoord.externalId} is live with {activeCoord.axes.map((k) => activeCoord.targets[k]).join(' and ')}.
                        Adding or removing {activeCoord.axisNoun === 'option' ? 'an option' : `a ${activeCoord.axisNoun}`} relists it; reordering and adding values do not.
                      </Banner>
                    ) : null}
                  </div>
                  <div className={css.dockFoot}>
                    <Button size="sm" variant="ghost">Cancel</Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={channelCollisions.length > 0}
                      title={channelCollisions.length > 0 ? `${channelCollisions.length} unresolved collision${channelCollisions.length === 1 ? '' : 's'} — the projection would not key every included variant` : undefined}
                    >
                      Save mapping
                    </Button>
                  </div>
                </>
              ) : (
                <PreviewDock coord={activeCoord} preview={preview} diff={diff} warnings={warnings} />
              )}
            </aside>
          </div>
        </Stage>
        <p className={css.note}>
          <b>Try it:</b> untick <b>Style</b> on Amazon · DE and the band gains a collision count, the Save button holds
          with its reason, and the Collisions section names the variants that clash. Switch the listing to <b>③ Nero</b>
          and one axis carries ten variants. Every number recomputes from the fixture.
        </p>
      </Scenario>

      {/* ── S5 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S5"
        title="The preview dock"
        hint="What actually goes live, in the same 420px track. It calls the publish adapters in dry-run, so the payload shown is the payload sent — a second renderer of the rules would be a defect. Buyer view, payload and a diff against the last publish."
      >
        <Stage label={`${activeCoord.label} · the adapters in dry-run — switch the listing in #S4`}>
          <div className={css.two}>
            <Card>
              <PreviewDock coord={activeCoord} preview={preview} diff={diff} warnings={warnings} embedded />
            </Card>
            <div className={css.section}>
              <Banner tone="info" title="Why the preview must run the engine">
                The payload is composed by the same functions the publish path calls, with the client in dry-run and no
                HTTP. A test pins preview ≡ live by calling one function from both sides, so a second composer cannot
                appear without failing it.
              </Banner>
              <SummaryTable
                label="What the preview reads"
                columns={['Channel', 'Composer', 'Diff source']}
                rows={[
                  { id: 'a', cells: ['Amazon', 'buildChildAttributes plus the parent envelope', 'The last submission snapshot'] },
                  { id: 'e', cells: ['eBay', 'The push’s Variations composer', '__lastPublishedAxes for this market'] },
                  { id: 's', cells: ['Shopify', 'The productSet input builder', 'The read-back'] },
                ]}
              />
            </div>
          </div>
        </Stage>
      </Scenario>

      {/* ── S6 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S6"
        title="The collision rule"
        hint="The check the projection save does not do today. A projection must key its variants: the mapped axes have to tell every included variant apart. Pick a coordinate, drop an axis, and watch the groups appear."
      >
        <Stage
          label={
            <>
              <span>The probe</span>
              <Listbox
                size="sm"
                width={200}
                ariaLabel="Coordinate"
                options={coords.filter((c) => c.connected).map((c) => ({ value: c.key, label: `${c.label} · ${c.aliasLabel}` }))}
                value={probeCoordKey}
                onChange={setProbeCoordKey}
              />
              <span className={css.grow} />
              {probeCollisions.length > 0
                ? <Tag tone="warning">{probeCollisions.length} collision{probeCollisions.length === 1 ? '' : 's'}</Tag>
                : <Tag tone="success">keys every variant</Tag>}
            </>
          }
        >
          <div className={css.row}>
            <span className={css.note}>Axes this coordinate receives:</span>
            {AXES.map((axis) => {
              const on = probeCoord.axes.includes(axis.key)
              return (
                <FilterChip
                  key={axis.key}
                  pressed={on}
                  onClick={() => patchCoord(probeCoord.key, {
                    axes: on ? probeCoord.axes.filter((k) => k !== axis.key) : [...probeCoord.axes, axis.key],
                    source: 'override',
                  })}
                  title={on ? `Drop ${axis.label} on ${probeCoord.label}` : `Send ${axis.label} to ${probeCoord.label}`}
                >
                  {axis.label}
                </FilterChip>
              )
            })}
            {probeDropped.length > 0 ? <span className={css.dropped}>{probeDropped.map((a) => a.label.toLowerCase()).join(', ')} dropped</span> : null}
          </div>

          <div className={css.chain}>
            <span className={css.chainStep}>key(v) =</span>
            {probeCoord.axes.length === 0 ? <span className={css.chainStep}>nothing — every variant collides</span> : null}
            {probeCoord.axes.map((k, i) => (
              <span key={k} className={css.rowTight}>
                {i > 0 ? <span className={css.chainArrow} aria-hidden="true"><span className={css.dropped}>·</span></span> : null}
                <span className={`${css.chainStep} ${css.chainStepWins}`}>{axisByKey(k)!.label}</span>
              </span>
            ))}
          </div>

          {probeCollisions.length === 0 ? (
            <Banner tone="success" title="This projection keys its variants">
              Each of the {probeCoord.included.length} included variants produces a different combination on {probeCoord.label}.
            </Banner>
          ) : (
            <>
              <Banner tone="warning" title={`${probeCollisions.length} group${probeCollisions.length === 1 ? '' : 's'} cannot be told apart on ${probeCoord.label}`}>
                A buyer choosing one of these combinations would land on an arbitrary one of the variants. The save is
                refused until a resolver is chosen.
              </Banner>
              <SummaryTable
                label="Collision groups"
                columns={['Combination on the channel', 'Variants that share it']}
                rows={probeCollisions.map((g) => ({
                  id: g.keyLabel,
                  cells: [
                    <Tag key="k" tone="warning">{g.keyLabel}</Tag>,
                    <span key="v" className={css.mono}>{g.skus.join(' · ')}</span>,
                  ],
                }))}
              />
            </>
          )}

          <Divider />
          <Section title="The three resolvers" hint="Each writes through a path that already exists — no new write path for a value, and no silent exclusion.">
            {RESOLVERS.map((r) => (
              <Card key={r.id}>
                <div className={css.spread}>
                  <span className={css.rowTight}>
                    <b>{r.label}</b>
                    {r.heldReason ? <Tag tone="warning">held</Tag> : <Tag tone="neutral">available</Tag>}
                  </span>
                </div>
                <p className={css.note}>{r.detail}</p>
                <p className={css.note}><b>On {probeCoord.label} now:</b> {resolverOutcome(probeCoord, r.id)}</p>
                {r.heldReason ? <p className={css.note}>{r.heldReason}</p> : null}
              </Card>
            ))}
          </Section>
        </Stage>
      </Scenario>

      {/* ── S7 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S7"
        title="Changing a variation theme"
        hint="It is a real operation and it differs per channel. Never a cell edit: a named operation with a dry-run plan that says what it keeps and what it loses. In this programme the plan is all that exists — the live executor is a separate approval, and you run the first one."
      >
        <Stage label="The ⋯ menu on the channel state">
          <div className={css.two}>
            {PLANS.map((p) => (
              <Card key={p.kind}>
                <div className={css.spread}>
                  <span className={css.rowTight}>
                    <b>{p.title}</b>
                    <Tag tone="neutral">{p.coordinate}</Tag>
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setPlan(p)}>Open the plan</Button>
                </div>
                <p className={css.note}>
                  <span className={css.mono}>{p.from}</span> → <span className={css.mono}>{p.to}</span>
                </p>
                <p className={css.note}>
                  {p.steps.length} steps · {p.steps.some((s) => !s.reversible) ? 'one step cannot be undone' : 'every step reversible'}
                </p>
              </Card>
            ))}
          </div>
        </Stage>
        <Modal
          open={plan !== null}
          onClose={() => setPlan(null)}
          size="lg"
          title={plan ? `${plan.title} · ${plan.coordinate}` : ''}
          subtitle={plan ? <span className={css.mono}>{plan.from} → {plan.to}</span> : undefined}
          footer={
            <>
              <span className={css.note}>Dry run only. Nothing is sent.</span>
              <span className={css.grow} />
              <Button size="sm" variant="ghost" onClick={() => setPlan(null)}>Close</Button>
              <Button size="sm" variant="secondary">Copy plan</Button>
            </>
          }
        >
          {plan ? (
            <div className={css.section}>
              <div className={css.planSteps}>
                {plan.steps.map((s) => (
                  <div key={s.n} className={css.planStep}>
                    <span className={css.planStepN}>{s.n}</span>
                    <span className={css.rowTight}>
                      <Tag tone={s.reversible ? 'neutral' : 'danger'}>{s.verb}</Tag>
                    </span>
                    <span>
                      <span className={css.mono}>{s.target}</span>
                      <span className={css.planStepDetail}>{s.detail}{s.reversible ? '' : ' · cannot be undone'}</span>
                    </span>
                  </div>
                ))}
              </div>
              <div className={css.keepsLoses}>
                <div>
                  <b>Keeps</b>
                  <ul className={css.listTight}>{plan.keeps.map((k) => <li key={k}>{k}</li>)}</ul>
                </div>
                <div>
                  <b>Loses</b>
                  <ul className={css.listTight}>{plan.loses.map((k) => <li key={k}>{k}</li>)}</ul>
                </div>
              </div>
              <Banner tone="info" title="Why this shape">{plan.note}</Banner>
            </div>
          ) : null}
        </Modal>
      </Scenario>

      {/* ── S8 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S8"
        title="The catalogue, at thousands of products"
        hint="Because the default lives in a rule, the common family stores nothing and the per-product dock handles exceptions only. The catalogue is where the rule is applied in bulk and where the exceptions are found."
      >
        <Stage label="/products/next">
          <GridToolbar
            count={<><b>{catalogueRows.length}</b> of {CATALOGUE.length} families</>}
            right={<Button size="sm" variant="secondary" onClick={() => setBulkOpen(true)} disabled={catalogueRows.length === 0}>Apply mapping rule…</Button>}
          >
            <span className={css.note}>Variation mapping</span>
            {CATALOGUE_FILTERS.map((f) => (
              <FilterChip key={f.id} pressed={catFilter === f.id} onClick={() => setCatFilter(f.id)}>
                {f.label} {f.id === 'all' ? CATALOGUE.length : CATALOGUE.filter((r) => r.state === f.id).length}
              </FilterChip>
            ))}
          </GridToolbar>
          <SummaryTable
            label="Families"
            columns={['SKU', 'Product', 'Variants', 'Variation mapping', 'Where']}
            rows={catalogueRows.map((r) => ({
              id: r.id,
              cells: [
                <span key="s" className={css.mono}>{r.sku}</span>,
                r.name,
                String(r.variants),
                <Pill
                  key="p"
                  tone={r.state === 'collides' ? 'warning' : r.state === 'missing' || r.state === 'theme-unset' ? 'danger' : r.state === 'overridden' ? 'info' : 'success'}
                  dot
                >
                  {CATALOGUE_FILTERS.find((f) => f.id === r.state)!.label}
                </Pill>,
                <span key="d" className={css.note}>{r.detail}</span>,
              ],
            }))}
          />
          <p className={css.note}>
            Readiness carries four new items per coordinate, which is what these filters read: mapping missing,
            collision, unreviewed value map, theme unset.
          </p>
        </Stage>
        <Modal
          open={bulkOpen}
          onClose={() => setBulkOpen(false)}
          size="md"
          title="Apply mapping rule"
          subtitle={`${BULK_DRY_RUN.families} families selected`}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setBulkOpen(false)}>Cancel</Button>
              <Button size="sm" variant="primary">Apply to {BULK_DRY_RUN.families - BULK_DRY_RUN.skipped.length} families</Button>
            </>
          }
        >
          <div className={css.section}>
            <Banner tone="info" title="The dry run, before anything is written">
              <b>{BULK_DRY_RUN.families}</b> families · <b>{BULK_DRY_RUN.overridesRemoved}</b> overrides removed ·{' '}
              <b>{BULK_DRY_RUN.newCollisions}</b> new collisions
            </Banner>
            <Section title="Skipped, and why" hint="A family with an unresolved collision is listed and left alone — never quietly rewritten.">
              <SummaryTable
                label="Skipped families"
                columns={['SKU', 'Reason']}
                rows={BULK_DRY_RUN.skipped.map((s) => ({ id: s.sku, cells: [<span key="s" className={css.mono}>{s.sku}</span>, s.reason] }))}
              />
            </Section>
            <p className={css.note}>Each family is written with its own compare-and-set on the listing version, so a concurrent edit conflicts instead of being overwritten.</p>
          </div>
        </Modal>
      </Scenario>

      {/* ── S9 ───────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S9"
        title="How a name and a value resolve"
        hint="Axis names are the channel's vocabulary, never a translation. Values are pushed verbatim unless a reviewed value map converts them, and the cell shows the outbound word — so you know what goes out before opening the preview."
      >
        <Stage label="The two chains">
          <Section title="The axis NAME on a coordinate">
            <div className={css.chain}>
              <span className={css.chainStep}>a pinned name on this listing</span>
              <span className={css.chainArrow} aria-hidden="true"><ChevronRight size={13} /></span>
              <span className={css.chainStep}>eBay and Etsy: the site’s aspect for this category</span>
              <span className={css.chainArrow} aria-hidden="true"><ChevronRight size={13} /></span>
              <span className={css.chainStep}>Shopify: the English label</span>
              <span className={css.chainArrow} aria-hidden="true"><ChevronRight size={13} /></span>
              <span className={css.chainStep}>Amazon: the theme decides, Amazon prints it</span>
            </div>
            <SummaryTable
              label="The same axis, named per coordinate"
              columns={['Coordinate', 'Colour is called', 'Where the name came from']}
              rows={coords.filter((c) => c.axes.includes('color')).map((c) => {
                const d = deliveredAxisName(c, 'color')
                return { id: c.key, cells: [c.label + (c.aliasKey ? ` · ${c.aliasLabel}` : ''), <b key="n">{d.name}</b>, <span key="s" className={css.note}>{d.source}</span>] }
              })}
            />
          </Section>
          <Divider />
          <Section title="The axis VALUE on a coordinate">
            <div className={css.chain}>
              <span className={css.chainStep}>a pin on this variant’s listing row</span>
              <span className={css.chainArrow} aria-hidden="true"><ChevronRight size={13} /></span>
              <span className={css.chainStep}>the value map for this channel and market</span>
              <span className={css.chainArrow} aria-hidden="true"><ChevronRight size={13} /></span>
              <span className={css.chainStep}>the value map for this channel</span>
              <span className={css.chainArrow} aria-hidden="true"><ChevronRight size={13} /></span>
              <span className={`${css.chainStep} ${css.chainStepWins}`}>the value’s own label — pushed verbatim</span>
            </div>
            <SummaryTable
              label="One variant’s colour, delivered per coordinate"
              columns={['Coordinate', 'Stored', 'Pushed', 'Tier', 'The mark says']}
              rows={coords.filter((c) => c.axes.includes('color')).map((c) => {
                const v = VARIANTS.find((x) => x.values.color === 'yellow')!
                const d = deliveredValue(c, v, 'color')
                return {
                  id: c.key,
                  cells: [
                    c.label + (c.aliasKey ? ` · ${c.aliasLabel}` : ''),
                    <span key="s" className={css.rowTight}><span>Giallo</span><span className={css.mono}>yellow</span></span>,
                    <b key="o">{d.out}</b>,
                    <Tag key="t" tone={d.tier === 'label' ? 'neutral' : 'info'}>{d.tier === 'label' ? 'verbatim' : d.tier}</Tag>,
                    <span key="f" className={css.rowTight}>
                      <SourceIndicator
                        kind={d.tier === 'pin' ? 'override' : d.tier === 'map' ? 'rule' : 'master'}
                        label={d.tier === 'pin' ? 'Pinned' : d.tier === 'map' ? 'Value map' : 'Shared'}
                        description={d.from}
                      />
                      <span className={css.note}>{d.from}</span>
                    </span>,
                  ],
                }
              })}
            />
            <Banner tone="info" title="Why verbatim is the default">
              One stored value per variant means the cell you read is the word the channel receives. A map is a
              deliberate, reviewed exception per channel and market — not a per-product translation. The cost is that a
              German buyer reads “Nero” until a colour map for DE is reviewed, and on eBay a non-aspect value sits
              outside the site’s filters.
            </Banner>
          </Section>
        </Stage>
      </Scenario>

      {/* ── S10 ──────────────────────────────────────────────────────────────────────────────── */}
      <Scenario
        id="S10"
        title="What must change"
        hint="Every store and path the design touches, what it is today and what it becomes. All of it is additive: no column is dropped and no existing reader is broken without a characterisation test saying so."
      >
        <Stage label="The change table">
          <SummaryTable
            label="Changes"
            columns={['Store or path', 'Today', 'After', 'Lane']}
            rows={CHANGES.map((c) => ({
              id: c.store,
              cells: [<b key="s">{c.store}</b>, <span key="t" className={css.note}>{c.today}</span>, c.after, <Tag key="l" tone="neutral">{c.lane}</Tag>],
            }))}
          />
        </Stage>
        <Stage label="Order of work">
          <SummaryTable
            label="Lanes"
            columns={['Lane', 'Mandate', 'Starts when']}
            rows={[
              { id: 'vx1', cells: [<b key="l">VX.1</b>, 'Contracts, the rule block, the collision rule, the preview, the dry-run plans, the eBay precedence flip, the Shopify publisher', 'Now'] },
              { id: 'vx2', cells: [<b key="l">VX.2</b>, 'The Variations group on the mapping page', 'When VX.1 publishes its contracts'] },
              { id: 'vx3', cells: [<b key="l">VX.3</b>, 'The studio: listing listbox, band, dock, preview, the sixth word', 'Only after VP.F reports done'] },
              { id: 'vx4', cells: [<b key="l">VX.4</b>, 'Catalogue filters, the bulk verb, the four readiness items', 'When VX.1 publishes its contracts'] },
              { id: 'vxf', cells: [<b key="l">VX.F</b>, 'Before and after tables, the functionality matrix, every gate, delete the test family', 'When the four report done'] },
            ]}
          />
          <Disclosure summary="Three decisions gate the rest">
            <ul className={css.listTight}>
              <li><b>D1</b> — the eBay axis set moves to the listing row, which is what makes a set per market and per alias possible. Byte-identical today, and a characterisation test proves it.</li>
              <li><b>D3</b> — the default collision resolver. Fold until aliases can be created, then split.</li>
              <li><b>D8</b> — the live theme-change executor stays out of this programme. Plans only.</li>
            </ul>
          </Disclosure>
        </Stage>
      </Scenario>
    </div>
  )
}

/* ── the preview dock, used in the track (S4) and on its own (S5) ────────────────────────────── */

function PreviewDock({
  coord, preview, diff, warnings, embedded,
}: {
  coord: Coordinate
  preview: { format: string; parent: string; child: string }
  diff: { lastPublishedAxes: string[] | null; added: string[]; removed: string[]; renamed: Array<[string, string]> }
  warnings: string[]
  embedded?: boolean
}) {
  const [side, setSide] = useState<'parent' | 'child'>('child')
  const sample = VARIANTS.find((v) => coord.included.includes(v.id)) ?? VARIANTS[0]

  const body = (
    <>
      {warnings.length > 0 ? (
        <Banner tone="warning" title={`${warnings.length} warning from the adapter`}>
          {warnings.map((w) => <div key={w}>{w}</div>)}
        </Banner>
      ) : null}

      <Section title="Buyer view" hint={`What a buyer sees on ${coord.label}, in that market's words.`}>
        <div className={css.buyer}>
          {coord.axes.length === 0 ? (
            <span className={css.dropped}>No axes are mapped, so this listing has no variations.</span>
          ) : coord.axes.map((k) => {
            const name = deliveredAxisName(coord, k)
            const values = [...new Set(
              VARIANTS.filter((v) => coord.included.includes(v.id)).map((v) => deliveredValue(coord, v, k).out),
            )]
            return (
              <div key={k} className={css.buyerAxis}>
                <span className={css.buyerName} title={name.source}>{name.name}</span>
                <span className={css.buyerValues}>
                  {values.map((val) => <Tag key={val} tone="neutral">{val}</Tag>)}
                </span>
              </div>
            )
          })}
        </div>
        <p className={css.note}>
          Sample <span className={css.mono}>{sample.sku}</span> — {coord.axes.map((k) => `${deliveredAxisName(coord, k).name} ${deliveredValue(coord, sample, k).out}`).join(' · ')}
        </p>
      </Section>

      <Section
        title="Payload"
        aside={
          <SegmentedControl
            options={[{ value: 'parent', label: 'Parent' }, { value: 'child', label: 'Child' }]}
            value={side}
            onChange={(v) => setSide(v as 'parent' | 'child')}
            size="sm"
          />
        }
        hint={<>Format <span className={css.mono}>{preview.format}</span> — composed by the publish adapter in dry-run, not by this panel.</>}
      >
        <pre className={css.code}>{side === 'parent' ? preview.parent : preview.child}</pre>
      </Section>

      <Section title="Changes since last publish">
        {diff.lastPublishedAxes === null ? (
          <p className={css.note}>This coordinate has never published, so there is nothing to compare against.</p>
        ) : (
          <SummaryTable
            label="Diff"
            columns={['', 'What']}
            rows={[
              { id: 'added', cells: ['Added', diff.added.length ? <span key="a" className={css.mono}>{diff.added.join(', ')}</span> : <span key="a" className={css.dropped}>—</span>] },
              { id: 'removed', cells: ['Removed', diff.removed.length ? <span key="r" className={css.mono}>{diff.removed.join(', ')}</span> : <span key="r" className={css.dropped}>—</span>] },
              { id: 'renamed', cells: ['Renamed', diff.renamed.length ? <span key="n" className={css.mono}>{diff.renamed.map(([a, b]) => `${a} → ${b}`).join(', ')}</span> : <span key="n" className={css.dropped}>—</span>] },
            ]}
          />
        )}
      </Section>
    </>
  )

  if (embedded) return <div className={css.section}>{body}</div>

  return (
    <>
      <div className={css.dockBody}>{body}</div>
      <div className={css.dockFoot}>
        <Button size="sm" variant="ghost">Copy payload</Button>
      </div>
    </>
  )
}
