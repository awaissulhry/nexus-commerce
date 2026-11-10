'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ImageOff, LayoutGrid, List } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Checkbox, Pill, SegmentedControl, Skeleton, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { ListKeysInfo } from '../../../../../list-frame/ListKeysInfo'
import type { ListKey } from '../../../../../list-frame/model'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { StyleRow } from '../../api'
import { revisionChips, STATUS_TONE } from '../../model'
import { selectionAfter, swatchColour, type GalleryCard } from '../gallery-model'
import '../gallery.css'

const NS = 'products-gallery'

/** sec:styles.view — List · Gallery (the list's address term `mode`, so a saved view keeps it). */
export function ViewSwitch({ gallery, onChange }: { gallery: boolean; onChange?: (gallery: boolean) => void }) {
  return (
    <WithMessages namespaces={[NS]}>
      <Switch gallery={gallery} onChange={onChange} />
    </WithMessages>
  )
}

function Switch({ gallery, onChange }: { gallery: boolean; onChange?: (gallery: boolean) => void }) {
  const t = useT(NS)
  return (
    <SegmentedControl
      ariaLabel={t('styles.view.label')}
      size="sm"
      value={gallery ? 'gallery' : 'list'}
      onChange={(value) => onChange?.(value === 'gallery')}
      options={[
        { value: 'list', label: t('styles.view.list'), icon: <List size={14} aria-hidden /> },
        { value: 'gallery', label: t('styles.view.gallery'), icon: <LayoutGrid size={14} aria-hidden /> },
      ]}
    />
  )
}

export interface StylesGalleryProps {
  cards: readonly GalleryCard[] | null
  /** Drawn in place of the cards (a failed read, nothing yet, nothing matching); the toolbar stays. */
  state?: ReactNode
  count: ReactNode
  search: ReactNode
  tools: ReactNode
  selected: readonly string[]
  onSelected: (ids: string[]) => void
  /** The bulk actions while cards are selected (the list's own: Export N, Archive N). */
  bulk: ReactNode
  hrefOf: (row: StyleRow) => string
  /** The pictures could not be read (the cards still show their words). */
  looksProblem?: string | null
  more?: { label: string; onMore: () => void } | null
  keys: readonly ListKey[]
  onHelp?: () => void
}

/**
 * SCR-303 — Styles › Gallery (B-W2b-236; design products.styles sec:styles.gallery, "Big pictures for product people and
 * brand reviews"): the list's own rows (the same tiles, filter chips, search and selects) as cards — the main picture
 * whole, code and name, the colourways' swatches, the status and the revisions. A card is a link (Enter opens it); its box
 * selects it (x on a focused card, shift-click a range, the toolbar's box all), and with cards selected the toolbar holds
 * the list's bulk actions. Keys only in the footer's information icon. Composed of DS parts (Checkbox, Pill, Tag,
 * SegmentedControl): the DS MediaGallery is an editor and speaks English only. It fetches nothing.
 */
export function StylesGallery(props: StylesGalleryProps) {
  return (
    <WithMessages namespaces={[NS, 'products', 'lists']}>
      <Gallery {...props} />
    </WithMessages>
  )
}

