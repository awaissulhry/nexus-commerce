'use client'

/**
 * FloorCard — the typed card of a scanned thing at floor size (B-W2b-28, design part FloorCard; A2 G5 "floor result
 * card"): what a scan found, on enrol, sign-in, home, scan, my work, operation, pick, move, pack, receive and more.
 *
 *   <FloorCard icon={<Layers />} kind="Fascio" code="B-000123" title="Giacca Demo · Nero" status={{ label: 'Pronto', tone: 'success' }}
 *              facts={[{ id: 'qty', label: 'Pezzi', value: 20 }, { id: 'op', label: 'Fase', value: 'Op 30 Cucitura' }, …]}
 *              flags={[{ id: 'qc', label: 'In attesa di controllo', tone: 'warning' }]}
 *              asOf={cachedAt} formatTime={(iso) => formatTime(iso, site)} labels={ds.floorCard} />
 *
 * - **Head**: the type icon in its tone, the type word and the code (the code is the card's heading, `headingLevel`
 *   2 by default), an optional title line, the status as an icon-free word in a tinted capsule ("Status: Ready" for a
 *   screen reader).
 * - **Facts**: 4–8 big label / value pairs as a definition list, two to four a row by the card's own width; a fact
 *   with a tone writes its value in that tone (the value is the word: "Manca 1"). At most 8 (`floorCardModel.ts`).
 * - **Flags**: icon + word, tinted by tone; never colour alone.
 * - **As of**: a card from the tablet's cache says "Saved on this tablet · as of 10:42"; a live card shows no time.
 * - `children` go under the card's body (a FloorButton the card itself opens); the screen's main actions stay in the
 *   FloorActionBar.
 * - Sized by the density (`--nds-density-*`): glove-sized on the floor tier, console-sized at standard.
 */
import { createElement, useId, type ReactNode } from 'react'
import { AlertTriangle, Check, Clock, Flag, Info } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import type { FloorTone } from '../tone'
import { FLOOR_CARD_LABELS, type FloorCardLabels } from './FloorCardLabels'
import { floorCardFacts, floorFlagIcon, type FloorCardFact, type FloorCardFlag } from './floorCardModel'
import '../floor.css'
import './floorCard.css'

export interface FloorCardProps {
  /** The type icon (bundle, lot, location, work order). */
  icon: ReactNode
  /** The type word ("Fascio", "Lotto", "Ubicazione"). */
  kind: string
  /** The code read from the label ("B-000123"). */
  code: string
  /** A name line under the code. */
  title?: ReactNode
  /** The status word and its tone. */
  status?: { label: string; tone?: FloorTone }
  /** 4–8 key facts; more are not drawn. */
  facts?: readonly FloorCardFact[]
  flags?: readonly FloorCardFlag[]
  /** When the facts were read from the tablet's cache (ISO). Unset: a live card, no time. */
  asOf?: string | null
  /** Writes `asOf` as a time ("10:42"). Default: the page's language and the browser's zone. */
  formatTime?: (iso: string) => string
  /** The language of the default time (default `en-GB`). */
  locale?: string
  /** Default 2. */
  headingLevel?: 2 | 3 | 4
  /** The card's accent: the status tone by default. */
  tone?: FloorTone
  children?: ReactNode
  labels?: Partial<FloorCardLabels>
  id?: string
}

const FLAG_ICONS = { alert: AlertTriangle, info: Info, check: Check, flag: Flag } as const

function defaultTime(iso: string, locale: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(d)
}

export function FloorCard({
  icon,
  kind,
  code,
  title,
  status,
  facts = [],
  flags = [],
  asOf,
  formatTime,
  locale = 'en-GB',
  headingLevel = 2,
  tone,
  children,
  labels,
  id,
}: FloorCardProps) {
  const lw = mergeLabels(FLOOR_CARD_LABELS, labels)
  const auto = useId()
  const headingId = `${auto}-code`
  const { shown } = floorCardFacts(facts)
  const accent = tone ?? status?.tone ?? 'neutral'
  const heading = createElement(
    `h${headingLevel}`,
    { id: headingId, className: 'nds-floor-card-heading' },
    <span className="nds-floor-card-kind">{kind}</span>,
    ' ',
    <span className="nds-floor-card-code">{code}</span>,
  )

  return (
    <article id={id} className="nds-floor-card" data-tone={accent} aria-labelledby={headingId}>
      <header className="nds-floor-card-head">
        <span className="nds-floor-icon nds-floor-card-icon" aria-hidden>
          {icon}
        </span>
        <div className="nds-floor-card-names">
          {heading}
          {title ? <div className="nds-floor-card-title">{title}</div> : null}
        </div>
        {status ? (
          <span className="nds-floor-card-status" data-tone={status.tone ?? 'neutral'}>
            <span className="nds-floor-sr">{lw.status}: </span>
            {status.label}
          </span>
        ) : null}
      </header>
      {shown.length ? (
        <dl className="nds-floor-card-facts" aria-label={lw.facts}>
          {shown.map((f) => (
            <div key={f.id} className="nds-floor-card-fact" data-tone={f.tone}>
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {flags.length ? (
        <ul className="nds-floor-card-flags" aria-label={lw.flags}>
          {flags.map((f) => (
            <li key={f.id} className="nds-floor-card-flag" data-tone={f.tone ?? 'warning'}>
              <span className="nds-floor-icon" aria-hidden>
                {createElement(FLAG_ICONS[floorFlagIcon(f.tone)])}
              </span>
              <span>{f.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {children ? <div className="nds-floor-card-more">{children}</div> : null}
      {asOf ? (
        <p className="nds-floor-card-asof">
          <span className="nds-floor-icon" aria-hidden>
            <Clock />
          </span>
          {lw.cachedAt((formatTime ?? ((iso: string) => defaultTime(iso, locale)))(asOf))}
        </p>
      ) : null}
    </article>
  )
}
