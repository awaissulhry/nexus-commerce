'use client'

/**
 * CR rebuild 5 — Campaigns: what automation may touch on each campaign. Replaces the old Guardrails tab's grid (ACR.1.3b)
 * with the products list's shape: counts that filter, a toolbar with search and filters, one grid, a side panel per row.
 *
 * Nothing on this tab writes on a click. Every edit fills a draft; "Review N changes…" shows one table old → new; a
 * change that lets automation touch more needs the tick; then Save sends the PATCHes one by one and says per change
 * what saved and what was refused. The account's brakes, protected terms and the server's own limits are on Limits.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Button, Checkbox, Input, SegmentedControl } from '@/design-system/primitives'
import { Banner, Field, Listbox, MetricStrip, Modal, SummaryTable, type ListboxOption } from '@/design-system/components'
import { EditModeBar, GridToolbar } from '@/design-system/patterns'
import { GridCard, GridSearchSlot, GridSelectionActions, type NexusGridProps } from '@/design-system/grid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { CampaignDrawer } from './CampaignDrawer'
import { CampaignLimitsGrid, type GridHandlers, type GridRow } from './CampaignLimitsGrid'
import {
  ALLOWED_LABEL, GAP_LABEL, LOCKED_LABEL, NO_CAMPAIGN_FILTER, PARTS, PART_WORD,
  applyBulk, campaignMatches, conflictsOf, dropSaved, isAllowedFilter, isCampaignFiltered, isGapFilter, isLockedFilter,
  parseMoney, problemsOf, refusalOf, requestsFor, retidy, reviewGroups, reviewLines, saveWords, setEdit, skipReason, valuesOf,
  type BulkOp, type CampaignEdit, type CampaignFilter, type CampaignGrid, type CampaignRow, type Conflict, type Draft, type Part,
} from './campaignDraft'
import styles from './campaigns.module.css'

const GRID_PATH = '/api/advertising/control-room/guardrail-grid'
/** The server's cap on one read (ads-control-room-detail.service.ts `getGuardrailGrid`). */
const GRID_LIMIT = 500

const options = <K extends string>(labels: Record<K, string>): ListboxOption[] =>
  (Object.keys(labels) as K[]).map((value) => ({ value, label: labels[value] }))
const ALLOWED_OPTIONS = options(ALLOWED_LABEL)
const GAP_OPTIONS = options(GAP_LABEL)
const LOCKED_OPTIONS = options(LOCKED_LABEL)
const PART_OPTIONS = PARTS.map((p) => ({ value: p, label: PART_WORD[p] }))

type BulkAsk = { kind: 'minBid' | 'maxBid'; text: string } | { kind: 'locks'; part: Part }
interface Issue { campaign: string; what: string; why: string }
interface SaveResult { saved: number; refused: Issue[]; skipped: Issue[]; reloadFailed: boolean }
type ReviewState = { state: 'closed' } | { state: 'reading' } | { state: 'ready'; conflicts: Conflict[] } | { state: 'failed'; error: string }

/** Below 640 px: the phone layout (as the Approvals page). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)')
    const update = () => setPhone(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}

async function fetchGrid(q?: { market?: string | null; search?: string }): Promise<CampaignGrid> {
  const qs = new URLSearchParams({ limit: String(GRID_LIMIT) })
  if (q?.market && q.market !== 'all') qs.set('marketplace', q.market)
  if (q?.search?.trim()) qs.set('search', q.search.trim())
  const r = await fetch(`${getBackendUrl()}${GRID_PATH}?${qs}`, { cache: 'no-store' })
  if (!r.ok) throw new Error(`The campaigns could not be read (${r.status}).`)
  return (await r.json()) as CampaignGrid
}

const merged = (known: ReadonlyMap<string, CampaignRow>, rows: readonly CampaignRow[]) => {
  const m = new Map(known)
  for (const r of rows) m.set(r.id, r)
  return m
}

/**
 * `refreshKey`: the page's Refresh button bumps it, and the grid is read again (the draft stays).
 */
