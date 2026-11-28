'use client'

import { useState, type ReactNode } from 'react'
import { Camera, CircleCheck, Eye, FileText, Send, Trash2, Undo2 } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { WaitChip } from '../model'
import '../sheet.css'

/**
 * owb-po7.2 + po7.3 — the orders sheet's own parts (design § 5h, § 5zj A; prototype portal.js `draftsBar`, `sentBanner`, sheet.js
 * `newsChips`, oplus.js `coverBtn`): the drafts bar (open a draft, its bin asks first, "Send…", "Delete the drafts" asks first), the
 * line after Send with "Take it back" while the factory has not confirmed, the "Withdrawn" chip, the "Waits · news" chips (each a door)
 * and the picture as a button (a camera on hover; always on a phone). Words: `portal-ordering` › `ordersSheet` (IT "voi").
 */
export const SHEET_NS = 'portal-ordering'

export interface DraftsBarModel {
  readonly drafts: readonly { readonly id: string; readonly title: string | null; readonly href: string }[]
  /** Why Send… waits (words: a colleague who may not order, offline, a preview), or null. */
  readonly sendHeld: string | null
  /** Why a delete waits (words), or null. */
  readonly deleteHeld: string | null
  readonly busy: boolean
}

export interface DraftsBarActions {
  readonly onSend?: () => void
  readonly onDelete?: (ids: readonly string[]) => void
}

export function DraftsBar({ model, actions }: { model: DraftsBarModel; actions?: DraftsBarActions }) {
  const t = useT(SHEET_NS)
  const [asking, setAsking] = useState<'all' | string | null>(null)
  if (model.drafts.length === 0) return null
  const name = (title: string | null) => title ?? t('ordersSheet.noSubject')
  const askingOne = asking && asking !== 'all' ? model.drafts.find((draft) => draft.id === asking) : undefined
  if (asking) {
    return (
      <Banner
        tone="warning"
        icon={<Trash2 size={16} aria-hidden />}
        title={askingOne ? t('ordersSheet.deleteOne', { title: name(askingOne.title) }) : t('ordersSheet.deleteAll', { count: model.drafts.length })}
        action={
          <span className="fw-pos-acts">
            <Button size="sm" onClick={() => setAsking(null)}>
              {t('ordersSheet.cancel')}
            </Button>
            <Button
              size="sm"
              variant="danger"
              heldReason={model.deleteHeld}
              onClick={() => {
                const ids = askingOne ? [askingOne.id] : model.drafts.map((draft) => draft.id)
                setAsking(null)
                actions?.onDelete?.(ids)
              }}
            >
              <Trash2 size={14} aria-hidden /> {t('ordersSheet.delete')}
            </Button>
          </span>
        }
      />
    )
  }
  return (
    <div className="fw-pos-drafts" role="group" aria-label={t('ordersSheet.drafts', { count: model.drafts.length })}>
      <FileText size={16} aria-hidden />
      <strong>{t('ordersSheet.drafts', { count: model.drafts.length })}</strong>
      {model.drafts.slice(0, 4).map((draft) => (
        <span key={draft.id} className="fw-pos-draft">
          <a href={draft.href} className="fw-pos-link" title={t('ordersSheet.openDraft')}>
            {name(draft.title)}
          </a>
          <Button size="sm" variant="quiet" aria-label={t('ordersSheet.deleteThis', { title: name(draft.title) })} heldReason={model.deleteHeld} onClick={() => setAsking(draft.id)}>
            <Trash2 size={14} aria-hidden />
          </Button>
        </span>
      ))}
      {model.drafts.length > 4 ? <span className="fw-pos-quiet">{t('ordersSheet.more', { count: model.drafts.length - 4 })}</span> : null}
      <span className="fw-pos-grow" />
      <span className="fw-pos-quiet">{t('ordersSheet.notSent')}</span>
      <Button size="sm" variant="quiet" heldReason={model.deleteHeld} onClick={() => setAsking('all')}>
        <Trash2 size={14} aria-hidden /> {t('ordersSheet.deleteDrafts')}
      </Button>
      <Button size="sm" variant="primary" heldReason={model.sendHeld ?? (model.busy ? t('ordersSheet.busy') : null)} onClick={() => actions?.onSend?.()}>
        <Send size={14} aria-hidden /> {t('ordersSheet.send')}
      </Button>
    </div>
  )
}

