'use client'

import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import Link from 'next/link'
import { AlertCircle, Search } from 'lucide-react'
import { RefPair } from '@nexus/ui/components/RefPair/index'
import { Button, Input, Skeleton } from '@nexus/ui/primitives'
import { useDsWords, Modal } from '../../../lib/i18n/ds-parts'
import { useT } from '../../../lib/i18n/provider'

/**
 * The top bar's search (design portal.frame › top-bar; SAL-084): "Search orders, documents… (your PO number works)" — their
 * numbers, our numbers. Results grouped as the person's portal shows them (Orders, Documents, Returns, Jobs, Purchase
 * orders), their reference first (RefPair, the typed words marked); Enter opens the one match (or the first); each result is
 * a real link (⌘-click: a new tab). On a phone it opens full width. States: too short, searching, nothing found, "type more"
 * when the list is capped, "Search is not answering. Try again."
 */

export interface SearchResultRow {
  key: string
  href: string
  theirs: string | null
  ours: string | null
  subtitle: string | null
  when: string | null
}

export interface SearchGroupRow {
  group: string
  /** The group's name in the person's language. */
  label: string
  count: number
  results: readonly SearchResultRow[]
}

export interface SearchViewModel {
  open: boolean
  query: string
  state: 'idle' | 'tooShort' | 'searching' | 'error' | 'ready'
  groups: readonly SearchGroupRow[]
  found: number
  capped: boolean
  /** Enter opens this one. */
  single: string | null
}

export interface SearchViewProps {
  model: SearchViewModel
  onQuery?: (query: string) => void
  onClose: () => void
  onRetry?: () => void
  onOpen?: (href: string, event?: MouseEvent<HTMLAnchorElement>) => void
}

export function SearchView({ model, onQuery, onClose, onRetry, onOpen }: SearchViewProps) {
  const t = useT('portal')
  const ds = useDsWords()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (model.open) setTimeout(() => input.current?.focus(), 0)
  }, [model.open])
  const first = model.single ?? model.groups[0]?.results[0]?.href ?? null
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && first) {
      event.preventDefault()
      onOpen?.(first)
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      event.currentTarget.closest('.fw-psearch')?.querySelector<HTMLAnchorElement>('a.fw-presult')?.focus()
    }
  }
  const moveIn = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const links = [...event.currentTarget.querySelectorAll<HTMLAnchorElement>('a.fw-presult')]
    const at = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (at < 0) return
    event.preventDefault()
    if (event.key === 'ArrowUp' && at === 0) input.current?.focus()
    else links[Math.min(links.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1))]?.focus()
  }
  return (
    <Modal open={model.open} onClose={onClose} sheet size="lg" title={t('search.title')}>
      <div className="fw-psearch" onKeyDown={moveIn}>
        <Input
          ref={input}
          type="search"
          value={model.query}
          onChange={(event) => onQuery?.(event.target.value)}
          onKeyDown={onKey}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label')}
          leadingIcon={<Search size={16} aria-hidden />}
          autoComplete="off"
        />
        <div className="fw-psearch-state" role="status" aria-live="polite">
          {model.state === 'tooShort' ? t('search.tooShort') : model.state === 'searching' ? t('search.searching') : model.state === 'ready' ? (model.found > 0 ? t('search.found', { count: model.found }) : t('search.none', { query: model.query })) : ''}
        </div>
        {model.state === 'searching' && model.groups.length === 0 ? (
          <div className="fw-psearch-loading">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} height={48} />
            ))}
          </div>
        ) : null}
        {model.state === 'error' ? (
          <div className="fw-pstate" role="alert">
            <AlertCircle size={18} aria-hidden />
            <span>{t('search.failed')}</span>
            {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
          </div>
        ) : null}
        {model.groups.map((group) => (
          <section key={group.group} className="fw-psearch-group" aria-label={group.label}>
            <h3 className="fw-psearch-head">
              {group.label} <span className="fw-psearch-count">{group.count}</span>
            </h3>
            <ul className="fw-psearch-list">
              {group.results.map((result) => (
                <li key={result.key}>
                  <Link href={result.href} className="fw-presult" onClick={(event) => onOpen?.(result.href, event)}>
                    <RefPair theirs={result.theirs} ours={result.ours} copy={false} match={model.query} size="sm" labels={ds.refPair} />
                    <span className="fw-presult-meta">{[result.subtitle, result.when].filter(Boolean).join(' · ')}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {model.state === 'ready' && model.capped ? <p className="fw-pdialog-text">{t('search.capped')}</p> : null}
      </div>
    </Modal>
  )
}
