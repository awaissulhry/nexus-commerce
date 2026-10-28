'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FileText, Hash, ScanLine, Search, TriangleAlert } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { Input, Kbd } from '@nexus/ui/primitives'
import { useScopedT, useT } from '../../../lib/i18n/provider'
import { isOpenable, moveHighlight, paletteResults, type PalettePage, type PaletteResult } from '../palette-model'
import '../palette.css'

/**
 * SCR-004 — search and the command palette. Opened by the top bar's search field or ⌘K / Ctrl K. One field: type a
 * page's name to jump to it, or scan / type a label code to learn what it is (`palette-model.ts`). The focus stays in
 * the field; ↑ ↓ move the highlight (the list is a listbox the field controls), Enter opens it, Esc closes (the DS
 * Modal returns the focus to whatever opened it). A hardware scanner types into the field and ends with Enter.
 */

export interface CommandPaletteViewModel {
  open: boolean
  /** The text in the field when it opens (a scan, a fixture). */
  query: string
  /** The pages the person may open; `label` and `area` may be message keys (`shell:nav.admin.users`). */
  pages: readonly PalettePage[]
  /** The signed-in tenant's label tag; null: labels of other factories are not told apart. */
  tenantTag: string | null
}

export interface CommandPaletteViewProps {
  model: CommandPaletteViewModel
  onClose?: () => void
  /** A page was chosen (its full address). */
  onOpenHref?: (href: string) => void
}

const GROUP_OF: Record<PaletteResult['kind'], 'labels' | 'numbers' | 'pages'> = { label: 'labels', 'label-refused': 'labels', number: 'numbers', page: 'pages' }

export function CommandPaletteView({ model, onClose, onOpenHref }: CommandPaletteViewProps) {
  const t = useT('shell')
  const named = useScopedT('shell')
  const [open, setOpen] = useState(model.open)
  const [query, setQuery] = useState(model.query)
  const [active, setActive] = useState(0)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => setOpen(model.open), [model.open])
  useEffect(() => {
    if (model.open) setQuery(model.query)
  }, [model.open, model.query])

  const pages = useMemo(() => model.pages.map((page) => ({ ...page, label: named(page.label), area: named(page.area) })), [model.pages, named])
  const results = useMemo(() => paletteResults(query, { pages, tenantTag: model.tenantTag }), [query, pages, model.tenantTag])
  useEffect(() => setActive(results.length > 0 ? 0 : -1), [results])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const close = () => {
    setOpen(false)
    onClose?.()
  }
  const choose = (result: PaletteResult | undefined) => {
    if (!result || !isOpenable(result)) return
    close()
    onOpenHref?.(result.page.href)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => moveHighlight(current, results.length, event.key === 'ArrowDown' ? 1 : -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(results[active])
    }
  }

  const optionId = (index: number) => `${listId}-o${index}`
  const groups = (['labels', 'numbers', 'pages'] as const)
    .map((group) => ({ group, entries: results.map((result, index) => ({ result, index })).filter(({ result }) => GROUP_OF[result.kind] === group) }))
    .filter((group) => group.entries.length > 0)

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
              <PaletteRow key={result.id} id={optionId(index)} result={result} active={index === active} onPick={() => choose(result)} onHover={() => setActive(index)} />
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
          <Kbd>Esc</Kbd> {t('palette.keys.close')}
        </span>
      </p>
    </Modal>
  )
}

function PaletteRow({ id, result, active, onPick, onHover }: { id: string; result: PaletteResult; active: boolean; onPick: () => void; onHover: () => void }) {
  const t = useT('shell')
  const openable = isOpenable(result)
  let icon = <FileText size={16} aria-hidden />
  let title = ''
  let detail = ''
  switch (result.kind) {
    case 'page':
      title = result.page.label
      detail = result.page.area
      break
    case 'label':
      icon = <ScanLine size={16} aria-hidden />
      title = t('palette.label.found', { type: t(`scanType.${result.type}`), code: result.text })
      detail = t('palette.label.later', { reference: result.ref })
      break
    case 'label-refused':
      icon = <TriangleAlert size={16} aria-hidden />
      title = t('palette.label.refused', { code: result.text })
      detail = t(`palette.problem.${result.problem}`, { type: result.type ? t(`scanType.${result.type}`) : '' })
      break
    case 'number':
      icon = <Hash size={16} aria-hidden />
      title = t('palette.number.find', { number: result.text })
      detail = t('palette.number.later')
      break
  }
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-disabled={openable ? undefined : true}
      className={`fw-palette-row${active ? ' on' : ''}${openable ? '' : ' info'}${result.kind === 'label-refused' ? ' refused' : ''}`}
      onClick={onPick}
      onMouseMove={onHover}
    >
      <span className="fw-palette-ico">{icon}</span>
      <span className="fw-palette-text">
        <span className="fw-palette-title">{title}</span>
        <span className="fw-palette-detail">{detail}</span>
      </span>
    </div>
  )
}
