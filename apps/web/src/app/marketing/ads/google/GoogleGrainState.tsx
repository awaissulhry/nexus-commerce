'use client'

/**
 * Google Ads step 1b, WB — the one place a grain (ad groups, keywords, negatives, asset groups, search terms, products)
 * says what it has: it failed to load (a danger banner and Try again), Nexus has not read it yet ("Not read yet", no
 * grid, no 0), Google answered with none (one empty state, no grid), or the grid — under the read time and the notes
 * a person needs before trusting a total (a failed last read, a good read that read fewer days — an info note, never an
 * error —, numbers not read, days not read, a list cut at its cap).
 *
 * Words and rules: `grainView` in ./googleGrains.ts. Read only: nothing here changes Google Ads.
 */
import type { ReactNode } from 'react'
import { Banner, EmptyState } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'
import type { GoogleCoverage, GoogleRead } from '@/lib/google-ads/contract'
import { grainView, readLine, type GrainScope, type Noun } from './googleGrains'
import './googleModal.css'

export interface GrainLoad {
  /** True until the first answer for these filters (an older answer may still be on screen). */
  loading: boolean
  /** Whether an answer is on screen. */
  has: boolean
  error: string | null
  reload: () => void
}

export function GoogleGrainState({
  noun, scope, load, read, numbersRead, coverage, count, windowed, truncated = false, nextReadAt, note, above, children,
}: {
  noun: Noun
  scope: GrainScope
  load: GrainLoad
  /** The list's own read (structure, or the terms). */
  read: GoogleRead | null
  /** The daily numbers' read, when it is another one (omit when the list IS its numbers). */
  numbersRead?: GoogleRead | null
  coverage?: GoogleCoverage | null
  /** Rows the answer holds (before any filter in the grid). */
  count: number
  /** The list has days (the page's window). */
  windowed: boolean
  truncated?: boolean
  nextReadAt: string | null
  /** One more thing the list leaves out (a part not read yet), shown with the notes — also over an empty list. */
  note?: string | null
  /** Shown above the grid once the list was read: a brand line, the lists a campaign uses. */
  above?: ReactNode
  /** The grid. */
  children: ReactNode
}) {
  if (load.error) {
    return (
      <Banner tone="danger" title={`The ${noun.many} could not be loaded`} action={<Button onClick={load.reload}>Try again</Button>}>
        {load.error}
      </Banner>
    )
  }
  if (!load.has) return <Skeleton height={240} radius="var(--nds-radius-lg)" />

  const view = grainView({ noun, scope, read, numbersRead, coverage, count, windowed, truncated, nextReadAt })
  const all = note ? [...view.notes, { tone: 'info' as const, text: note }] : view.notes
  const notes = all.map((n) => <Banner key={n.text} tone={n.tone}>{n.text}</Banner>)
  if (view.kind === 'not_read') return <EmptyState title="Not read yet" description={view.text} />
  if (view.kind === 'empty') {
    return notes.length ? (
      <div className="gads-grain">
        {notes}
        <EmptyState title={`No ${noun.many}`} description={view.text} />
      </div>
    ) : <EmptyState title={`No ${noun.many}`} description={view.text} />
  }
  const line = readLine(read)
  return (
    <div className="gads-grain">
      {line && <p className="gads-meta">{line}</p>}
      {notes}
      {above}
      {children}
    </div>
  )
}
