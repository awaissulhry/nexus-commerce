'use client'

/**
 * CHMAP — one mapping version: what it is, what can be done to it, and one row per channel column.
 *
 * Honest states: every read shows loading, then its data or the server's own sentence. Nothing is
 * changed on screen before the server answers — a decision, an activation or a retirement repaints
 * from the version the server returns, never from what was asked for.
 *
 * Only a DRAFT changes. An ACTIVE or RETIRED version is read-only; "New version from this" is the way
 * to change one (the server refuses an edit to it with 409, and that sentence is shown as it is).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Search } from 'lucide-react'
import {
  activationBlocker, type MappingDiff, type MappingFieldRow, type MappingPushImpact, type MappingSetDetail, type MappingSetSummary,
} from '@nexus/shared/channel-mapping'
import { Button, FilterChip, Input, Pill, Tag } from '@/design-system/primitives'
import {
  AsOf, Banner, Card, Listbox, MetricStrip, SummaryTable, useActionConfirm, useToast,
} from '@/design-system/components'
import { GridPager } from '@/design-system/grid'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { formatDate, num } from '@/design-system/lib/format'
import {
  activateMappingSet, diffMappingSets, errorText, newMappingVersion, readMappingSet, readMappingTargets, readPushImpact, retireMappingSet,
  type MappingUse,
} from './api'
import {
  changedKeys, DECIDED_BY_WORD, DIRECTION_WORD, exportBlocker, filterCounts, filterRows, formLabel, formSourceWord, isLocked, pageOf, pushImpactReview, requirementWord, siblingsOf,
  STATE_WORD, stateTone, STATUS_TONE, STATUS_WORD, targetLabel, transformSummary, USE_WORD, useCount, versionName,
  type FieldFilter,
} from './model'
import { DecisionDrawer, type TargetsState } from './DecisionDrawer'
import { CompareDrawer } from './CompareDrawer'
import { ExportDrawer } from './ExportDrawer'
import styles from './files.module.css'

const DEFAULT_PAGE_SIZE = 100
const FILTER_WORD: Record<Exclude<FieldFilter, 'changed'>, string> = {
  all: 'All', unmapped: 'Unmapped', required: 'Required', ignored: 'Ignored', managed: 'Managed',
}

interface Loaded { set: MappingSetDetail; uses: MappingUse[] }
type BaseDiff = { status: 'none' } | { status: 'loading' } | { status: 'ready'; diff: MappingDiff } | { status: 'error'; error: string }

export function VersionDetail({ setId, sets, stores = [], onSelect, onListChanged }: {
  setId: string
  sets: MappingSetSummary[]
  /** NCF — the connected Shopify stores, to name a Shopify version's store. */
  stores?: { id: string; label: string }[]
  onSelect: (id: string | null) => void
  onListChanged: () => void
}) {
  const { toast } = useToast()
  const confirm = useActionConfirm()

  /* ── the version ──────────────────────────────────────────────────────────────────────────── */
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoadError(null)
    readMappingSet(setId, controller.signal)
      .then(result => { if (!controller.signal.aborted) setData(result) })
      .catch(error => { if (!controller.signal.aborted) setLoadError(errorText(error)) })
    return () => controller.abort()
  }, [setId, reload])

  const set = data?.set ?? null

  /* ── what changed since the version it was copied from ────────────────────────────────────── */
  const [baseDiff, setBaseDiff] = useState<BaseDiff>({ status: 'none' })
  const basedOnId = set?.basedOnId ?? null
  useEffect(() => {
    if (!set || !basedOnId) { setBaseDiff({ status: 'none' }); return }
    const controller = new AbortController()
    setBaseDiff({ status: 'loading' })
    diffMappingSets(set.id, basedOnId, controller.signal)
      .then(diff => { if (!controller.signal.aborted) setBaseDiff({ status: 'ready', diff }) })
      .catch(error => { if (!controller.signal.aborted) setBaseDiff({ status: 'error', error: errorText(error) }) })
    return () => controller.abort()
  }, [set, basedOnId])

  /* ── the fields a column can map to (loaded once, when the decision drawer first needs them) ─ */
  const [targets, setTargets] = useState<TargetsState>({ status: 'idle' })
  const alive = useRef(true)
  // Set true on EVERY mount: StrictMode mounts, unmounts and mounts again, and a ref only cleared in the
  // cleanup stayed false after that first cycle — every targets answer was dropped ("Loading…" forever).
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const loadTargets = useCallback(() => {
    setTargets({ status: 'loading' })
    readMappingTargets(setId)
      .then(r => { if (alive.current) setTargets({ status: 'ready', targets: r.targets, missingSchemas: r.missingSchemas }) })
      .catch(error => { if (alive.current) setTargets({ status: 'error', error: errorText(error) }) })
  }, [setId])

  /* ── filters ──────────────────────────────────────────────────────────────────────────────── */
  const [filter, setFilter] = useState<FieldFilter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const fields = useMemo(() => set?.fields ?? [], [set])
  const changed = useMemo(() => changedKeys(baseDiff.status === 'ready' ? baseDiff.diff : null), [baseDiff])
  const counts = useMemo(() => filterCounts(fields, changed), [fields, changed])
  const visible = useMemo(() => filterRows(fields, filter, query, changed), [fields, filter, query, changed])
  const paged = pageOf(visible, page, pageSize)
  const chooseFilter = (next: FieldFilter) => { setFilter(next); setPage(1) }

  /* ── panels and actions ───────────────────────────────────────────────────────────────────── */
  const [deciding, setDeciding] = useState<string | null>(null)
  const [compareWith, setCompareWith] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [busy, setBusy] = useState<null | 'version' | 'checkActivate' | 'activate' | 'checkRetire' | 'retire'>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const siblings = useMemo(() => (set ? siblingsOf(set, sets) : []), [set, sets])
  const basedOn = useMemo(() => (basedOnId ? sets.find(s => s.id === basedOnId) ?? null : null), [sets, basedOnId])
  const activeSibling = siblings.find(s => s.status === 'ACTIVE') ?? null
  const blocker = useMemo(() => (set ? activationBlocker(set.fields) : null), [set])
  const editable = set?.status === 'DRAFT'
  const hasProductTypes = fields.some(f => f.productTypes.length > 0)

  const applySet = useCallback((next: MappingSetDetail) => {
    setData(current => (current ? { set: next, uses: current.uses } : current))
    onListChanged()
  }, [onListChanged])

  const makeVersion = async () => {
    if (!set) return
    setBusy('version'); setActionError(null)
    try {
      const next = await newMappingVersion(set.id)
      toast(`v${next.version} was made as a draft from v${set.version}.`, 'success')
      onListChanged()
      onSelect(next.id)
    } catch (error) { setActionError(errorText(error)) } finally { setBusy(null) }
  }

  const activate = async () => {
    if (!set) return
    // CHMAP M4 — the push follows the active version: read what it would start or stop sending before asking.
    setBusy('checkActivate'); setActionError(null)
    let impact: MappingPushImpact | null = null, failure: string | undefined
    try { impact = await readPushImpact(set.id) } catch (error) { failure = errorText(error) } finally { setBusy(null) }
    const push = pushImpactReview(set, impact, failure)
    const ok = await confirm.ask({
      level: 'confirm', reach: 'local',
      title: `Activate v${set.version} of ${formLabel(set)}?`,
      ...(impact ? { asOf: new Date().toISOString() } : {}),
      consequences: [
        `Files of this form are read and written with v${set.version}.`,
        activeSibling ? `v${activeSibling.version}, the active version today, is retired.` : 'No other version of this form is active today.',
        `v${set.version} can no longer be changed; a new version is the way to change it.`,
        ...push.consequences,
      ],
      review: push.review,
      findings: push.findings,
      reversal: activeSibling ? { verb: `Activate v${activeSibling.version}`, fidelity: 'exact' } : { verb: `Retire v${set.version}`, fidelity: 'exact' },
    })
    if (!ok) return
    setBusy('activate'); setActionError(null)
    try {
      applySet(await activateMappingSet(set.id))
      toast(`v${set.version} is active.`, 'success')
    } catch (error) { setActionError(errorText(error)) } finally { setBusy(null) }
  }

  const retire = async () => {
    if (!set) return
    // Retiring the ACTIVE version: the push stops following it, so the fields it stopped are sent again.
    let push: ReturnType<typeof pushImpactReview> = { consequences: [], findings: [] }, checked = false
    if (set.status === 'ACTIVE') {
      setBusy('checkRetire'); setActionError(null)
      let impact: MappingPushImpact | null = null, failure: string | undefined
      try { impact = await readPushImpact(set.id, 'retire') } catch (error) { failure = errorText(error) } finally { setBusy(null) }
      push = pushImpactReview(set, impact, failure); checked = impact != null
    }
    const ok = await confirm.ask({
      level: 'confirm', reach: 'local',
      title: `Retire v${set.version} of ${formLabel(set)}?`,
      ...(checked ? { asOf: new Date().toISOString() } : {}),
      consequences: [
        set.status === 'ACTIVE' ? `This form has no active version until another one is activated.` : `This draft can no longer be changed.`,
        `v${set.version} stays in the list and can be activated again.`,
        ...push.consequences,
      ],
      review: push.review,
      findings: push.findings,
      reversal: { verb: `Activate v${set.version}`, fidelity: 'exact' },
    })
    if (!ok) return
    setBusy('retire'); setActionError(null)
    try {
      applySet(await retireMappingSet(set.id))
      toast(`v${set.version} is retired.`, 'success')
    } catch (error) { setActionError(errorText(error)) } finally { setBusy(null) }
  }

  /* ── the column grid ──────────────────────────────────────────────────────────────────────── */
  const channel = set?.channel
  const columns = useMemo<Column<MappingFieldRow>[]>(() => [
    {
      key: 'column', label: 'Column', width: 260,
      render: r => (
        <span className={styles.stack}>
          <span className={styles.cellText}>{r.label ?? r.channelKey}</span>
          <span className={styles.key}>{r.channelKey}</span>
        </span>
      ),
    },
    {
      key: 'requirement', label: 'Requirement', width: 150,
      render: r => (
        <span className={styles.stack}>
          <span className={styles.cellText}>{requirementWord(r.requirement)}</span>
          {r.templateRequirement && <span className={styles.cellSub}>Template: {r.templateRequirement}</span>}
        </span>
      ),
    },
    {
      key: 'decision', label: 'Decision', width: 170,
      render: r => (
        <span className={styles.versionLine}>
          <Pill tone={stateTone(r)} size="sm">{STATE_WORD[r.state]}</Pill>
          {isLocked(r) && <Tag>Locked</Tag>}
        </span>
      ),
    },
    {
      key: 'target', label: 'Target', width: 240,
      render: r => {
        const transform = transformSummary(r.transform)
        return (
          <span className={styles.stack}>
            <span className={styles.cellText}>{targetLabel(r, channel)}</span>
            {transform && r.state === 'mapped' && <span className={styles.cellSub}>{transform}</span>}
            {r.state === 'mapped' && r.direction !== 'both' && <span className={styles.cellSub}>{DIRECTION_WORD[r.direction]}</span>}
          </span>
        )
      },
    },
    { key: 'reason', label: 'Reason', width: 280, render: r => <span className={styles.cellText}>{r.reason ?? '—'}</span> },
    { key: 'decidedBy', label: 'Decided by', width: 110, render: r => DECIDED_BY_WORD[r.decidedBy] ?? r.decidedBy },
    ...(hasProductTypes ? [{
      key: 'productTypes', label: 'Product types', width: 140,
      render: (r: MappingFieldRow) => (r.productTypes.length ? r.productTypes.join(', ') : 'All'),
    }] : []),
    {
      key: 'action', label: 'Action', width: 110,
      render: r => {
        const verb = editable && !isLocked(r) ? 'Decide' : 'View'
        return <Button size="xs" variant={verb === 'Decide' ? 'secondary' : 'quiet'} aria-label={`${verb}: ${r.label ?? r.channelKey}`} onClick={() => setDeciding(r.channelKey)}>{verb}</Button>
      },
    },
    // `set` is a dependency on purpose: the DS DataGrid repaints a row whose data changed under the same
    // rowKey only when `columns` changes identity (its value getters are constant here, so AG sees no
    // change). Without it a saved decision updated the counters and left the row showing the old one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [channel, editable, hasProductTypes, set])

  /* ── render ───────────────────────────────────────────────────────────────────────────────── */
  if (loadError && !data) {
    return (
      <Banner tone="danger" title="This mapping version could not load"
        action={<><Button size="sm" onClick={() => setReload(n => n + 1)}>Try again</Button> <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>Close</Button></>}>
        {loadError}
      </Banner>
    )
  }
  if (!set) return <p className={styles.plain} role="status">Loading the mapping version…</p>

  const c = set.counts
  const cannotExport = exportBlocker(set)
  const decidingRow = deciding ? fields.find(f => f.channelKey === deciding) ?? null : null
  const compareSet = compareWith ? sets.find(s => s.id === compareWith) ?? null : null
  const changedLabel = basedOn ? `Changed vs ${versionName(basedOn, set)}` : 'Changed vs previous version'
  const removedCount = baseDiff.status === 'ready' ? baseDiff.diff.removed.length : 0

  return (
    <>
      {/* ── header ── */}
      <div className={styles.detailHead}>
        <div className={styles.titleRow}>
          <h2 className={styles.title}>{formLabel(set)}</h2>
          <Pill tone="neutral" size="sm">v{set.version}</Pill>
          <Pill tone={STATUS_TONE[set.status]} size="sm">{STATUS_WORD[set.status]}</Pill>
        </div>
        <div className={styles.meta}>
          <span>{set.channel === 'SHOPIFY' ? formSourceWord(set, stores) : `Template version ${set.templateVersion ?? 'not stated'}`}</span>
          {set.templateIdentifier && <span>Template ID <span className={styles.key}>{set.templateIdentifier}</span></span>}
          {set.language && <span>Language {set.language}</span>}
          <span>{num(c.fields)} columns</span>
          <span>Created {formatDate(set.createdAt)}</span>
          {set.activatedAt && <span>Activated {formatDate(set.activatedAt)}</span>}
          {set.retiredAt && <span>Retired {formatDate(set.retiredAt)}</span>}
          {basedOnId && (basedOn
            ? <span>Copied from <Button variant="link" inline onClick={() => onSelect(basedOn.id)}>{versionName(basedOn, set)}</Button></span>
            : <span>Copied from a version that is not in this list</span>)}
        </div>
        {set.notes && <p className={styles.notes}>{set.notes}</p>}

        <div className={styles.actions}>
          <Button size="sm" variant="primary" disabled={busy != null} onClick={() => void makeVersion()}>
            {busy === 'version' ? 'Making a new version…' : 'New version from this'}
          </Button>
          {(set.status === 'DRAFT' || set.status === 'RETIRED') && (
            <Button size="sm" variant="success" disabled={busy != null || blocker != null} aria-describedby={blocker ? `${set.id}-blocker` : undefined} onClick={() => void activate()}>
              {busy === 'checkActivate' ? 'Checking…' : busy === 'activate' ? 'Activating…' : 'Activate'}
            </Button>
          )}
          {(set.status === 'ACTIVE' || set.status === 'DRAFT') && (
            <Button size="sm" variant="danger-outline" disabled={busy != null} onClick={() => void retire()}>
              {busy === 'checkRetire' ? 'Checking…' : busy === 'retire' ? 'Retiring…' : 'Retire'}
            </Button>
          )}
          <Button size="sm" disabled={busy != null || cannotExport != null} aria-describedby={cannotExport ? `${set.id}-export` : undefined} onClick={() => setExporting(true)}>
            <Download size={14} aria-hidden /> Export a file
          </Button>
          <div className={styles.compare}>
            <Listbox size="sm" ariaLabel="Compare with another version of this form" placeholder="Compare with…"
              disabled={siblings.length === 0} value={compareWith ?? undefined}
              options={siblings.map(s => ({ value: s.id, label: `v${s.version} · ${STATUS_WORD[s.status]}` }))}
              onChange={value => setCompareWith(value || null)} />
          </div>
        </div>
        {cannotExport && <p className={styles.plain} id={`${set.id}-export`}>Export: {cannotExport}</p>}
        {siblings.length === 0 && <p className={styles.plain}>This is the only version of this form, so there is nothing to compare with.</p>}
        {blocker && (set.status === 'DRAFT' || set.status === 'RETIRED') && (
          <Banner tone="warning" title="Activation is blocked"
            action={<Button size="sm" onClick={() => chooseFilter('required')}>Show required columns</Button>}>
            <span id={`${set.id}-blocker`}>{blocker}</span>
          </Banner>
        )}
        {actionError && <Banner tone="danger" title="That was refused" onDismiss={() => setActionError(null)}>{actionError}</Banner>}
      </div>

      {/* ── counters ── */}
      <MetricStrip metrics={[
        {
          label: 'Required unmapped', accent: 'var(--nds-danger)',
          value: <span className={c.requiredUnmapped > 0 ? styles.dangerFigure : undefined}>{num(c.requiredUnmapped)}</span>,
          hint: c.requiredUnmapped > 0 ? 'Blocks activation' : 'Nothing blocks activation',
        },
        { label: 'Conditionally required unmapped', value: num(c.conditionalUnmapped), hint: 'Required if relevant' },
        { label: 'Unmapped', value: num(c.unmapped), hint: 'Nobody decided yet' },
        { label: 'Ignored', value: num(c.ignored), hint: 'Skipped, with a reason' },
        { label: 'Managed elsewhere', value: num(c.managed), hint: 'Another workflow owns it' },
        { label: 'Mapped', value: num(c.mapped), hint: `of ${num(c.fields)} columns` },
      ]} />

      {/* ── filters ── */}
      <div className={styles.filters}>
        <div className={styles.chips} role="group" aria-label="Show columns">
          {(Object.keys(FILTER_WORD) as Exclude<FieldFilter, 'changed'>[]).map(f => (
            <FilterChip key={f} pressed={filter === f} count={num(counts[f])} onClick={() => chooseFilter(f)}>{FILTER_WORD[f]}</FilterChip>
          ))}
          {basedOnId && (
            <FilterChip pressed={filter === 'changed'} disabled={baseDiff.status !== 'ready'}
              count={baseDiff.status === 'ready' ? num(counts.changed) : baseDiff.status === 'loading' ? '…' : '—'}
              onClick={() => chooseFilter('changed')}>{changedLabel}</FilterChip>
          )}
        </div>
        <div className={styles.search}>
          <Input size="sm" type="search" value={query} leadingIcon={<Search size={14} aria-hidden />}
            onChange={event => { setQuery(event.target.value); setPage(1) }}
            placeholder="Search key, label or target" aria-label="Search columns" />
        </div>
      </div>
      {baseDiff.status === 'error' && <p className={styles.filterNote} role="alert">The comparison with {basedOn ? versionName(basedOn, set) : 'the earlier version'} could not load: {baseDiff.error}</p>}
      {filter === 'changed' && removedCount > 0 && (
        <p className={styles.filterNote}>{num(removedCount)} column{removedCount === 1 ? ' was' : 's were'} removed since {basedOn ? versionName(basedOn, set) : 'the earlier version'}; removed columns are not in this version. Use Compare to see them.</p>
      )}
      {!editable && (
        <Banner tone="info" title={`v${set.version} is ${STATUS_WORD[set.status].toLowerCase()}, so its columns are read-only`}>
          Make a new version to change this.
        </Banner>
      )}

      {/* ── one row per column ── */}
      <div>
        <DataGrid<MappingFieldRow>
          ariaLabel={`Columns of ${formLabel(set)} v${set.version}`}
          size="sm"
          keyboardScroll
          columns={columns}
          rows={paged.rows}
          rowKey={r => r.channelKey}
          emptyState={fields.length === 0 ? 'This version has no columns.' : 'No column matches these filters.'}
        />
        <GridPager
          page={paged.page} pageCount={paged.pageCount} pageSize={pageSize}
          onPage={setPage} onPageSize={size => { setPageSize(size); setPage(1) }}
          left={<span className={styles.plain} role="status">{visible.length ? `Showing ${num(paged.from)}–${num(paged.to)} of ${num(visible.length)} columns` : `0 of ${num(fields.length)} columns`}</span>}
        />
      </div>

      {/* ── recent uses ── */}
      <Card header="Recent uses" headingLevel={3} description="The last imports, exports and pushes that read this version.">
        {data!.uses.length === 0 ? (
          <p className={styles.plain}>No import, export or push has used this version yet.</p>
        ) : (
          <div className={styles.tableScroll}>
            <SummaryTable label={`Recent uses of v${set.version}`}
              columns={['Use', 'File or sheet', 'Rows', 'Excluded', 'Refused', 'When']}
              rows={data!.uses.map(use => ({
                id: use.id,
                cells: [
                  USE_WORD[use.action] ?? use.action,
                  use.reference ?? 'Not recorded',
                  countCell(useCount(use.detail, 'rows')),
                  countCell(useCount(use.detail, 'excluded')),
                  countCell(useCount(use.detail, 'refused')),
                  <AsOf key="when" at={use.createdAt} kind="event" />,
                ],
              }))} />
          </div>
        )}
      </Card>

      {decidingRow && (
        <DecisionDrawer
          key={`${set.id}:${decidingRow.channelKey}`}
          set={set}
          row={decidingRow}
          targets={targets}
          onNeedTargets={loadTargets}
          onClose={() => setDeciding(null)}
          onMakeVersion={set.status === 'DRAFT' ? undefined : () => { setDeciding(null); void makeVersion() }}
          onSaved={(next, sentence) => { applySet(next); setDeciding(null); toast(sentence, 'success') }}
        />
      )}
      {exporting && <ExportDrawer set={set} onClose={() => setExporting(false)} onTemplateUploaded={() => onListChanged()} />}
      {compareSet && <CompareDrawer current={set} other={compareSet} onClose={() => setCompareWith(null)} />}
      {confirm.element}
    </>
  )
}

const countCell = (value: number | null) => (value == null ? 'Not recorded' : num(value))
