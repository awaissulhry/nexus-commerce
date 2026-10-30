'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { ArrowRight, FileText, Hash, ScanLine, Search, TriangleAlert } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { Input, Kbd, Skeleton } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { statusKey, typeKey } from '../../../areas/search/model'
import { RecordTypeIcon } from '../../../areas/search/RecordTypeIcon'
import { groupOf, hrefOf, isOpenable, moveHighlight, nextGroupStart, PALETTE_GROUPS, paletteResults, type PalettePage, type PaletteRecord, type PaletteRecords, type PaletteResult } from '../palette-model'
import '../palette.css'

/**
 * SCR-004 — search and the command palette. Opened by the top bar's search field or ⌘K / Ctrl K. One field: type a
 * number, a name or a page's name, or scan / type a label code (`palette-model.ts`). Groups in the design's order:
 * Label · Exact number · Records (B-W2a-32: the person's records by number and name, typos forgiven, "See all results")
 * · Pages. The focus stays in the field; ↑ ↓ move the highlight (the list is a listbox the field controls), Tab and
 * Shift+Tab jump between groups, Enter opens, ⌘Enter / Ctrl+Enter (and ⌘-click) open in a new tab, Esc closes (the DS
 * Modal returns the focus to whatever opened it). A hardware scanner types into the field and ends with Enter. The
 * records come from the container (`onQuery` → `model.records`): this view asks nothing itself.
 */

export interface CommandPaletteViewModel {
  open: boolean
  /** The text in the field when it opens (a scan, a fixture). */
  query: string
  /** The pages the person may open; `label` and `area` may be message keys (`shell:nav.admin.users`). */
  pages: readonly PalettePage[]
  /** The signed-in tenant's label tag; null: labels of other factories are not told apart. */
  tenantTag: string | null
  /** What the record search answered (absent: no record search, as in W0's cases). */
  records?: PaletteRecords | null
}

export interface CommandPaletteViewProps {
  model: CommandPaletteViewModel
  onClose?: () => void
  /** A result was chosen (its full address); `newTab` for ⌘Enter and ⌘-click. */
  onOpenHref?: (href: string, options?: { newTab: boolean }) => void
  /** The field changed (the container searches the records, waiting for a pause in typing). */
  onQuery?: (query: string) => void
}

/** The first result a person can open (else the first; -1 when there is none). */
function firstOpenable(results: readonly PaletteResult[]): number {
  if (results.length === 0) return -1
  return Math.max(results.findIndex(isOpenable), 0)
}

export function CommandPaletteView(props: CommandPaletteViewProps) {
  return (
    <WithMessages namespaces={['search']}>
      <Palette {...props} />
    </WithMessages>
  )
}

