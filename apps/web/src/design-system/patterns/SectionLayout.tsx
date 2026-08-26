'use client'

/**
 * GX.6 — a page of panels the operator arranges: order, visibility, and how wide each one sits.
 *
 * ── Why this is not a new dialog ──────────────────────────────────────────────
 *
 * The platform already decided there is ONE Customize dialog — `PreferencesModal` — and every
 * grid opens it for columns. Order and visibility of sections is the same problem in the same
 * shape (an ordered list of things you can drag and switch off), so this reuses that dialog
 * unchanged: `allColumns` takes the sections, `visibleColumns` comes back holding both the set
 * and the order. Nothing about the modal changes, and a second "arrange" dialog never exists.
 *
 * Width is the one thing that does NOT belong in a dialog. You are choosing how a panel looks
 * against the panels beside it, and you cannot see that from inside a modal — so the width
 * control sits on the section itself, and only while arranging.
 *
 * ── Steps, not pixels ─────────────────────────────────────────────────────────
 *
 * Widths snap to half / two-thirds / full of a six-column grid. Free pixel dragging produces a
 * layout that is exactly right on the screen it was made on and broken on the next one, and
 * every panel here holds a chart or a table that has its own minimum readable width. `dense`
 * auto-flow lets a later half-width panel backfill the gap a two-thirds one leaves, so the page
 * has no holes in it.
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 *
 * localStorage per `storageKey`, in the same shape and with the same rules as the grid's
 * `GridPrefs`: `order` carries the set AND the sequence, so there is one source of truth rather
 * than a Set beside an array that can disagree. Deliberately the same mechanism the column
 * dialog already uses — a second persistence model for the same gesture is the inconsistency
 * this pattern exists to avoid. (Neither is server-side yet; when one moves, both should.)
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Button } from '@/design-system/primitives/Button'
import { emitPrefsChanged } from './prefs-bus'

export type SectionWidth = 'half' | 'two-thirds' | 'full'

const WIDTH_SPAN: Record<SectionWidth, number> = { half: 3, 'two-thirds': 4, full: 6 }
const WIDTH_ORDER: SectionWidth[] = ['half', 'two-thirds', 'full']
const WIDTH_LABEL: Record<SectionWidth, string> = { half: 'Half', 'two-thirds': 'Two-thirds', full: 'Full' }

export interface SectionSpec {
  id: string
  label: string
  /** Cannot be hidden or reordered — the panel the tab exists for. */
  locked?: boolean
  /** Where it sits before the operator has an opinion. */
  defaultWidth?: SectionWidth
  /**
   * GX.7 — ships switched OFF, and is found in the Sections dialog rather than chosen for you.
   *
   * For panels that are genuinely useful to some operators and noise to others. It is not a
   * place to put half-finished work: a hidden section still has to be correct the first time
   * someone turns it on, and nobody will be watching when they do.
   */
  defaultHidden?: boolean
}

export interface SectionLayoutValue {
  /** Visible sections IN ORDER. Holds the set and the sequence together, like `GridPrefs.visible`. */
  order: string[]
  widths: Record<string, SectionWidth>
}

export interface SectionLayoutProps {
  sections: readonly SectionSpec[]
  /** Rendered content by section id. A section with no child is skipped rather than drawn empty. */
  children: Record<string, ReactNode>
  storageKey: string
  /** True while the operator is arranging: width controls appear on each section. */
  editing?: boolean
  /** Notified whenever the layout changes, so a page can show its own Done affordance. */
  onChange?: (value: SectionLayoutValue) => void
  className?: string
}

/** The default layout for a set of sections — everything visible, in declared order. */
export function defaultSectionLayout(sections: readonly SectionSpec[]): SectionLayoutValue {
  return {
    order: sections.filter((s) => !s.defaultHidden).map((s) => s.id),
    widths: Object.fromEntries(sections.map((s) => [s.id, s.defaultWidth ?? 'full'])),
  }
}