export function CampaignsTab({ refreshKey }: { refreshKey?: number } = {}) {
  // The server's own gate for every campaign write below (permissions-manifest.ts: /api/advertising writes).
  const canEdit = usePermission('ads.campaigns.manage')
  const phone = usePhone()
  const [grid, setGrid] = useState<CampaignGrid | null>(null)
  // Every campaign read so far, freshest last: a draft is checked and saved against these, also for a campaign the
  // current filter does not show.
  const [known, setKnown] = useState<ReadonlyMap<string, CampaignRow>>(new Map())
  // The account has more campaigns than one read returns: market and search then go to the server, so every
  // campaign can be reached (CR review #11). Otherwise every campaign is here and filtering stays on the page.
  const [partial, setPartial] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({})
  const [filter, setFilter] = useState<CampaignFilter>(NO_CAMPAIGN_FILTER)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [bulk, setBulk] = useState<BulkAsk | null>(null)
  const [review, setReview] = useState<ReviewState>({ state: 'closed' })
  const [ack, setAck] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<SaveResult | null>(null)

  const knownRef = useRef(known)
  knownRef.current = known
  const queryRef = useRef<{ market: string; search: string }>({ market: 'all', search: '' })
  const partialRef = useRef(partial)
  partialRef.current = partial

  /** Reads the grid (with market and search when the account is too big for one read) and remembers every row. */
  const load = useCallback(async (): Promise<CampaignGrid | null> => {
    try {
      const g = await fetchGrid(partialRef.current ? queryRef.current : undefined)
      if (!partialRef.current && g.rows.length < g.totals.campaigns) setPartial(true)
      setGrid(g)
      setKnown((k) => merged(k, g.rows))
      setErr(null)
      return g
    } catch (e) { setErr((e as Error).message); return null }
  }, [])
  useEffect(() => { void load() }, [load])

  // The page's Refresh (skips the first render: the read above already ran).
  const firstRefresh = useRef(true)
  useEffect(() => {
    if (firstRefresh.current) { firstRefresh.current = false; return }
    void load()
  }, [refreshKey, load])

  // A big account: market and search go to the server, a moment after the person stops typing.
  useEffect(() => {
    queryRef.current = { market: filter.market, search: filter.search }
    if (!partial) return
    const t = window.setTimeout(() => { void load() }, 300)
    return () => window.clearTimeout(t)
  }, [partial, filter.market, filter.search, load])

  const lines = useMemo(() => reviewLines(draft, known), [draft, known])
  const groups = useMemo(() => reviewGroups(lines), [lines])
  const problems = useMemo(
    () => Object.entries(draft).flatMap(([id, edit]) => {
      const row = known.get(id)
      return row ? problemsOf(row, edit).map((p) => `${row.name}: ${p}`) : []
    }),
    [draft, known],
  )
  const raises = lines.filter((l) => l.raise).length

  const edit = useCallback((row: CampaignRow, patch: CampaignEdit) => { setResult(null); setDraft((d) => setEdit(d, row, patch)) }, [])
  const handlers = useRef<GridHandlers>({ canEdit: false, setAllowed: () => {} })
  handlers.current = { canEdit, setAllowed: (row, allowed) => edit(row, { allowed }) }

  // The rows on screen show the freshest read of each campaign.
  const all = useMemo(() => (grid?.rows ?? []).map((r) => known.get(r.id) ?? r), [grid, known])
  const shown = useMemo(() => all.filter((r) => campaignMatches(r, filter)), [all, filter])
  const gridRows = useMemo<GridRow[]>(
    () => shown.map((row) => ({ id: row.id, row, edit: draft[row.id], values: valuesOf(row, draft[row.id]) })),
    [shown, draft],
  )
  const selected = useMemo(() => selectedIds.flatMap((id) => known.get(id) ?? []), [selectedIds, known])
  const markets = useMemo<ListboxOption[]>(
    () => [{ value: 'all', label: 'Every market' }, ...[...new Set([...known.values()].flatMap((r) => (r.marketplace ? [r.marketplace] : [])))].sort().map((m) => ({ value: m, label: m }))],
    [known],
  )

  const clear = useCallback(() => setFilter(NO_CAMPAIGN_FILTER), [])
  const noRowsParams = useMemo(
    () => (all.length || isCampaignFiltered(filter)
      ? { title: 'No campaign matches these filters', message: 'Clear the filters to see every campaign.', action: { label: 'Clear filters', onClick: clear } }
      : { title: 'No campaigns', message: 'This business has no ad campaigns yet.' }),
    [all.length, filter, clear],
  )
  const onRowClicked = useCallback<NonNullable<NexusGridProps<GridRow>['onRowClicked']>>((e) => { if (e.data) setOpenId(e.data.id) }, [])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<GridRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data) return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('button, a, input, [role="switch"], [role="checkbox"]')) return
    setOpenId(e.data.id)
  }, [])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<GridRow>['onSelectionChanged']>>((e) => {
    setSelectedIds(e.api.getSelectedRows().map((r) => r.id))
  }, [])

  const runBulk = (op: BulkOp) => { setResult(null); setDraft((d) => applyBulk(d, selected, op)) }
  const bulkMoney = bulk && bulk.kind !== 'locks' ? parseMoney(bulk.text) : null
  const bulkMoneyOk = bulkMoney !== null && Number.isFinite(bulkMoney) && bulkMoney > 0

  /**
   * Review reads every drafted campaign AGAIN first (CR review #1): the "Now" column is today's value, a value that
   * changed since the draft was made is named, and Save stays held until that read is in.
   */
  const openReview = async () => {
    setAck(false)
    setReview({ state: 'reading' })
    const before = knownRef.current
    const ids = Object.keys(draft)
    try {
      const page = await fetchGrid()
      const fresh = new Map(page.rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r]))
      // A big account: a drafted campaign beyond the first read is read by its own name and market.
      for (const id of ids) {
        if (fresh.has(id)) continue
        const k = before.get(id)
        if (!k) continue
        const hit = (await fetchGrid({ market: k.marketplace, search: k.name })).rows.find((r) => r.id === id)
        if (hit) fresh.set(id, hit)
      }
      const missing = ids.filter((id) => !fresh.has(id)).map((id) => before.get(id)?.name ?? id)
      if (missing.length) throw new Error(`These campaigns could not be read again: ${missing.join(', ')}.`)
      const conflicts = conflictsOf(draft, before, fresh)
      const latest = merged(before, [...fresh.values()])
      setKnown(latest)
      setDraft((d) => retidy(d, latest))
      setReview({ state: 'ready', conflicts })
    } catch (e) {
      setReview({ state: 'failed', error: (e as Error).message })
    }
  }

  /**
   * Sends the draft campaign by campaign, in the order `requestsFor` gives (a block first, an allow last); reads every
   * body; an allow is not sent after a refused change of the same campaign. Then re-reads the grid.
   */
  const save = async () => {
    if (saving || review.state !== 'ready' || problems.length || (raises > 0 && !ack)) return
    setSaving(true)
    const out: SaveResult = { saved: 0, refused: [], skipped: [], reloadFailed: false }
    let next = draft
    for (const [id, e] of Object.entries(draft)) {
      const row = known.get(id)
      if (!row) continue
      let refused = false
      for (const req of requestsFor(row, e)) {
        const skip = skipReason(req, refused)
        if (skip) { out.skipped.push({ campaign: row.name, what: req.what, why: skip }); continue }
        try {
          const r = await fetch(`${getBackendUrl()}${req.path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) })
          const why = refusalOf(r.status, await r.json().catch(() => null))
          if (why) { refused = true; out.refused.push({ campaign: row.name, what: req.what, why }) }
          else { out.saved += 1; next = dropSaved(next, id, req.fields) }
        } catch (x) { refused = true; out.refused.push({ campaign: row.name, what: req.what, why: (x as Error).message }) }
      }
    }
    // What saved leaves the draft now, whether or not the list can be read again (CR review #17).
    setDraft(next)
    const fresh = await load()
    if (fresh) {
      const latest = merged(knownRef.current, fresh.rows)
      setDraft((d) => retidy(d, latest))
    } else out.reloadFailed = true
    setResult(out)
    setSaving(false); setReview({ state: 'closed' }); setAck(false)
  }

  const t = grid?.totals
  const tile = (on: boolean, next: Partial<CampaignFilter>) => () => setFilter(on ? NO_CAMPAIGN_FILTER : { ...NO_CAMPAIGN_FILTER, ...next })

  return (
    <div className={styles.stack}>
      {err && <Banner tone="danger" title="Something could not be read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{err}</Banner>}
      {!canEdit && (
        <Banner tone="info" title="You can see these limits">Changing them needs the ads campaigns permission.</Banner>
      )}

      <MetricStrip
        metrics={[
          {
            label: 'Automation may change it',
            value: t ? `${t.managed} of ${t.campaigns}` : '—',
            hint: 'the others refuse every automated change',
            accent: 'var(--nds-success)',
            onClick: tile(filter.allowed === 'yes', { allowed: 'yes' }),
            active: filter.allowed === 'yes',
          },
          {
            label: 'No lowest bid',
            value: t ? t.campaigns - t.withMinBid : '—',
            hint: t ? `of ${t.campaigns} campaigns have none` : undefined,
            accent: 'var(--nds-warning)',
            onClick: tile(filter.gap === 'no-min', { gap: 'no-min' }),
            active: filter.gap === 'no-min',
          },
          {
            label: 'No highest bid',
            value: t ? t.campaigns - t.withMaxBid : '—',
            hint: t ? `of ${t.campaigns} campaigns have none` : undefined,
            accent: 'var(--nds-warning)',
            onClick: tile(filter.gap === 'no-max', { gap: 'no-max' }),
            active: filter.gap === 'no-max',
          },
          {
            label: 'Something locked',
            value: t ? t.pinned : '—',
            hint: t ? `of ${t.campaigns} campaigns have a locked part` : undefined,
            accent: 'var(--nds-border-strong)',
            onClick: tile(filter.locked === 'locked', { locked: 'locked' }),
            active: filter.locked === 'locked',
          },
        ]}
      />

      {result && (
        <Banner
          tone={result.refused.length || result.skipped.length || result.reloadFailed ? 'warning' : 'success'}
          title={result.refused.length || result.skipped.length
            ? [`${result.saved} saved`, result.refused.length ? `${result.refused.length} refused` : null, result.skipped.length ? `${result.skipped.length} not sent` : null].filter(Boolean).join(' · ')
            : `Saved ${result.saved} ${result.saved === 1 ? 'change' : 'changes'}.`}
          onDismiss={() => setResult(null)}
        >
          {(result.refused.length > 0 || result.skipped.length > 0) && (
            <ul className={styles.list}>
              {result.refused.map((x, i) => <li key={`r${i}`}>{x.campaign} — {x.what}: {x.why}</li>)}
              {result.skipped.map((x, i) => <li key={`s${i}`}>{x.campaign} — {x.what}: {x.why}</li>)}
            </ul>
          )}
          {(result.refused.length > 0 || result.skipped.length > 0) && <p className={styles.para}>The changes that did not save are still in your draft.</p>}
          {result.reloadFailed && <p className={styles.para}>The list could not be read again. What saved is out of your draft. The list may show old values until you press Refresh.</p>}
        </Banner>
      )}

      {canEdit && lines.length > 0 && (
        <EditModeBar
          count={lines.length}
          onDiscard={() => { setDraft({}); setResult(null) }}
          onApply={() => void openReview()}
          applyLabel={`Review ${lines.length} ${lines.length === 1 ? 'change' : 'changes'}…`}
          busy={saving}
        />
      )}

      <GridCard
        toolbar={canEdit && selected.length > 0 ? (
          <GridToolbar count={<>Selected <b>{selected.length}</b></>}>
            <GridSelectionActions>
              <Button size="sm" variant="secondary" onClick={() => runBulk({ kind: 'allowed', value: true })}>Allow automation</Button>
              <Button size="sm" variant="secondary" onClick={() => runBulk({ kind: 'allowed', value: false })}>Block automation</Button>
              <Button size="sm" variant="secondary" onClick={() => setBulk({ kind: 'minBid', text: '' })}>Lowest bid…</Button>
              <Button size="sm" variant="secondary" onClick={() => setBulk({ kind: 'maxBid', text: '' })}>Highest bid…</Button>
              <Button size="sm" variant="secondary" onClick={() => setBulk({ kind: 'locks', part: 'bids' })}>Lock or unlock…</Button>
            </GridSelectionActions>
          </GridToolbar>
        ) : (
          <GridToolbar
            count={grid ? (isCampaignFiltered(filter) || partial ? `Showing ${shown.length} of ${grid.totals.campaigns} campaigns` : `${all.length} campaigns`) : 'Reading…'}
            right={(
              <span className={styles.toolbarRight}>
                <Listbox size="sm" width={150} ariaLabel="Market" options={markets} value={filter.market} onChange={(v) => setFilter({ ...filter, market: v })} />
                <Listbox size="sm" width={170} ariaLabel="Automation may change it" options={ALLOWED_OPTIONS} value={filter.allowed} onChange={(v) => { if (isAllowedFilter(v)) setFilter({ ...filter, allowed: v }) }} />
                <Listbox size="sm" width={180} ariaLabel="Missing a limit" options={GAP_OPTIONS} value={filter.gap} onChange={(v) => { if (isGapFilter(v)) setFilter({ ...filter, gap: v }) }} />
                <Listbox size="sm" width={160} ariaLabel="Locked" options={LOCKED_OPTIONS} value={filter.locked} onChange={(v) => { if (isLockedFilter(v)) setFilter({ ...filter, locked: v }) }} />
              </span>
            )}
          >
            <GridSearchSlot>
              <Input
                size="sm"
                type="search"
                aria-label="Search campaigns"
                placeholder="Search campaigns"
                leadingIcon={<Search size={14} aria-hidden />}
                value={filter.search}
                onChange={(e) => setFilter({ ...filter, search: e.target.value })}
              />
            </GridSearchSlot>
          </GridToolbar>
        )}
      >
        <CampaignLimitsGrid
          rows={gridRows}
          loading={grid === null && !err}
          context={handlers}
          canEdit={canEdit}
          phone={phone}
          noRowsParams={noRowsParams}
          onRowClicked={onRowClicked}
          onCellKeyDown={onCellKeyDown}
          onSelectionChanged={onSelectionChanged}
        />
      </GridCard>

      {grid && grid.rows.length >= GRID_LIMIT && grid.totals.campaigns > grid.rows.length && (
        <Banner tone="warning" title={`Showing the first ${grid.rows.length} of ${grid.totals.campaigns} campaigns`}>
          Search a name or pick a market to reach the others. Nexus then reads them from the server.
        </Banner>
      )}

      <ul className={`${styles.list} ${styles.muted}`}>
        <li>{canEdit
          ? 'Click a row, or press Enter on it, to change one campaign. Tick rows to change many at once. Nothing is saved until you review it.'
          : 'Click a row, or press Enter on it, to see all of one campaign’s limits.'}</li>
        <li>Lowest bid, highest bid and locks bind every engine and rule on every change sent to Amazon. Amazon itself never sees them.</li>
        <li>Turning a paused campaign back on does not set “Automation may change it” back to Yes. Set it again for that campaign.</li>
        {grid && grid.accountWideRules > 0 && (
          <li>{grid.accountWideRules} {grid.accountWideRules === 1 ? 'rule acts' : 'rules act'} on every campaign, because {grid.accountWideRules === 1 ? 'it is' : 'they are'} not limited to one. “Its own rules” counts only the rules limited to that campaign.</li>
        )}
      </ul>

      {openId && known.get(openId) && (
        <CampaignDrawer
          row={known.get(openId)!}
          edit={draft[openId]}
          canEdit={canEdit}
          onEdit={(patch) => edit(known.get(openId)!, patch)}
          onClose={() => setOpenId(null)}
        />
      )}

      <Modal
        open={bulk !== null}
        onClose={() => setBulk(null)}
        size="sm"
        title={bulk?.kind === 'minBid' ? 'Lowest bid' : bulk?.kind === 'maxBid' ? 'Highest bid' : 'Lock or unlock'}
        subtitle={`For the ${selected.length} ticked ${selected.length === 1 ? 'campaign' : 'campaigns'}. This only changes your draft.`}
        footer={bulk?.kind === 'locks' ? (
          <>
            <Button variant="secondary" onClick={() => setBulk(null)}>Cancel</Button>
            <span className="grow" />
            <Button variant="secondary" onClick={() => { runBulk({ kind: 'pin', part: bulk.part, value: false }); setBulk(null) }}>Unlock {PART_WORD[bulk.part].toLowerCase()}</Button>
            <Button variant="primary" onClick={() => { runBulk({ kind: 'pin', part: bulk.part, value: true }); setBulk(null) }}>Lock {PART_WORD[bulk.part].toLowerCase()}</Button>
          </>
        ) : bulk ? (
          <>
            <Button variant="secondary" onClick={() => setBulk(null)}>Cancel</Button>
            <span className="grow" />
            <Button variant="secondary" onClick={() => { runBulk(bulk.kind === 'minBid' ? { kind: 'minBid', cents: null } : { kind: 'maxBid', cents: null }); setBulk(null) }}>Clear it</Button>
            <Button
              variant="primary"
              disabled={!bulkMoneyOk}
              onClick={() => { if (bulkMoneyOk) { runBulk(bulk.kind === 'minBid' ? { kind: 'minBid', cents: bulkMoney } : { kind: 'maxBid', cents: bulkMoney }); setBulk(null) } }}
            >
              Set it
            </Button>
          </>
        ) : null}
      >
        {bulk?.kind === 'locks' ? (
          <Field label="Part" hint="A locked part cannot be changed by automation. Lowering bids to stop a campaign is still allowed.">
            <SegmentedControl size="sm" ariaLabel="Part" options={PART_OPTIONS} value={bulk.part} onChange={(v) => setBulk({ kind: 'locks', part: v as Part })} />
          </Field>
        ) : bulk ? (
          <Field
            label={bulk.kind === 'minBid' ? 'Lowest bid' : 'Highest bid'}
            hint="In each campaign’s own currency. “Clear it” removes the campaign’s own value."
            error={bulk.text.trim() !== '' && !bulkMoneyOk ? 'Type an amount above 0, like 0.50.' : undefined}
          >
            <Input size="sm" inputMode="decimal" autoFocus value={bulk.text} placeholder="0.50" onChange={(e) => setBulk({ kind: bulk.kind, text: e.target.value })} />
          </Field>
        ) : null}
      </Modal>

      <Modal
        open={review.state !== 'closed'}
        onClose={() => { if (!saving) setReview({ state: 'closed' }) }}
        size="lg"
        title={`Review ${lines.length} ${lines.length === 1 ? 'change' : 'changes'}`}
        subtitle="Nexus only: these limits are never sent to Amazon. They decide what automation may do."
        footer={(
          <>
            <Button variant="secondary" disabled={saving} onClick={() => setReview({ state: 'closed' })}>Cancel</Button>
            <Button
              variant="primary"
              disabled={saving || review.state !== 'ready' || lines.length === 0 || problems.length > 0 || (raises > 0 && !ack)}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : review.state === 'reading' ? 'Reading the campaigns…' : saveWords(lines.length)}
            </Button>
          </>
        )}
      >
        <div className={styles.stack}>
          {review.state === 'reading' && <p className={`${styles.para} ${styles.muted}`}>Reading these campaigns again, so “Now” is today’s value. Save waits for it.</p>}
          {review.state === 'failed' && (
            <Banner tone="danger" title="Save is held" action={<Button size="sm" variant="secondary" onClick={() => void openReview()}>Try again</Button>}>
              {review.error} Nexus must read them again before it saves, so it never overwrites a value it has not shown you.
            </Banner>
          )}
          {review.state === 'ready' && review.conflicts.length > 0 && (
            <Banner tone="warning" title="Changed since you opened this page">
              <ul className={styles.list}>
                {review.conflicts.map((c, i) => <li key={i}>{c.campaign} — {c.what}: was {c.was}, now {c.now}</li>)}
              </ul>
              <p className={styles.para}>“Now” below shows today’s value. Save replaces it with yours.</p>
            </Banner>
          )}
          {review.state === 'ready' && lines.length === 0 && (
            <Banner tone="success" title="Nothing left to save">The campaigns already have these values.</Banner>
          )}
          {problems.length > 0 && (
            <Banner tone="danger" title="Fix these before you save">
              <ul className={styles.list}>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </Banner>
          )}
          {groups.map((g) => (
            <div key={g.campaignId} className={styles.group}>
              <strong className={styles.groupName}>{g.campaign}</strong>
              <SummaryTable
                label={`Changes for ${g.campaign}`}
                columns={['Change', 'Now', 'After']}
                rows={g.lines.map((l) => ({
                  id: l.id,
                  cells: [
                    l.raise ? <span key="w">{l.what}<span className={styles.raiseNote}>Lets automation do more</span></span> : l.what,
                    l.before,
                    l.after,
                  ],
                }))}
              />
            </div>
          ))}
          {raises > 0 && (
            <Checkbox
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              label={`I understand ${raises === 1 ? 'this change lets' : `these ${raises} changes let`} automation change more of my ads, from its next run.`}
            />
          )}
        </div>
      </Modal>
    </div>
  )
}