export interface SentLineModel {
  readonly titles: readonly (string | null)[]
  /** Some of them may still be taken back (the factory has not confirmed). */
  readonly takeBack: boolean
  readonly busy: boolean
  /** A refusal of Take it back in words (the server's), or null. */
  readonly refused: string | null
}

/** After Send: ONE green line that says what went, with Take it back until the factory confirms (settle 3: no number before Confirm). */
export function SentLine({ model, onTakeBack, onOk }: { model: SentLineModel; onTakeBack?: () => void; onOk?: () => void }) {
  const t = useT(SHEET_NS)
  const one = model.titles.length === 1
  const title = one ? t('ordersSheet.sentOne', { title: model.titles[0] ?? t('ordersSheet.noSubject') }) : t('ordersSheet.sentMany', { count: model.titles.length })
  return (
    <Banner
      tone={model.refused ? 'warning' : 'success'}
      icon={<CircleCheck size={16} aria-hidden />}
      title={title}
      action={
        <span className="fw-pos-acts">
          {model.takeBack ? (
            <Button size="sm" heldReason={model.busy ? t('ordersSheet.busy') : null} onClick={() => onTakeBack?.()}>
              <Undo2 size={14} aria-hidden /> {one ? t('ordersSheet.takeBack') : t('ordersSheet.takeBackAll')}
            </Button>
          ) : null}
          <Button size="sm" variant="quiet" onClick={() => onOk?.()}>
            {t('ordersSheet.ok')}
          </Button>
        </span>
      }
    >
      {model.refused ? <p>{model.refused}</p> : <p>{t('ordersSheet.sentBody')}</p>}
    </Banner>
  )
}

/** "Withdrawn n": withdrawn orders are kept but hidden; the chip shows them again (pressed). */
export function WithdrawnChip({ count, shown, onToggle }: { count: number; shown: boolean; onToggle?: () => void }) {
  const t = useT(SHEET_NS)
  if (count === 0) return null
  return (
    <Button size="sm" variant={shown ? 'secondary' : 'quiet'} aria-pressed={shown} title={t('ordersSheet.withdrawnHint')} onClick={() => onToggle?.()}>
      <Eye size={14} aria-hidden /> {t('ordersSheet.withdrawn', { count })}
    </Button>
  )
}

/** The "Waits · news" chips of a row: each a door (the chat, the design, the order). */
export function WaitsChips({ chips, onChip }: { chips: readonly WaitChip[]; onChip?: (chip: WaitChip) => void }) {
  const t = useT(SHEET_NS)
  if (chips.length === 0) return <span className="fw-pos-quiet">—</span>
  return (
    <span className="fw-pos-chips">
      {chips.map((chip) => (
        <button key={chip.kind} type="button" className="fw-pos-chip" data-tone={chip.tone} onClick={() => onChip?.(chip)}>
          <Tag tone={chip.tone}>{t(`ordersSheet.${chip.key}`, { count: chip.count ?? 1 })}</Tag>
        </button>
      ))}
    </span>
  )
}

/** The picture of a row as a button: a camera shows on hover (always on a phone); the window "The picture of the order" opens. */
export function PictureButton({ picture, label, onPress }: { picture: ReactNode; label: string; onPress: () => void }) {
  return (
    <button type="button" className="fw-pos-pic" aria-label={label} title={label} onClick={onPress}>
      {picture}
      <span className="fw-pos-cam" aria-hidden>
        <Camera size={12} />
      </span>
    </button>
  )
}
