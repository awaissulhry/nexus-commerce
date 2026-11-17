'use client'

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Search, X } from 'lucide-react'
import { Button, Input, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { hitSideKey, markWords, type ThreadSearchModel } from '../model'

/** The Head's catalogue (RecordThreadHead's HEAD_NS; named here so the two files do not import each other). */
const HEAD_NS = 'record-thread-head'

export interface ThreadSearchActions {
  onQuery?: (query: string) => void
  /** A hit chosen (click or Enter): the container brings its message on screen, unfolded and focused. */
  onPick?: (messageId: string) => void
  onClose?: () => void
  onRetry?: () => void
}

/**
 * "Search in the thread" (B-TH-288, T1-F08 on B-TH-097; office only): a field laid over the Head row — opened by the search icon, the
 * "⋯" on a phone, or "/" from anywhere in the thread outside a field — and the hits under it, each its side (theirs, ours to them, an
 * office note) and one line of its words with the query's words marked. ↑ / ↓ walk the hits, Enter goes to the message (also one not
 * loaded yet: the container reads older pages until it is there), Esc closes and gives the focus back. The server's index answers
 * (never a search over the messages loaded on screen), and the API re-checked each hit against this thread. Draws its model only.
 */
export function ThreadSearch({ record, model, actions }: { record: string; model: ThreadSearchModel; actions?: ThreadSearchActions }) {
  const t = useT(HEAD_NS)
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(0)
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => setActive(0), [model.hits])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      actions?.onClose?.()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (model.hits.length === 0) return
      event.preventDefault()
      setActive((now) => (now + (event.key === 'ArrowDown' ? 1 : model.hits.length - 1)) % model.hits.length)
    } else if (event.key === 'Enter') {
      const hit = model.hits[active]
      if (!hit) return
      event.preventDefault()
      actions?.onPick?.(hit.id)
    }
  }

  const listed = model.state === 'ready' && model.hits.length > 0
  return (
    <div className="fw-rth-search" role="search" aria-label={t('search.label', { record })}>
      <div className="fw-rth-search-bar">
        <Input
          ref={input}
          size="sm"
          type="search"
          fieldClassName="fw-rth-search-field"
          leadingIcon={<Search size={14} aria-hidden />}
          value={model.query}
          placeholder={t('search.placeholder')}
          aria-label={t('search.label', { record })}
          aria-controls={listed ? listId : undefined}
          aria-activedescendant={listed ? `${listId}-${active}` : undefined}
          aria-expanded={listed}
          role="combobox"
          aria-autocomplete="list"
          onChange={(event) => actions?.onQuery?.(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button size="sm" variant="quiet" aria-label={t('search.close')} onClick={() => actions?.onClose?.()}>
          <X size={14} aria-hidden />
        </Button>
      </div>
      <div className="fw-rth-search-pop">
        {model.state === 'idle' && <p className="fw-rth-search-note">{t('search.hint')}</p>}
        {model.state === 'short' && <p className="fw-rth-search-note">{t('search.short')}</p>}
        {model.state === 'searching' && (
          <p className="fw-rth-search-note" role="status">
            <Spinner size={12} /> {t('search.searching')}
          </p>
        )}
        {model.state === 'failed' && (
          <p className="fw-rth-search-note" role="alert">
            {t('search.failed')}{' '}
            <Button size="sm" variant="quiet" onClick={() => actions?.onRetry?.()}>
              {t('search.retry')}
            </Button>
          </p>
        )}
        {model.state === 'ready' && model.hits.length === 0 && (
          <p className="fw-rth-search-note" role="status">
            {t('search.none')}
          </p>
        )}
        {listed && (
          <>
            <p className="fw-rth-search-note" role="status">
              {t('search.count', { count: model.total })}
            </p>
            <ul id={listId} className="fw-rth-search-hits" role="listbox" aria-label={t('search.results')}>
              {model.hits.map((hit, index) => {
                const words = hit.excerpt && hit.excerpt.trim() !== '' ? hit.excerpt : t('search.noWords')
                return (
                  <li
                    key={hit.id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === active}
                    aria-label={t('search.go', { words })}
                    className={`fw-rth-search-hit${index === active ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => actions?.onPick?.(hit.id)}
                  >
                    <span className="fw-rth-search-side">{t(hitSideKey(hit.direction))}</span>
                    <span className="fw-rth-search-words">
                      {markWords(words, model.words).map((part, at) => (part.hit ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>))}
                    </span>
                  </li>
                )
              })}
            </ul>
            {model.total > model.hits.length && <p className="fw-rth-search-note">{t('search.more', { shown: model.hits.length, count: model.total })}</p>}
          </>
        )}
      </div>
    </div>
  )
}
