'use client'

import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Search } from 'lucide-react'
import { Modal } from '@nexus/ui/components'
import { Input } from '@nexus/ui/primitives'
import { useT } from '../../../lib/i18n/provider'
import type { CompanyRef } from '../../../lib/session/session'
import { matchCompanies } from '../switcher-search'
import '../scope.css'

/**
 * B-W2b-05 (design shell.scope sec:switcher: "search when more than 7"): the switcher's company finder — a field that
 * narrows the companies by name or code as you type, and the companies as real links (the same page in that company;
 * ⌘-click or ⌘Enter opens it in a new tab). ↓ from the field goes to the first company, ↑ / ↓ between them, Esc closes.
 * Composed from the DS Modal and Input (the DS Menu has no search field).
 */
export interface CompanyFinderProps {
  open: boolean
  companies: readonly CompanyRef[]
  /** The current company's code (marked). */
  current: string
  /** A company's address (the same page there). */
  hrefOf: (code: string) => string
  onClose: () => void
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void
  /** Design cases: the field's text. */
  query?: string
}

export function CompanyFinder({ open, companies, current, hrefOf, onClose, onNavigate, query: startQuery = '' }: CompanyFinderProps) {
  const t = useT('shell')
  const [query, setQuery] = useState(startQuery)
  const list = useRef<HTMLUListElement>(null)
  const found = useMemo(() => matchCompanies(companies, query), [companies, query])
  const focusRow = (index: number) => list.current?.querySelectorAll<HTMLAnchorElement>('a')[index]?.focus()
  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const rows = [...(list.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLAnchorElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusRow(Math.min(rows.length - 1, at + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (at <= 0) list.current?.closest('.fw-company-finder')?.querySelector<HTMLInputElement>('input')?.focus()
      else focusRow(at - 1)
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && at >= 0) {
      event.preventDefault()
      window.open(rows[at]!.href, '_blank', 'noopener')
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={t('switcher.finder.title')} size="sm">
      <div className="fw-company-finder">
        <Input
          type="search"
          autoFocus
          leadingIcon={<Search size={14} aria-hidden />}
          aria-label={t('switcher.finder.search')}
          placeholder={t('switcher.finder.placeholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              focusRow(0)
            }
          }}
        />
        <p className="fw-company-finder-empty" role="status">
          {found.length === 0 ? t('switcher.finder.none', { query }) : t('switcher.finder.count', { count: found.length })}
        </p>
        {found.length > 0 && (
          <ul ref={list} className="fw-company-finder-list" aria-label={t('switcher.companies')} onKeyDown={onListKey}>
            {found.map((company) => {
              const href = hrefOf(company.code)
              return (
                <li key={company.code}>
                  <a
                    className="fw-company-finder-row"
                    href={href}
                    aria-current={company.code === current ? 'true' : undefined}
                    onClick={(event) => {
                      onNavigate?.(event, href)
                      if (event.defaultPrevented) onClose()
                    }}
                  >
                    <span>{company.name}</span>
                    <span className="fw-company-finder-code">{company.code}</span>
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
