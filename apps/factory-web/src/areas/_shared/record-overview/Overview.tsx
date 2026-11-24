'use client'

import { useMemo, type ReactNode } from 'react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { catalogueFor, createTranslator } from '../../../lib/i18n/messages'
import { useLocale, useReader } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { OVERVIEW_NS } from './model'
import './record-overview.css'

/**
 * F-CO-K1 (customer overview lane: the shared overview kit) — the parts a record page's Overview is drawn with. ONE look on every
 * page: a part has NO look prop; a page hands it data and doors (a ReactNode), nothing else. A part owns its stylesheet (this file
 * imports it), fetches nothing, imports no area and speaks only its own catalogue (`record-overview`). Each part emits the DOM the
 * order's Overview drew by hand before it moved here; the Overview-only class names are kept (fw-so-overview, fw-so-ov-*,
 * fw-so-where*, fw-so-headline), the text classes a part draws are the kit's own (fw-ro-*).
 *
 * The frame (this step): `Overview` (the tab's column and the room its pairs read), `OverviewPair` (two cards side by side from
 * 720 px of the Overview, one below; a card alone takes the row), `OverviewCard` (the card with its title), `Headline` (the lead
 * card's sentence and its quiet line), `CardState` (a card while its part loads, or when its read failed), `useOverviewWords`.
 */

/** The kit's own words in the page's language. */
export interface OverviewWords {
  /** "Loading {part}…" */
  readonly loading: (part: string) => string
  /** "Couldn't load {part}" */
  readonly failed: (part: string) => string
  /** "Try again" */
  readonly retry: string
}

/**
 * The kit's words, read straight from its catalogue as the DS parts read theirs (no provider needed): a part says the same words
 * wherever a page draws it — inside an `Overview`, in the component that draws the `Overview`, or on a tab that has none.
 */
export function useOverviewWords(): OverviewWords {
  const locale = useLocale()
  const reader = useReader()
  return useMemo<OverviewWords>(() => {
    const t = createTranslator(locale, catalogueFor(locale, OVERVIEW_NS, reader))
    return {
      loading: (part) => t('state.loading', { part }),
      failed: (part) => t('state.failed', { part }),
      retry: t('state.retry'),
    }
  }, [locale, reader])
}

/**
 * The tab: its cards one under the other, 16 px apart. It is the room the pairs read (its own width, not the page's: a thread
 * docked beside it or not), and every card under it is a room of its own for its rows. Its children also find the kit's catalogue.
 */
export function Overview({ children }: { children?: ReactNode }): ReactNode {
  return (
    <WithMessages namespaces={[OVERVIEW_NS]}>
      <div className="fw-so-overview">{children}</div>
    </WithMessages>
  )
}

/** Two cards in one row while the Overview is 720 px or wider, one under the other below; one card alone takes the whole row. */
export function OverviewPair({ children }: { children?: ReactNode }): ReactNode {
  return <div className="fw-so-ov-pair">{children}</div>
}

/**
 * A card with its title (an `h2`). `aside` is the head's right side — a link, a status line, a quiet button: left out
 * (`undefined`), the title stands alone; given, even as `null`, the title sits in the head row (so a head keeps its shape while
 * its right side has nothing to say). `lead`: the Overview's first card, a column with one gap between its parts (it holds the
 * `Headline`). `busy`: the card's part is still read. `className`: a host's hook for its tests only — no rule of the kit reads it,
 * and a host never styles a kit class through it.
 */
export function OverviewCard({ title, aside, lead = false, busy = false, className, children }: { title: ReactNode; aside?: ReactNode; lead?: boolean; busy?: boolean; className?: string; children?: ReactNode }): ReactNode {
  const classes = [lead ? 'fw-so-where' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <Card padded className={classes || undefined} aria-busy={busy ? 'true' : undefined}>
      {aside === undefined ? (
        <h2 className="fw-ro-h2">{title}</h2>
      ) : (
        <div className="fw-ro-head">
          <h2 className="fw-ro-h2">{title}</h2>
          {aside}
        </div>
      )}
      {children}
    </Card>
  )
}

/**
 * The lead card's sentence: what the record is doing now, large, with one quiet line under it. `sentence` null: it is still read
 * (a placeholder of the sentence's size, and no quiet line).
 */
export function Headline({ sentence, quiet = null }: { sentence: string | null; quiet?: string | null }): ReactNode {
  return (
    <div className="fw-so-where-said">
      {sentence === null ? <Skeleton width={260} height={24} /> : <p className="fw-so-headline">{sentence}</p>}
      {sentence !== null && quiet ? <p className="fw-ro-hint">{quiet}</p> : null}
    </div>
  )
}

/**
 * A whole card while its part loads ("Loading {part}…"), or when its read failed: "Couldn't load {part}", why in WORDS (the page's
 * own sentence, never a key) and Try again when the page can read it again. Never drawn as an empty card. `problem` null: loading.
 */
export function CardState({ part, problem, onRetry }: { part: string; problem: string | null; onRetry?: () => void }): ReactNode {
  const words = useOverviewWords()
  if (problem) {
    return (
      <Card padded>
        <EmptyState
          title={words.failed(part)}
          description={problem}
          action={
            onRetry ? (
              <Button size="sm" onClick={onRetry}>
                {words.retry}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  }
  return (
    <Card padded aria-busy="true">
      <p className="fw-ro-hint" role="status">
        <Spinner size={14} /> {words.loading(part)}
      </p>
    </Card>
  )
}
