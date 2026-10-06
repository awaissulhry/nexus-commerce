'use client'

/**
 * CR rebuild 2 — Who acts: every engine and rule that can change the Amazon ads, in one design-system grid. Replaces
 * the old Levers tab (13 hand-built engine cards, then a separate rules list with its own notches).
 *
 * The products list's shape: a toolbar with the count, a search and the filters; one grid; a row opens its own side
 * panel. The Show filter is the same split as the top tiles (a tile click sets it). Filtering happens HERE, not in AG's
 * quick filter, so a filter with no match shows this page's own empty state with Clear filters.
 *
 * Nothing on the list writes. Every change is in a side panel and asks first.
 */
import { memo, useCallback, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Button, Input, Pill, type Tone } from '@/design-system/primitives'
import { Banner, Listbox, type ListboxOption } from '@/design-system/components'
import { GridToolbar, StepUpModal } from '@/design-system/patterns'
import { claudeApi } from '@/app/settings/ai/claude/claudeApi'

import {
  GridCard,
  GridLoadingOverlay,
  GridNoRowsOverlay,
  GridSearchSlot,
  NexusGrid,
  type ColDef,
  type ICellRendererParams,
  type NexusGridProps,
} from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { ClaudeKindDrawer, type ClaudeCodeStep } from './ClaudeKindDrawer'
import { CLAUDE_WORD, claudeName, claudeRaiseText } from './claudeKinds'
import { EngineDrawer } from './EngineDrawer'
import { RuleDrawer } from './RuleDrawer'
import { LEVEL_WORD } from './levelWords'
import { tabHref } from './roomTabs'
import { agoWords } from './timeWords'
import {
  KIND_LABEL, SHOW_LABEL, countWords, isFiltered, isKindFilter, isShowFilter, marketsOf, rowMatches, NO_FILTER,
  type ActorRow, type Engine, type NowBucket, type Readiness, type Rule, type WhoFilter,
} from './whoActs'
import styles from './room.module.css'

type Cell = ICellRendererParams<ActorRow>

const BUCKET_TONE: Record<NowBucket, Tone> = { alone: 'success', asks: 'info', quiet: 'neutral' }

const NameCell = memo(function NameCell({ data: row }: Cell) {
  if (!row) return null
  return (
    <span className={styles.cell}>
      <span className={styles.cellMain}>{row.name}</span>
      <span className={styles.cellSub} title={row.what}>{row.what}</span>
    </span>
  )
})

const InForceCell = memo(function InForceCell({ data: row }: Cell) {
  if (!row) return null
  return (
    <span className={styles.cellInline}>
      <Pill tone={BUCKET_TONE[row.bucket]} size="sm" dot>{row.inForceWord ?? LEVEL_WORD[row.inForce]}</Pill>
      <span className={styles.cellSub} title={row.why}>{row.why}</span>
    </span>
  )
})

const ProblemCell = memo(function ProblemCell({ data: row }: Cell) {
  if (!row?.problem) return <span className={styles.muted}>—</span>
  return <span title={row.problem}><Pill tone="warning" size="sm">{row.problem}</Pill></span>
})

const COLUMNS: ColDef<ActorRow>[] = [
  { colId: 'name', headerName: 'Name', field: 'name', flex: 2, minWidth: 230, cellRenderer: NameCell },
  { colId: 'kind', headerName: 'Type', field: 'kind', width: 90, valueFormatter: (p) => (p.value === 'engine' ? 'Engine' : p.value === 'claude' ? 'Claude' : 'Rule') },
  { colId: 'market', headerName: 'Market', field: 'market', width: 110, valueFormatter: (p) => (p.value ? String(p.value) : 'Every market') },
  { colId: 'setTo', headerName: 'Set to', field: 'setTo', width: 130 },
  // The widest column: the level in force AND why, in one line — the question every row answers first.
  { colId: 'inForce', headerName: 'May do now', field: 'why', flex: 3, minWidth: 320, cellRenderer: InForceCell },
  // Claude's kinds have no runs of their own (each request is its own run): a dash, never a false "never".
  { colId: 'lastRun', headerName: 'Last run', field: 'lastRunAt', width: 110, valueFormatter: (p) => (p.data?.kind === 'claude' ? '—' : agoWords((p.value as string | null) ?? null)) },
  { colId: 'week', headerName: 'Last 7 days', field: 'week', flex: 1, minWidth: 160 },
  { colId: 'problem', headerName: 'Problem', field: 'problem', flex: 1, minWidth: 140, cellRenderer: ProblemCell },
]

