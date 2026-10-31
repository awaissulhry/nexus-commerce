'use client'

/**
 * LawRef — an inline chip naming a law, with what it says in plain words and the official link (B-W2b-28, design part
 * LawRef): the same look on every page, wherever a rule, a limit or a held button comes from a law.
 *
 *   <LawRef law="D.Lgs. 81/2008 art. 37" plain="Ogni lavoratore riceve una formazione sufficiente e adeguata …"
 *           href="https://www.normattiva.it/…" labels={ds.lawRef} />
 *
 * - A real button (the DS `DetailPopover`, a toggletip): click, Enter, Space or a resting pointer opens a small panel
 *   with the plain words and the official link; Esc closes and gives the focus back. Reachable by touch and keyboard —
 *   not a hover-only tooltip (`HoverCard` cannot hold a link).
 * - The law's name is always on screen, so the reason for a limit is readable as text; `lawRefText()` gives the same
 *   words for a print or a held reason.
 * - The official link opens a new tab and says so.
 */
import { ExternalLink, Scale } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { DetailPopover } from '../DetailPopover'
import { LAW_REF_LABELS, type LawRefLabels } from './LawRefLabels'
import './lawRef.css'

export interface LawRefProps {
  /** The law's short name ("D.Lgs. 81/2008 art. 37", "Statuto dei Lavoratori art. 4"). */
  law: string
  /** What it says, in plain words. */
  plain: string
  /** The official text (Normattiva, EUR-Lex). */
  href?: string | null
  /** ms a pointer rests on the chip before it opens (default 350; 0 = click and keyboard only). */
  hoverDelay?: number
  labels?: Partial<LawRefLabels>
}

/** The law and its plain words as one line of text: "D.Lgs. 81/2008 art. 37 — Training …". */
export function lawRefText(law: string, plain: string): string {
  const p = plain.trim()
  return p ? `${law} — ${p}` : law
}

export function LawRef({ law, plain, href, hoverDelay, labels }: LawRefProps) {
  const lw = mergeLabels(LAW_REF_LABELS, labels)
  return (
    <DetailPopover
      trigger={
        <span className="nds-lawref">
          <Scale className="nds-lawref-icon" aria-hidden />
          <span className="nds-lawref-law">{law}</span>
        </span>
      }
      triggerLabel={lw.about(law)}
      triggerClassName="nds-lawref-trigger"
      panelClassName="nds-lawref-panel"
      label={law}
      hoverDelay={hoverDelay}
    >
      <div className="nds-lawref-head">{law}</div>
      <p className="nds-lawref-plain">{plain}</p>
      {href ? (
        <a className="nds-lawref-link" href={href} target="_blank" rel="noopener noreferrer">
          {lw.official}
          <ExternalLink className="nds-lawref-link-icon" aria-hidden />
          <span className="nds-vh"> ({lw.newTab})</span>
        </a>
      ) : null}
    </DetailPopover>
  )
}
