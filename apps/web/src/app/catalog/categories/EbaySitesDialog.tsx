'use client'
import { useEffect, useState } from 'react'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button, Tag } from '@/design-system/primitives'
import { AsyncListboxPanel, Banner, JobProgress, Listbox, Modal, ProgressBar } from '@/design-system/components'
import { useCommandKey } from '@/lib/command-key'
import { loadCategoryOptions, type CategoryOption } from '@/app/products/[id]/edit/_studio/sheet/categoryOptions'
import {
  ASSIGN_OUTCOME, LEAVE_EMPTY, SEARCH, UNDO_OUTCOME, assignLabel, assignSites, chosenAssignments, defaultChoices, doneView, pathText, siteLabel,
  siteOptions, suggestionsPath, summaryLine, undoRows, undoSites, undoView, whyLabel,
  type AssignResult, type Choices, type EbaySiteSuggestions, type SiteSuggestion, type UndoResult,
} from './ebaySites'
import { useResource } from './useResource'
import styles from './categories.module.css'

/**
 * "Fill other eBay sites" — one summary line, one table with a default for every site, a counted primary button,
 * then a Done state with Undo (the pattern of the product-sheet import dialog). Nothing is sent to eBay.
 */
export function EbaySitesDialog({ categoryId, categoryName, onClose, onChanged }: { categoryId: string; categoryName: string; onClose: () => void; onChanged: () => void }) {
  const [retry, setRetry] = useState(0)
  const suggestions = useResource<EbaySiteSuggestions>(suggestionsPath(categoryId), retry)
  const data = suggestions.data
  const [choices, setChoices] = useState<Choices>({})
  const [searching, setSearching] = useState<string | null>(null)
  const [busySince, setBusySince] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<AssignResult[] | null>(null)
  const [undone, setUndone] = useState<UndoResult[] | null>(null)
  const assignKey = useCommandKey()
  useEffect(() => { if (data) setChoices(defaultChoices(data.sites)) }, [data])

  const busy = busySince !== null
  const chosen = data ? chosenAssignments(data.sites, choices) : []
  const undoable = results ? undoRows(results) : []
  const close = () => { if (!busy) onClose() }
  const choose = (site: SiteSuggestion, value: string) => {
    if (value === SEARCH) { setSearching(site.market); return }
    setChoices(current => ({ ...current, [site.market]: value === LEAVE_EMPTY ? null : site.candidates.find(c => c.categoryId === value) ?? current[site.market] ?? null }))
  }
  const assign = async () => {
    setError(null); setSearching(null); setBusySince(Date.now())
    try { setResults(await assignSites(assignKey, categoryId, chosen)); onChanged() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The sites could not be assigned. Try again.') }
    finally { setBusySince(null) }
  }
  const undo = async () => {
    setError(null); setBusySince(Date.now())
    try { setUndone(await undoSites(categoryId, undoable)); onChanged() }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The assignments could not be removed. Try again.') }
    finally { setBusySince(null) }
  }

  const footer = results ? <>
    {!undone && undoable.length > 0 && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void undo()}>{busy ? 'Undoing…' : 'Undo'}</Button>}
    <span className="grow" />
    <Button size="sm" variant="primary" disabled={busy} onClick={close}>Done</Button>
  </> : <>
    <span className="grow" />
    <Button size="sm" variant="secondary" disabled={busy} onClick={close}>Cancel</Button>
    <Button size="sm" variant="primary" disabled={busy || !chosen.length} onClick={() => void assign()}>{busy ? 'Assigning…' : assignLabel(chosen.length)}</Button>
  </>

  return <Modal open title="Fill other eBay sites" subtitle={categoryName} size="xl" onClose={close} footer={footer}>
    <div className={styles.stack}>
      {error && <Banner tone="danger" title="This did not work" onDismiss={() => setError(null)}>{error}</Banner>}
      {suggestions.error ? <Banner tone="danger" action={<Button size="sm" onClick={() => setRetry(v => v + 1)}>Retry</Button>}>{suggestions.error}</Banner>
        : !data ? <ProgressBar indeterminate ariaLabel="Finding categories for the other eBay sites" />
        : busy ? <JobProgress label={results ? 'Removing the assignments' : 'Checking and assigning each site'} startedAt={busySince ?? undefined} note="Each site is checked the way a single assignment is. This can take a minute." />
        : undone ? <UndoneView results={undone} />
        : results ? <DoneView results={results} />
        : <ChooseView data={data} choices={choices} searching={searching} onChoose={choose} onSearchClose={() => setSearching(null)}
            onSearched={(market, option) => { setChoices(current => ({ ...current, [market]: { categoryId: option.value, path: option.label, reasons: [] } })); setSearching(null) }} />}
    </div>
  </Modal>
}