function Palette({ model, onClose, onOpenHref, onQuery }: CommandPaletteViewProps) {
  const t = useT('shell')
  const named = useScopedT('shell')
  const [open, setOpen] = useState(model.open)
  const [query, setQuery] = useState(model.query)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const ask = useRef(onQuery)
  ask.current = onQuery

  useEffect(() => setOpen(model.open), [model.open])
  useEffect(() => {
    if (model.open) setQuery(model.query)
  }, [model.open, model.query])
  useEffect(() => {
    if (open) ask.current?.(query.trim())
  }, [open, query])

  const pages = useMemo(() => model.pages.map((page) => ({ ...page, label: named(page.label), area: named(page.area) })), [model.pages, named])
  const results = useMemo(() => paletteResults(query, { pages, tenantTag: model.tenantTag, records: model.records ?? null }), [query, pages, model.tenantTag, model.records])
  // The highlight belongs to the results it was moved on: new results (the search answered) start again on the first
  // one a person can open, at once, so an Enter never opens what moved under it.
  const [cursor, setCursor] = useState<{ of: readonly PaletteResult[]; index: number }>({ of: [], index: -1 })
  const active = cursor.of === results ? cursor.index : firstOpenable(results)
  const setActive = (next: (current: number) => number) => setCursor({ of: results, index: next(active) })
  // A scanner (or a quick hand) ends a number with Enter before the search answers: the record opens when it does, but
  // only an exact number or label — never a record found by a similar word.
  const pending = useRef<string | null>(null)
  useEffect(() => {
    const waiting = pending.current
    if (waiting === null || model.records?.query !== waiting || waiting !== query.trim()) return
    if (model.records.state === 'loading' || model.records.state === 'slow') return
    pending.current = null
    const exact = results.find((result) => (result.kind === 'record' && result.group === 'exact') || (result.kind === 'label' && result.record !== null))
    if (exact) choose(exact)
  })
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const close = () => {
    setOpen(false)
    onClose?.()
  }
  const choose = (result: PaletteResult | undefined, newTab = false) => {
    const href = result ? hrefOf(result) : null
    if (!href) return
    if (newTab) {
      onOpenHref?.(href, { newTab: true })
      return
    }
    close()
    onOpenHref?.(href, { newTab: false })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => moveHighlight(current, results.length, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Tab' && results.length > 0) {
      event.preventDefault()
      setActive((current) => nextGroupStart(results, current, event.shiftKey ? -1 : 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = results[active]
      if (result && isOpenable(result)) choose(result, event.metaKey || event.ctrlKey)
      else if (model.records && (model.records.state === 'loading' || model.records.state === 'slow' || model.records.query !== query.trim()) && query.trim() !== '') pending.current = query.trim()
    }
  }

  const optionId = (index: number) => `${listId}-o${index}`
  const groups = PALETTE_GROUPS.map((group) => ({ group, entries: results.map((result, index) => ({ result, index })).filter(({ result }) => groupOf(result) === group) })).filter((group) => group.entries.length > 0)

  return (
    <Modal open={open} onClose={close} title={t('palette.title')} size="md" className="fw-palette">
      <Input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        leadingIcon={<Search size={15} aria-hidden />}
        fieldClassName="fw-palette-field"
        placeholder={t('palette.placeholder')}
        aria-label={t('palette.placeholder')}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      <div id={listId} ref={listRef} role="listbox" aria-label={t('palette.results')} className="fw-palette-list">
        {groups.map(({ group, entries }) => (
          <div key={group} role="group" aria-label={t(`palette.group.${group}`)} className="fw-palette-group">
            <div className="fw-palette-group-label" aria-hidden="true">
              {t(`palette.group.${group}`)}
            </div>
            {entries.map(({ result, index }) => (
              <PaletteRow key={result.id} id={optionId(index)} result={result} active={index === active} onPick={(newTab) => choose(result, newTab)} onHover={() => setActive(() => index)} />
            ))}
          </div>
        ))}
        {results.length === 0 && <p className="fw-palette-empty">{t('palette.empty', { query: query.trim() })}</p>}
      </div>
      <p className="fw-palette-keys">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('palette.keys.move')}
        </span>
        <span>
          <Kbd>Enter</Kbd> {t('palette.keys.open')}
        </span>
        <span>
          <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> {t('palette.keys.newTab')}
        </span>
        <span>
          <Kbd>Tab</Kbd> {t('palette.keys.group')}
        </span>
        <span>
          <Kbd>Esc</Kbd> {t('palette.keys.close')}
        </span>
      </p>
    </Modal>
  )
}

/** "ORD-2026-00042 · Sales order · In production" under the record's name. */
function useRecordWords() {
  const words = useT('search')
  return (record: PaletteRecord) => {
    const status = statusKey(record.status)
    return [words(typeKey(record.recordType)), record.subtitle, status ? words(status) : null].filter(Boolean).join(' · ')
  }
}

function PaletteRow({ id, result, active, onPick, onHover }: { id: string; result: PaletteResult; active: boolean; onPick: (newTab: boolean) => void; onHover: () => void }) {
  const t = useT('shell')
  const words = useT('search')
  const recordWords = useRecordWords()
  const openable = isOpenable(result)
  let icon = <FileText size={16} aria-hidden />
  let title = ''
  let detail = ''
  let similar = false
  switch (result.kind) {
    case 'page':
      title = result.page.label
      detail = result.page.area
      break
    case 'label':
      icon = <ScanLine size={16} aria-hidden />
      if (result.record) {
        title = t('palette.label.open', { type: t(`scanType.${result.type}`), code: result.text, title: result.record.title })
        detail = recordWords(result.record)
      } else {
        title = t('palette.label.found', { type: t(`scanType.${result.type}`), code: result.text })
        detail = t(result.looking ? 'palette.label.looking' : 'palette.label.later', { reference: result.ref })
      }
      break
    case 'label-refused':
      icon = <TriangleAlert size={16} aria-hidden />
      title = t('palette.label.refused', { code: result.text })
      detail = t(`palette.problem.${result.problem}`, { type: result.type ? t(`scanType.${result.type}`) : '' })
      break
    case 'number':
      icon = <Hash size={16} aria-hidden />
      title = t('palette.number.find', { number: result.text })
      detail = t(result.looking ? 'palette.number.looking' : 'palette.number.later')
      break
    case 'record':
      icon = <RecordTypeIcon type={result.record.recordType} size={16} />
      title = result.record.number ? `${result.record.number} · ${result.record.title}` : result.record.title
      detail = recordWords(result.record)
      similar = result.record.match === 'similar'
      break
    case 'all':
      icon = <ArrowRight size={16} aria-hidden />
      title = t('palette.records.all', { query: result.query })
      detail = t('palette.records.allCount', { count: result.total })
      break
    case 'records-state':
      return (
        <div id={id} role="option" aria-selected={active} aria-disabled className={`fw-palette-row info${active ? ' on' : ''}${result.state === 'error' ? ' refused' : ''}`} onMouseMove={onHover}>
          {result.state === 'error' ? (
            <>
              <span className="fw-palette-ico">
                <TriangleAlert size={16} aria-hidden />
              </span>
              <span className="fw-palette-text">
                <span className="fw-palette-detail">{t('palette.records.error')}</span>
              </span>
            </>
          ) : (
            <span className="fw-palette-skeleton" aria-live="polite">
              <span className="nds-vh">{t('palette.records.loading')}</span>
              <Skeleton width="60%" height={12} />
              <Skeleton width="40%" height={10} />
              {result.state === 'slow' && <span className="fw-palette-detail">{t('palette.records.slow')}</span>}
            </span>
          )}
        </div>
      )
  }
  const pick = (event: MouseEvent<HTMLDivElement>) => onPick(event.metaKey || event.ctrlKey)
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={openable ? undefined : true}
      className={`fw-palette-row${active ? ' on' : ''}${openable ? '' : ' info'}${result.kind === 'label-refused' ? ' refused' : ''}`}
      onClick={pick}
      onMouseMove={onHover}
    >
      <span className="fw-palette-ico">{icon}</span>
      <span className="fw-palette-text">
        <span className="fw-palette-title">{title}</span>
        <span className="fw-palette-detail">
          {detail}
          {similar && <span className="fw-palette-similar">{` · ${t('palette.record.similar')}`}</span>}
        </span>
      </span>
      {result.kind === 'record' && <span className="nds-vh">{words(`why.${result.record.match}`)}</span>}
    </div>
  )
}
