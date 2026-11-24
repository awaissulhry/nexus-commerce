'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Card, EmptyState } from '@nexus/ui/components'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { CircleAlert } from 'lucide-react' // F-CO-K2: the failed read's strip mark
import { catalogueFor, createTranslator } from '../../../lib/i18n/messages'
import { useLocale, useReader } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { OVERVIEW_NS, STRIPS_SHOWN, type StripTone } from './model'
import './record-overview.css'

/**
 * F-CO-K1 (customer overview lane: the shared overview kit) — the parts a record page's Overview is drawn with. ONE look on every
 * page: a part has NO look prop; a page hands it data and doors (a ReactNode), nothing else. A part owns its stylesheet (this file
 * imports it), fetches nothing, imports no area and speaks only its own catalogue (`record-overview`). Each part emits the DOM the
 * order's Overview drew by hand before it moved here; the Overview-only class names are kept (fw-so-overview, fw-so-ov-*,
 * fw-so-where*, fw-so-headline), the text classes a part draws are the kit's own (fw-ro-*).
 *
 * The frame (F-CO-K1): `Overview` (the tab's column and the room its pairs read), `OverviewPair` (two cards side by side from
 * 720 px of the Overview, one below; a card alone takes the row), `OverviewCard` (the card with its title), `Headline` (the lead
 * card's sentence and its quiet line), `CardState` (a card while its part loads, or when its read failed), `useOverviewWords`.
 * The rows (F-CO-K2): `Strips`, `Strip`, `StripSaid` (what stops the record, one row each, most blocking first); `RowList`, `Row`,
 * `QuietLine` (a card's ONE list: label | value | doors, on the list's own columns).
 */

/** The kit's own words in the page's language. */
export interface OverviewWords {
  /** "Loading {part}…" */
  readonly loading: (part: string) => string
  /** "Couldn't load {part}" */
  readonly failed: (part: string) => string
  /** "Try again" */
  readonly retry: string
  // ---- F-CO-K2: the rows' words ----
  /** "Show {count} more" (the strips under their cap) */
  readonly showMore: (count: number) => string
  /** "Show fewer" */
  readonly showFewer: string
  /** "None yet: {kinds}" (a list's kinds at zero, in one quiet line) */
  readonly none: (kinds: string) => string
  /** "{value} ›" — a door's words; its arrow never stands alone on a line (a no-break space before "›") */
  readonly door: (value: string) => string
  /** "{label}: {value}" */
  readonly labelled: (label: string, value: string) => string
  /** "Could not be read" (of several: a row of a list) */
  readonly unreadMany: string
  /** "Could not be read" (of one: a fact) */
  readonly unreadOne: string
  // ---- end F-CO-K2
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
      // F-CO-K2: the rows' words
      showMore: (count) => t('strips.showMore', { count }),
      showFewer: t('strips.showFewer'),
      none: (kinds) => t('row.none', { kinds }),
      // S31: the order's own rule (F-OM-fx6), now the kit's for every page — "Open ›" never breaks before its arrow.
      door: (value) => t('row.door', { value }).replace(/ ›$/, '\u00a0›'),
      labelled: (label, value) => t('row.labelled', { label, value }),
      unreadMany: t('row.unreadMany'),
      unreadOne: t('row.unreadOne'),
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

// ---- F-CO-K2 (the shared overview kit's rows): the strips — what stops the record, one row each, most blocking first ----------------
/**
 * The strips' list under the lead card's headline: at most `cap` rows, the rest behind "Show {n} more" (its own state); while the
 * page still reads them, one quiet row; a failed read is the list's last row, with Try again when the page hands a retry. `rows` are
 * the page's `Strip`s, ALL of them (the cap is the kit's). The box is always drawn: "no strips at all" is the page's to decide.
 */
export function Strips({ label, rows, cap = STRIPS_SHOWN, reading = false, failed = null }: { label: string; rows: readonly ReactNode[]; cap?: number; reading?: boolean; failed?: { words: string; onRetry?: () => void } | null }): ReactNode {
  const words = useOverviewWords()
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, cap)
  return (
    <div className="fw-so-strips-box">
      <ul className="fw-so-strips" aria-label={label}>
        {shown}
        {reading && (
          <li className="fw-so-strip-reading">
            <Skeleton height={22} />
          </li>
        )}
        {failed && (
          <Strip
            tone="danger"
            mark={<CircleAlert size={14} aria-hidden />}
            doors={
              failed.onRetry ? (
                <Button size="sm" onClick={failed.onRetry}>
                  {words.retry}
                </Button>
              ) : undefined
            }
          >
            {failed.words}
          </Strip>
        )}
      </ul>
      {rows.length > cap && (
        <Button size="sm" variant="quiet" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? words.showFewer : words.showMore(rows.length - cap)}
        </Button>
      )}
    </div>
  )
}