function ChooseView({ data, choices, searching, onChoose, onSearched, onSearchClose }: {
  data: EbaySiteSuggestions; choices: Choices; searching: string | null
  onChoose: (site: SiteSuggestion, value: string) => void; onSearched: (market: string, option: CategoryOption) => void; onSearchClose: () => void
}) {
  if (!data.sites.length) return <Banner tone="info" title="Every eBay site already has a category">{`${data.categoryName} has a category on ${data.assignedSites.map(siteLabel).join(', ') || 'every site'}. Change one in Channel assignments.`}</Banner>
  return <>
    <p>{summaryLine(data)}</p>
    {data.ebay.message && <Banner tone="info">{data.ebay.message}</Banner>}
    <DataGrid ariaLabel="Category for each eBay site" keyboardScroll rows={data.sites} rowKey={site => site.market} columns={[
      { key: 'site', label: 'Site', width: 90, render: site => siteLabel(site.market) },
      { key: 'category', label: 'Category', width: 250, render: site => <Listbox size="sm" width="100%" ariaLabel={`Category for ${siteLabel(site.market)}`}
        options={siteOptions(site, choices[site.market] ?? null)} value={choices[site.market]?.categoryId ?? LEAVE_EMPTY} onChange={value => onChoose(site, value)} /> },
      { key: 'path', label: 'Path', render: site => <span className={styles.secondary}>{pathText(site, choices[site.market] ?? null)}</span> },
      { key: 'why', label: 'Why suggested', width: 170, render: site => whyLabel(choices[site.market] ?? null) },
    ]} />
    {searching && <CategorySearch key={searching} market={searching} onCommit={option => onSearched(searching, option)} onCancel={onSearchClose} />}
  </>
}

/** Any leaf of one site's downloaded eBay tree, with the sheet's category search. */
function CategorySearch({ market, onCommit, onCancel }: { market: string; onCommit: (option: CategoryOption) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const term = query.trim()
  const key = JSON.stringify([market, term, revision])
  const [result, setResult] = useState<{ key: string; items: CategoryOption[]; error?: string }>({ key: '', items: [] })
  const tooShort = term.length < 2
  useEffect(() => {
    if (tooShort) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      void loadCategoryOptions('EBAY', market, term, abort.signal)
        .then(items => { if (!abort.signal.aborted) setResult({ key, items }) })
        .catch(caught => { if (!abort.signal.aborted) setResult({ key, items: [], error: caught instanceof Error ? caught.message : 'Category search failed.' }) })
    }, 250)
    return () => { clearTimeout(timer); abort.abort() }
  }, [market, term, key, tooShort])
  const current = result.key === key ? result : null
  return <section className={styles.stack} aria-label={`Search ${siteLabel(market)} categories`}>
    <AsyncListboxPanel label={`Search ${siteLabel(market)} categories`} query={query} onQueryChange={setQuery}
      options={current?.items ?? []} loading={!tooShort && !current} error={current?.error}
      placeholder="Enter at least 2 characters" emptyMessage={tooShort ? 'Enter at least 2 characters to find a category.' : 'No categories match your search.'}
      message={current?.items.length === 50 ? 'Showing the first 50 matches. Refine your search to narrow the list.' : undefined}
      onRetry={current?.error ? () => setRevision(v => v + 1) : undefined} onCancel={onCancel}
      onCommit={value => { const option = current?.items.find(item => item.value === value); if (option) onCommit(option) }} />
  </section>
}

function DoneView({ results }: { results: AssignResult[] }) {
  const view = doneView(results)
  return <>
    <Banner tone={view.tone} title={view.title}>Products in this category use the new category the next time their eBay sheet or listing is read. Publishing is a separate step.</Banner>
    <DataGrid ariaLabel="Result for each eBay site" keyboardScroll rows={results} rowKey={row => row.market} columns={[
      { key: 'site', label: 'Site', width: 90, render: row => siteLabel(row.market) },
      { key: 'category', label: 'Category', width: 110, render: row => row.channelCategoryId },
      { key: 'result', label: 'Result', render: row => <div className={styles.identity}><Tag tone={row.outcome === 'assigned' ? 'success' : 'danger'}>{ASSIGN_OUTCOME[row.outcome]}</Tag>{row.reason && <span className={styles.secondary}>{row.reason}</span>}</div> },
    ]} />
  </>
}

function UndoneView({ results }: { results: UndoResult[] }) {
  const view = undoView(results)
  return <>
    <Banner tone={view.tone} title={view.title} />
    <DataGrid ariaLabel="Undo result for each eBay site" keyboardScroll rows={results} rowKey={row => row.market} columns={[
      { key: 'site', label: 'Site', width: 90, render: row => siteLabel(row.market) },
      { key: 'category', label: 'Category', width: 110, render: row => row.channelCategoryId },
      { key: 'result', label: 'Result', render: row => <div className={styles.identity}><Tag tone={row.outcome === 'removed' ? 'success' : row.outcome === 'failed' ? 'danger' : 'warning'}>{UNDO_OUTCOME[row.outcome]}</Tag>{row.reason && <span className={styles.secondary}>{row.reason}</span>}</div> },
    ]} />
  </>
}