function Gallery({ cards, state, count, search, tools, selected, onSelected, bulk, hrefOf, looksProblem, more, keys, onHelp }: StylesGalleryProps) {
  const t = useT(NS)
  const tp = useT('products')
  const lists = useT('lists')
  const [anchor, setAnchor] = useState<string | null>(null)
  const grid = useRef<HTMLUListElement>(null)
  const ids = (cards ?? []).map((card) => card.row.id)
  const all = ids.length > 0 && ids.every((id) => selected.includes(id))
  const some = selected.length > 0 && !all
  const latest = useRef({ ids, selected, onSelected })
  latest.current = { ids, selected, onSelected }
  const anchorRef = useRef<string | null>(anchor)
  anchorRef.current = anchor

  // x on a focused card selects it (never while typing or inside a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'x' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const card = target?.closest<HTMLElement>('[data-style-card]')
      if (!card || !grid.current?.contains(card)) return
      event.preventDefault()
      const id = card.dataset['styleCard']!
      const { ids: order, selected: current, onSelected: change } = latest.current
      change(selectionAfter(order, current, id, event.shiftKey, anchorRef.current))
      anchorRef.current = id
      setAnchor(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <section className="fw-sgal" aria-label={t('styles.gallery.label')}>
      <div className="fw-sgal-bar">
        <span className="fw-sgal-bar-left">
          <Checkbox aria-label={lists('selectAll')} checked={all} ref={(input) => {
              if (input) input.indeterminate = some
            }} disabled={ids.length === 0} onChange={(event) => onSelected(event.target.checked ? ids : [])} />
          {selected.length > 0 ? (
            <>
              <span className="fw-sgal-count">{t('styles.gallery.selected', { count: selected.length })}</span>
              {bulk}
            </>
          ) : (
            <>
              {search}
              {tools}
            </>
          )}
        </span>
        <span className="fw-sgal-count" role="status">
          {count}
        </span>
      </div>
      {looksProblem && <Banner tone="warning" title={t(looksProblem)} />}
      {state ? (
        <div className="fw-sgal-state">{state}</div>
      ) : cards === null ? (
        <ul className="fw-sgal-grid" aria-busy="true" aria-label={t('styles.gallery.label')}>
          {Array.from({ length: 8 }, (_, index) => (
            <li key={index} className="fw-sgal-card">
              <Skeleton height={200} />
              <Skeleton height={18} width="60%" />
            </li>
          ))}
        </ul>
      ) : (
        <ul ref={grid} className="fw-sgal-grid" aria-label={t('styles.gallery.label')}>
          {cards.map((card) => {
            const picked = selected.includes(card.row.id)
            const label = `${card.row.code} · ${card.row.name}`
            return (
              <li key={card.row.id} className={picked ? 'fw-sgal-card is-picked' : 'fw-sgal-card'}>
                <Link className="fw-sgal-link" href={hrefOf(card.row)} data-style-card={card.row.id} aria-label={t('styles.gallery.open', { style: label })}>
                  <span className="fw-sgal-frame">
                    {card.src ? (
                      // The picture through the API (kept by the browser), shown whole.
                      <img className="fw-sgal-img" src={card.src} alt={card.caption ?? label} loading="lazy" decoding="async" />
                    ) : card.waiting ? (
                      <Skeleton height={160} />
                    ) : (
                      <span className="fw-sgal-none">
                        <ImageOff size={22} aria-hidden /> {t('styles.gallery.noPicture')}
                      </span>
                    )}
                  </span>
                  <span className="fw-sgal-code">{card.row.code}</span>
                  <span className="fw-sgal-name">{card.row.name}</span>
                </Link>
                <div className="fw-sgal-meta">
                  <span className="fw-sgal-tags">
                    <Pill tone={STATUS_TONE[card.row.status]}>{tp(`status.${card.row.status}`)}</Pill>
                    {revisionChips(card.row).map((chip) => (
                      <Tag key={chip.kind} tone={chip.kind === 'released' ? 'success' : 'info'}>
                        {tp(`list.rev.${chip.kind}`, { revision: chip.revision })}
                      </Tag>
                    ))}
                  </span>
                  {card.swatches.length > 0 && (
                    <span className="fw-sgal-swatches" aria-label={t('styles.gallery.colourways', { count: card.swatches.length })}>
                      {card.swatches.map((swatch) => {
                        const colour = swatchColour(swatch.hex)
                        return (
                          <span key={swatch.code} className="fw-sgal-swatch" title={`${swatch.code} · ${swatch.name}`}>
                            <span className={colour ? 'fw-sgal-chip' : 'fw-sgal-chip is-none'} style={colour ? { backgroundColor: colour } : undefined} aria-hidden />
                            <span className="fw-sgal-chip-code">{swatch.code}</span>
                          </span>
                        )
                      })}
                    </span>
                  )}
                  <Checkbox
                    className="fw-sgal-pick"
                    aria-label={t('styles.gallery.pick', { style: label })}
                    checked={picked}
                    onChange={() => undefined}
                    onClick={(event) => {
                      onSelected(selectionAfter(ids, selected, card.row.id, event.shiftKey, anchor))
                      setAnchor(card.row.id)
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <div className="fw-sgal-foot">
        {more ? (
          <Button size="sm" variant="quiet" onClick={more.onMore}>
            {more.label}
          </Button>
        ) : (
          <span />
        )}
        <ListKeysInfo keys={keys} onHelp={onHelp} />
      </div>
    </section>
  )
}