const ROW_ID: NonNullable<NexusGridProps<ActorRow>['getRowId']> = (p) => p.data.id
const LOADING_PARAMS = { rows: 8 }
const SHOW_OPTIONS: ListboxOption[] = (Object.keys(SHOW_LABEL) as Array<keyof typeof SHOW_LABEL>).map((value) => ({ value, label: SHOW_LABEL[value] }))
const KIND_OPTIONS: ListboxOption[] = (Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>).map((value) => ({ value, label: KIND_LABEL[value] }))

export function WhoActsGrid({ rows, error, claudeError, readiness, protectedTerms, filter, onFilter, onRetry, onEnginesChanged, onRulesChanged, onClaudeChanged }: {
  /** null while the first read runs — or when it failed (`error` then says why: never shown as a loading list). */
  rows: ActorRow[] | null
  error: string | null
  onRetry: () => void
  /** Claude's levels could not be read: the list shows engines and rules only, and says so. */
  claudeError: string | null
  readiness: ReadonlyMap<string, Readiness>
  /** null = unknown. */
  protectedTerms: number | null
  filter: WhoFilter
  onFilter: (f: WhoFilter) => void
  onEnginesChanged: () => void
  onRulesChanged: () => void
  onClaudeChanged: () => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  // A raise of a Claude kind (or Resume) asks for the code in a Modal, which would open behind a drawer: the drawer
  // steps aside while the code is asked, and opens again after.
  const [codeAsk, setCodeAsk] = useState<{ rowId: string; step: ClaudeCodeStep; busy: boolean; error: string | null } | null>(null)
  const [claudeDone, setClaudeDone] = useState<string | null>(null)

  const all = useMemo(() => rows ?? [], [rows])
  const shown = useMemo(() => all.filter((r) => rowMatches(r, filter)), [all, filter])
  const marketOptions = useMemo<ListboxOption[]>(
    () => [{ value: 'all', label: 'Every market' }, ...marketsOf(all).map((m) => ({ value: m, label: m }))],
    [all],
  )
  const open = openId ? all.find((r) => r.id === openId) ?? null : null
  const hasRules = all.some((r) => r.kind === 'rule')

  const clear = useCallback(() => onFilter(NO_FILTER), [onFilter])
  const noRowsParams = useMemo(
    () => (rows === null && error
      ? { title: 'The list could not be read', message: error, action: { label: 'Try again', onClick: onRetry } }
      : rows && rows.length > 0
        ? { title: 'Nothing matches these filters', message: 'Clear the filters to see every engine, rule and Claude kind.', action: { label: 'Clear filters', onClick: clear } }
        : { title: 'Nothing can change your ads here', message: 'No engine, rule or Claude kind was found.' }),
    [rows, error, clear, onRetry],
  )
  const onRowClicked = useCallback<NonNullable<NexusGridProps<ActorRow>['onRowClicked']>>((e) => { if (e.data) setOpenId(e.data.id) }, [])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<ActorRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key === 'Enter' && e.data) setOpenId(e.data.id)
  }, [])

  return (
    <div className={styles.stack}>
      {error && <Banner tone="danger" title="The list could not be read">{error}</Banner>}
      {claudeError && <Banner tone="warning" title="Claude’s levels could not be read">The list shows the engines and rules only. {claudeError}</Banner>}

      {hasRules && protectedTerms === 0 && (
        // The link sits in the text, not in the banner's side slot: on a phone the slot squeezed the text to one word a line.
        <Banner tone="warning" title="No protected terms are set">
          Rules that block search terms stay at Ask me until you protect your brand terms.{' '}
          <Button asChild size="sm" variant="link"><Link href={tabHref('limits', 'terms')}>Protect your terms</Link></Button>
        </Banner>
      )}

      <GridCard
        toolbar={(
          <GridToolbar
            count={rows ? countWords(shown.length, all.length, isFiltered(filter)) : 'Reading…'}
            right={(
              <span className={styles.toolbarRight}>
                <Listbox size="sm" width={170} ariaLabel="Show" options={SHOW_OPTIONS} value={filter.show} onChange={(v) => { if (isShowFilter(v)) onFilter({ ...filter, show: v }) }} />
                <Listbox size="sm" width={170} ariaLabel="Type" options={KIND_OPTIONS} value={filter.kind} onChange={(v) => { if (isKindFilter(v)) onFilter({ ...filter, kind: v }) }} />
                <Listbox size="sm" width={150} ariaLabel="Market" options={marketOptions} value={filter.market} onChange={(v) => onFilter({ ...filter, market: v })} />
              </span>
            )}
          >
            <GridSearchSlot>
              <Input
                size="sm"
                type="search"
                aria-label="Search engines, rules and Claude"
                placeholder="Search"
                leadingIcon={<Search size={14} aria-hidden />}
                value={filter.search}
                onChange={(e) => onFilter({ ...filter, search: e.target.value })}
              />
            </GridSearchSlot>
          </GridToolbar>
        )}
      >
        <NexusGrid<ActorRow>
          domLayout="autoHeight"
          suppressCellFocus={false}
          rowData={shown}
          getRowId={ROW_ID}
          columnDefs={COLUMNS}
          loading={rows === null && !error}
          loadingOverlayComponent={GridLoadingOverlay}
          loadingOverlayComponentParams={LOADING_PARAMS}
          noRowsOverlayComponent={GridNoRowsOverlay}
          noRowsOverlayComponentParams={noRowsParams}
          onRowClicked={onRowClicked}
          onCellKeyDown={onCellKeyDown}
        />
      </GridCard>

      <span className={styles.muted}>Click a row, or press Enter on it, to see and change its settings. Nothing changes until you confirm.</span>

      {open?.kind === 'engine' && open.engine && (
        <EngineDrawer row={open as ActorRow & { engine: Engine }} onClose={() => setOpenId(null)} onChanged={onEnginesChanged} />
      )}
      {open?.kind === 'claude' && open.claude && !codeAsk && (
        <ClaudeKindDrawer
          row={open as ActorRow & { claude: NonNullable<ActorRow['claude']> }}
          done={claudeDone}
          onClose={() => { setOpenId(null); setClaudeDone(null) }}
          onChanged={onClaudeChanged}
          onCode={(step) => { setClaudeDone(null); setCodeAsk({ rowId: open.id, step, busy: false, error: null }) }}
        />
      )}
      {(() => {
        const asked = codeAsk ? all.find((r) => r.id === codeAsk.rowId)?.claude?.rule : undefined
        const step = codeAsk?.step
        const text = asked && step
          ? step.kind === 'level'
            ? claudeRaiseText(asked, step.to)
            : { title: 'Resume Claude’s changes by rule', sentence: 'Changes set to Auto run by your rule again, inside their limits and the ads strategy — in every part of Nexus.', confirmLabel: 'Resume' }
          : null
        return (
          <StepUpModal
            open={!!(codeAsk && asked)}
            title={text?.title ?? ''}
            sentence={text?.sentence ?? ''}
            confirmLabel={text?.confirmLabel ?? 'Confirm'}
            busy={!!codeAsk?.busy}
            error={codeAsk?.error ?? null}
            onClose={() => { if (!codeAsk?.busy) setCodeAsk(null) }}
            onSubmit={(code) => {
              if (!codeAsk || !asked || !step) return
              const ask = codeAsk
              setCodeAsk({ ...ask, busy: true, error: null })
              const sent = step.kind === 'level'
                ? claudeApi.setRule(asked.name, { level: step.to, code }).then(() => `“${claudeName(asked)}” is at ${CLAUDE_WORD[step.to]} for new requests.`)
                : claudeApi.resume(code).then(() => 'Claude’s changes by rule run again.')
              sent.then(
                (done) => { setCodeAsk(null); setClaudeDone(done); onClaudeChanged() },
                (e: unknown) => setCodeAsk({ ...ask, busy: false, error: e instanceof Error ? e.message : String(e) }),
              )
            }}
          />
        )
      })()}
      {open?.kind === 'rule' && open.rule && (
        <RuleDrawer row={open as ActorRow & { rule: Rule }} readiness={readiness.get(open.rule.id)} onClose={() => setOpenId(null)} onChanged={onRulesChanged} />
      )}
    </div>
  )
}
