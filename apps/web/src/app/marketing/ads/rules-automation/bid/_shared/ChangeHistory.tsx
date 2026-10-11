'use client'

/**
 * Bid page — the ONE History table (2026-10-11, lane FINAL; audit R11). A rule's detail and a keyword's detail showed the
 * same change in two looks (a bordered grid with "Status · Undo" and a plain table with "Who · Status · Undo"). Both now
 * draw this: the DS `NexusGrid plain` (`PanelGrid`), When · (Keyword) · Change · Status · Undo, where Status is who made it
 * (a chip: "You", a rule that opens its detail, the Brain that opens Why), what became of it (`delivery.ts`) and its Undo —
 * or "Can't undo" with the reason on hover and focus, never on a change that is already undone.
 */
import type { ReactNode } from 'react'
import { Undo2 } from 'lucide-react'
import { Button, Tag, Tooltip } from '@/design-system/primitives'
import { EntityLinks, type EntityLinkComponent } from '@/design-system/components'
import { ChangeValue } from '@/design-system/grid'
import Link from '@/lib/workspaces/Link'
import { HeldButton } from '../bids/HeldButton'
import { CHANGE_STATE_TONE, CHANGE_STATE_WORD, type ChangeState, type UndoView } from './delivery'
import { relWords, whenWords } from './format'
import { PanelGrid, type PanelColumn } from './PanelGrid'
import styles from '../bid.module.css'

const WorkspaceLink = Link as unknown as EntityLinkComponent
const ONE = { one: 'item', many: 'items' }

export interface PlaceRef { id: string; name: string; href?: string | null }

/** Who made a change, as its chip: a word, and where it opens (a page, or an action such as the Brain's Why). */
export interface WhoChip { word: string; tone?: 'info' | 'neutral'; href?: string | null; onOpen?: () => void; hint?: string }

export interface HistoryRow {
  id: string
  at: string
  /** The keyword and where it lives (a rule's History lists many keywords; a keyword's own does not). */
  target?: PlaceRef | null
  campaign?: PlaceRef | null
  adGroup?: PlaceRef | null
  change: { label: string; from: string | null; to: string }
  who: WhoChip | null
  state: ChangeState | null
  /** null: this table offers no undo for it (the Brain's own History). */
  undo: UndoView | null
  /** "Undo €0.45 → €0.50 on touring jacket". */
  undoLabel: string
}

/** A keyword and, under it, its campaign (and when, on a phone) — each a link to its page (the DS link, one item). */
export function KeywordCell({ target, campaign, adGroup, when }: { target?: PlaceRef | null; campaign?: PlaceRef | null; adGroup?: PlaceRef | null; when?: string }) {
  return (
    <span className={styles.two}>
      <span className={styles.line}>{target ? <EntityLinks items={[target]} noun={ONE} linkAs={WorkspaceLink} /> : adGroup ? <EntityLinks items={[adGroup]} noun={ONE} linkAs={WorkspaceLink} /> : '—'}</span>
      {(campaign || when) && <span className={styles.subline}>{when && <span className={styles.muted}>{when}</span>}{campaign && <EntityLinks items={[campaign]} noun={ONE} linkAs={WorkspaceLink} />}</span>}
    </span>
  )
}

function Who({ who }: { who: WhoChip }) {
  const chip = <Tag tone={who.tone ?? 'neutral'}>{who.word}</Tag>
  if (who.href) return <Link href={who.href} className={styles.chipLink} title={who.hint ?? who.word}>{chip}</Link>
  if (who.onOpen) return <Button size="xs" variant="link" title={who.hint ?? who.word} onClick={who.onOpen}>{who.word}</Button>
  return chip
}

function Status({ row, undoHeld, onUndo }: { row: HistoryRow; undoHeld: string | null; onUndo: (row: HistoryRow) => void }) {
  const undone = row.state === 'undone'
  return (
    <span className={styles.chips} data-return={`undo:${row.id}`}>
      {row.who && <Who who={row.who} />}
      {row.state && <Tag tone={CHANGE_STATE_TONE[row.state]}>{CHANGE_STATE_WORD[row.state]}</Tag>}
      {row.undo?.kind === 'undo' && !undone && (
        <HeldButton size="xs" variant="secondary" held={undoHeld} onClick={() => onUndo(row)} aria-label={row.undoLabel}>
          <Undo2 size={13} aria-hidden /> Undo…
        </HeldButton>
      )}
      {row.undo?.kind === 'cant' && !undone && (
        <Tooltip label={row.undo.reason} portal><span tabIndex={0} className={styles.cant} aria-label={`${row.undo.word}: ${row.undo.reason}`}>{row.undo.word}</span></Tooltip>
      )}
    </span>
  )
}

const idOf = (r: HistoryRow) => r.id

export function ChangeHistory({ label, rows, keywords, phone, undoHeld, onUndo, statusLabel = 'Status · Undo' }: {
  /** The table's name for a screen reader: "Changes", "Bid history of touring jacket". */
  label: string
  rows: readonly HistoryRow[]
  /** A Keyword column (a rule's History). */
  keywords: boolean
  /** A phone: the time moves under the keyword. */
  phone: boolean
  undoHeld: string | null
  onUndo: (row: HistoryRow) => void
  statusLabel?: string
}): ReactNode {
  const when: PanelColumn<HistoryRow> = { key: 'when', label: 'When', width: 104, render: (r) => <span title={whenWords(r.at)}>{relWords(r.at)}</span> }
  const columns: Array<PanelColumn<HistoryRow>> = [
    ...(phone && keywords ? [] : [when]),
    ...(keywords ? [{ key: 'kw', label: 'Keyword', flex: 1.4, render: (r: HistoryRow) => <KeywordCell target={r.target} campaign={r.campaign} adGroup={r.adGroup} when={phone ? relWords(r.at) : undefined} /> }] : []),
    { key: 'change', label: 'Change', flex: 1, render: (r) => <ChangeValue changes={[{ label: r.change.label, from: r.change.from, to: r.change.to }]} hideLabels /> },
    { key: 'status', label: statusLabel, flex: 1.4, render: (r) => <Status row={r} undoHeld={undoHeld} onUndo={onUndo} /> },
  ]
  return <PanelGrid ariaLabel={label} columns={columns} rows={rows} rowId={idOf} />
}