/**
 * Read a stored layout, dropping ids that no longer exist and appending sections that did not
 * exist when it was saved.
 *
 * Both halves matter. Trusting a stored id that has since been removed renders nothing; dropping
 * a NEW section because it is absent from an old saved layout means shipping a panel that nobody
 * who has ever opened the page can see — the failure mode is invisible and permanent.
 */
export function readSectionLayout(storageKey: string, sections: readonly SectionSpec[]): SectionLayoutValue {
  const fallback = defaultSectionLayout(sections)
  let stored: Partial<SectionLayoutValue> | null = null
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) stored = JSON.parse(raw) as Partial<SectionLayoutValue>
  } catch { /* unreadable — fall through to the defaults */ }
  if (!stored || !Array.isArray(stored.order)) return fallback

  const known = new Set(sections.map((s) => s.id))
  const kept = stored.order.filter((id) => known.has(id))
  // A section the operator has never seen cannot have been hidden by them — EXCEPT one that ships
  // hidden, which is absent from a saved layout for exactly the reason it is absent from a fresh
  // one. Turning those on unasked would defeat the point of shipping them off.
  const added = sections
    .filter((s) => !s.defaultHidden && !stored!.order!.includes(s.id))
    .map((s) => s.id)
  const locked = sections.filter((s) => s.locked && !kept.includes(s.id)).map((s) => s.id)

  return {
    order: [...new Set([...locked, ...kept, ...added])],
    widths: Object.fromEntries(sections.map((s) => [
      s.id,
      (stored?.widths?.[s.id] && WIDTH_ORDER.includes(stored.widths[s.id]))
        ? stored.widths[s.id]
        : (s.defaultWidth ?? 'full'),
    ])),
  }
}

export function writeSectionLayout(storageKey: string, value: SectionLayoutValue): void {
  try { localStorage.setItem(storageKey, JSON.stringify(value)) } catch { /* private mode — in-session only */ }
  // Announced AFTER the write, so a listener that reads the key back gets the new value.
  emitPrefsChanged(storageKey)
}

export function SectionLayout({
  sections, children, storageKey, editing = false, onChange, className,
}: SectionLayoutProps) {
  const [value, setValue] = useState<SectionLayoutValue>(() => defaultSectionLayout(sections))

  // Seeded from the defaults and read from storage on mount, not in the initializer: the
  // initializer runs during render, where `localStorage` is not available on the server.
  useEffect(() => {
    setValue(readSectionLayout(storageKey, sections))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey])

  const update = useCallback((next: SectionLayoutValue) => {
    setValue(next)
    writeSectionLayout(storageKey, next)
    onChange?.(next)
  }, [storageKey, onChange])

  const cycleWidth = useCallback((id: string) => {
    const cur = value.widths[id] ?? 'full'
    const next = WIDTH_ORDER[(WIDTH_ORDER.indexOf(cur) + 1) % WIDTH_ORDER.length]
    update({ ...value, widths: { ...value.widths, [id]: next } })
  }, [value, update])

  const specs = useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections])

  return (
    <div className={`nds-sections${editing ? ' is-editing' : ''}${className ? ` ${className}` : ''}`}>
      {value.order.map((id) => {
        const spec = specs.get(id)
        const node = children[id]
        // A declared section with nothing to render is skipped, not drawn as an empty card.
        if (!spec || node == null) return null
        const width = value.widths[id] ?? spec.defaultWidth ?? 'full'
        return (
          <section key={id} className="nds-section" style={{ gridColumn: `span ${WIDTH_SPAN[width]}` }}>
            {editing && (
              <div className="nds-section-bar">
                <span className="nds-section-name">{spec.label}</span>
                <Button size="sm" onClick={() => cycleWidth(id)} aria-label={`${spec.label} width — currently ${WIDTH_LABEL[width]}`}>
                  {WIDTH_LABEL[width]}
                </Button>
              </div>
            )}
            {node}
          </section>
        )
      })}
    </div>
  )
}