/**
 * One strip: the shared card row (mark | words | doors) with a left rule in its tone. `children` is what the row says (a
 * `StripSaid`, or the page's own words). `doors`: the doors cell is drawn only when doors are handed over. `anchor`: the row's own
 * address (an `id`, reached by a link: it takes the focus then).
 */
export function Strip({ tone, mark, doors, anchor, children }: { tone: StripTone; mark: ReactNode; doors?: ReactNode; anchor?: string; children?: ReactNode }): ReactNode {
  return (
    <li className="fw-so-ov-row fw-so-strip" data-tone={tone} id={anchor} tabIndex={anchor === undefined ? undefined : -1}>
      <span className="fw-so-strip-mark">{mark}</span>
      <span className="fw-so-strip-said">{children}</span>
      {doors ? <span className="fw-so-ov-doors">{doors}</span> : null}
    </li>
  )
}

/**
 * What a strip says: its title with how long it has stood ("· 3 d", its exact day in the title), then its quiet lines, one under
 * the other. `since` null: no age is said.
 */
export function StripSaid({ title, since = null, lines = [] }: { title: ReactNode; since?: { iso: string; day: string; words: string } | null; lines?: readonly string[] }): ReactNode {
  return (
    <>
      <span>
        {title}
        {since ? (
          <>
            {' · '}
            <time dateTime={since.iso} title={since.day}>
              {since.words}
            </time>
          </>
        ) : null}
      </span>
      {lines.map((line) => (
        <span key={line} className="fw-ro-hint">
          {line}
        </span>
      ))}
    </>
  )
}
// ---- end F-CO-K2 (strips)

// ---- F-CO-K2 (the shared overview kit's rows): the ONE list — label | value | doors, every row on the list's own columns ----------
/**
 * A card's list of rows. Its rows lie on the list's own columns (subgrid), so every label, value and door lines up with the rows
 * above it; below a 480 px card the doors wrap under the value, to the right; below a 360 px card (a phone) a row stacks. `label`:
 * the list's name for a screen reader (left out: none).
 */
export function RowList({ label, children }: { label?: string; children?: ReactNode }): ReactNode {
  return (
    <ul className="fw-so-ov-list" aria-label={label}>
      {children}
    </ul>
  )
}

/**
 * One row: its label (quiet), then what the page hands as `children` (the value: words, a link, a part that draws its own value and
 * doors), then its doors. `doors` left out (undefined): no doors cell; `null`: an EMPTY doors cell (a list whose rows keep the
 * door's column even when one has none).
 */
export function Row({ label, doors, children }: { label: ReactNode; doors?: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <li className="fw-so-ov-row">
      <span className="fw-so-ov-label">{label}</span>
      {children}
      {doors === undefined ? null : <span className="fw-so-ov-doors">{doors}</span>}
    </li>
  )
}

/** A quiet line of the list, the whole row wide ("None yet: …", where the record came from, a list held for this reader). */
export function QuietLine({ children }: { children?: ReactNode }): ReactNode {
  return <li className="fw-so-ov-quiet fw-ro-hint">{children}</li>
}
// ---- end F-CO-K2 (the ONE list)
