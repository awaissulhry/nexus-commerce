'use client'

import { useState, type ReactNode } from 'react'
import { PauseCircle, Unlock } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../i18n/ds-parts'
import { useLocale, useScopedT } from '../../../i18n/provider'
import type { PickerReason } from '../../../../areas/_shared/reasons/api'
import { wordsIn } from '../../../../areas/_shared/reasons/model'
import type { ProductionHolds } from '../../../../areas/production/work-orders/daily/api'
import { DAILY_NAMESPACE, dialogReasons, HOLD_DIALOG_LIMITS, holdKindOf, liftHeld, placeHeld, plainHoldsOf, plainHoldWords, type DailyCan, type PlaceHoldInput } from '../../../../areas/production/work-orders/daily/model'
import type { Part, Phrase } from '../model'
import './work-order-acts.css'

/**
 * F-OP-114 — Put on hold and Release the hold, ONE copy for every page that holds a work order: its own record (the daily page's
 * parts), the work orders list (Hold N) and the sales order's Production tab (a row's ⋯). Moved here from the daily page's dialogs
 * (no copy left there). Words: the production lane's catalogue (`production-work-orders` hold.*, liftHold.*); a refusal may name
 * another (`production:error.changed`, `orders:wo.…`).
 *
 *   Put on hold   the reason (the only words the floor reads), its kind (a quality hold: quality releases it; a production hold:
 *                 we lift it), the note (a production hold: the office's note — never the floor's or the customer's), and for a
 *                 production hold what the customer reads — its own words or the reason's — SHOWN before it is placed.
 *   Release       a plain hold (ours, or the customer's accepted pause) lifted with why in one line; a quality hold that still
 *                 stands keeps the work order held, said.
 *
 * DS Modal: Esc closes, the focus returns to the opener; no form element (Enter in a one-line field sends nothing — the button and
 * ⌘↵ send); every act held in words, never a dead button.
 */

/** What the hold dialogs draw, from the page that opens them (the daily model, or the order page's acts). */
export interface HoldParts {
  /** The HOLD and PRODUCTION_HOLD reasons (null: still read). */
  readonly reasons: readonly PickerReason[] | null
  readonly can: Pick<DailyCan, 'holdsPlace' | 'productionHold'>
  readonly busy: boolean
  /** A refused write while the dialog is open (what was typed stays). */
  readonly problem: Phrase | null
  /** The work order's plain holds (Release the hold reads its standing one). */
  readonly productionHolds?: Part<ProductionHolds> | null
  /** Design cases: what the dialog holds. */
  readonly draft?: { readonly reasonCode?: string; readonly note?: string; readonly customerWords?: string; readonly liftReason?: string } | null
}

/** ⌘↵ in a dialog's fields runs its main act when it may go. */
const submitKeys = (go: (() => void) | null) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && go) {
    event.preventDefault()
    go()
  }
}

/** A phrase in words (a `status.X` parameter in words too: the daily page's rule). */
function say(t: ReturnType<typeof useScopedT>, words: Phrase | null): string | null {
  if (!words) return null
  const params = words.params ? Object.fromEntries(Object.entries(words.params).map(([name, value]) => [name, typeof value === 'string' && /^status\.[A-Z_]+$/.test(value) ? t(value) : value])) : undefined
  return t(words.key, params)
}

function Footer({ onCancel, children }: { onCancel: () => void; children?: React.ReactNode }) {
  const t = useScopedT(DAILY_NAMESPACE)
  return (
    <>
      <span className="grow" />
      <Button size="sm" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      {children}
    </>
  )
}

function Problem({ parts }: { parts: HoldParts }) {
  const t = useScopedT(DAILY_NAMESPACE)
  return parts.problem ? <Banner tone="danger" title={say(t, parts.problem) ?? ''} /> : null
}

// ---- Put on hold ----------------------------------------------------------------------------------------------------------------

/**
 * F-OO-108 ("Hold the whole order…" on the sales order's Overview): `notes` — what the order's plan leaves out, each with why (a shared
 * work order, one not reached, the made-to-measure units), drawn under the work orders it holds; `heldBy` — the plan's own words when
 * it holds none (Put on hold held with them). Every other caller passes neither: their dialog is as it was.
 */
export function HoldDialog({ numbers, workOrderIds, parts, onCancel, onPlace, notes, heldBy }: { numbers: string[]; workOrderIds: string[]; parts: HoldParts; onCancel: () => void; onPlace?: (input: PlaceHoldInput) => void; notes?: ReactNode; heldBy?: string | null }) {
  const t = useScopedT(DAILY_NAMESPACE)
  const locale = useLocale()
  const [note, setNote] = useState(parts.draft?.note ?? '')
  // F-PR-05b: ONE dialog for both kinds — the picked reason's list decides it (a quality hold, or a plain production hold whose
  // customer reads its own words or the reason's); each kind offered only with its right. A code may be in both lists (OTHER):
  // the pick is the list and the code.
  const [customerWords, setCustomerWords] = useState(parts.draft?.customerWords ?? '')
  const offered = dialogReasons(parts.reasons ? [...parts.reasons] : null, parts.can)
  const all = offered ? [...offered.QUALITY, ...offered.PRODUCTION] : null
  const [pick, setPick] = useState(() => {
    const asked = parts.draft?.reasonCode ?? ''
    if (!asked || asked.includes(':')) return asked
    const hit = all?.find((entry) => entry.code === asked)
    return hit ? `${hit.list}:${hit.code}` : `HOLD:${asked}`
  })
  const [list = '', reasonCode = ''] = pick ? pick.split(':') : []
  const reason = all?.find((entry) => entry.list === list && entry.code === reasonCode) ?? null
  const kind = reason ? (holdKindOf(reason) ?? 'QUALITY') : null
  const held = placeHeld(reasonCode, note, all ? all.filter((entry) => !list || entry.list === list) : null, parts.busy, { can: parts.can, customerWords })
  const go = heldBy || held || !kind ? null : () => onPlace?.({ kind, workOrderIds, reasonCode, reasonNote: note.trim() || null, customerWords: kind === 'PRODUCTION' ? customerWords.trim() || null : null })
  const optionValue = (entry: { list: string; code: string }) => `${entry.list}:${entry.code}`
  return (
    <Modal
      open
      onClose={onCancel}
      title={numbers.length === 1 ? t('hold.title', { number: numbers[0]! }) : t('hold.titleMany', { count: numbers.length })}
      size="md"
      footer={
        <Footer onCancel={onCancel}>
          <Button size="sm" variant="primary" heldReason={heldBy || say(t, held)} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {parts.busy ? <Spinner size={12} /> : <PauseCircle size={13} aria-hidden />} {numbers.length === 1 ? t('hold.go') : t('hold.goMany', { count: numbers.length })}
          </Button>
        </Footer>
      }
    >
      {/* F-PR-16: no form element — Enter in a one-line field sends nothing; the send button and ⌘↵ send. */}
      <div className="fw-woa-dialog" onKeyDown={submitKeys(go)}>
        <Problem parts={parts} />
        <p>{kind === 'PRODUCTION' ? t('hold.bodyProduction') : t('hold.body')}</p>
        {numbers.length > 1 && <p className="fw-woa-hint">{numbers.join(' · ')}</p>}
        {notes /* F-OO-108: what the order's plan leaves out, with why */}
        <Field label={t('hold.reason')} hint={t('hold.reasonKinds')}>
          {offered === null ? (
            <p className="fw-woa-hint" role="status">
              <Spinner size={12} /> {t('hold.reasonsLoading')}
            </p>
          ) : (
            <Select size="sm" value={reason ? optionValue(reason) : ''} onChange={(event) => setPick(event.target.value)} aria-label={t('hold.reason')}>
              <option value="">{t('hold.reasonPick')}</option>
              {offered.QUALITY.length > 0 && (
                <optgroup label={t('hold.kind.QUALITY')}>
                  {offered.QUALITY.map((entry) => (
                    <option key={optionValue(entry)} value={optionValue(entry)}>
                      {wordsIn(entry, locale)}
                    </option>
                  ))}
                </optgroup>
              )}
              {offered.PRODUCTION.length > 0 && (
                <optgroup label={t('hold.kind.PRODUCTION')}>
                  {offered.PRODUCTION.map((entry) => (
                    <option key={optionValue(entry)} value={optionValue(entry)}>
                      {wordsIn(entry, locale)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          )}
        </Field>
        {kind && <Tag tone={kind === 'PRODUCTION' ? 'info' : 'warning'}>{t(`hold.kindIs.${kind}`)}</Tag>}
        <Field label={kind === 'PRODUCTION' ? t('hold.officeNote') : t('hold.note')} hint={reason?.needsDetail ? t('hold.noteNeeded') : kind === 'PRODUCTION' ? t('hold.officeNoteHint') : t('hold.noteHint')}>
          <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={kind === 'PRODUCTION' ? HOLD_DIALOG_LIMITS.productionNote : HOLD_DIALOG_LIMITS.qualityNote} />
        </Field>
        {kind === 'PRODUCTION' && (
          <>
            <Field label={t('hold.customerWords')} hint={t('hold.customerWordsHint', { reason: reason ? wordsIn(reason, locale) : '—' })}>
              <Input value={customerWords} onChange={(event) => setCustomerWords(event.target.value)} maxLength={HOLD_DIALOG_LIMITS.customerWords} />
            </Field>
            {/* F-OP-114: what the customer will read beside "On hold", shown before the hold is placed (its words, else the reason's). */}
            <p className="fw-woa-hint" aria-live="polite">
              {t('holds.customerReads', { words: customerWords.trim() || (reason ? wordsIn(reason, locale) : '—') })}
            </p>
          </>
        )}
        <ul className="fw-woa-list">
          <li>{t('hold.floor')}</li>
          <li>{kind === 'PRODUCTION' ? t('hold.liftBy') : t('hold.releaseBy')}</li>
        </ul>
      </div>
    </Modal>
  )
}

// ---- F-PR-05b: Release a plain hold (ours, or the customer's accepted pause): why, in one line; workorders.hold ---------------------

/**
 * `holdId`: the plain hold to lift. Null (F-OP-114, a row's ⋯ on the order page): the work order's first standing plain hold — and
 * when none stands, the words of what holds it (a quality hold, or another record) and Release held with them.
 */
export function LiftHoldDialog({ holdId, parts, onCancel, onLift, onRetry }: { holdId: string | null; parts: HoldParts; onCancel: () => void; onLift?: (input: { holdId: string; version: number; reason: string }) => void; onRetry?: () => void }) {
  const t = useScopedT(DAILY_NAMESPACE)
  const locale = useLocale()
  const [reason, setReason] = useState(parts.draft?.liftReason ?? '')
  const read = parts.productionHolds?.value ?? null
  const standing = plainHoldsOf(read).standing
  const hold = (holdId === null ? standing[0] : standing.find((entry) => entry.id === holdId)) ?? null
  // F-OP-114: nothing plain stands — a quality hold (quality releases it) or another record holds the work order.
  const none = read && !hold && holdId === null ? (read.qualityHoldsActive > 0 ? t('liftHold.qualityStays', { count: read.qualityHoldsActive }) : t('holds.underRecord')) : null
  const held = none ?? say(t, liftHeld(hold, parts.can, reason, parts.busy))
  const go = held || !hold ? null : () => onLift?.({ holdId: hold.id, version: hold.version, reason: reason.trim() })
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('liftHold.title')}
      size="md"
      footer={
        <Footer onCancel={onCancel}>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => go?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {parts.busy ? <Spinner size={12} /> : <Unlock size={13} aria-hidden />} {t('liftHold.go')}
          </Button>
        </Footer>
      }
    >
      {/* F-PR-16: no form element — Enter in a one-line field sends nothing; the send button and ⌘↵ send. */}
      <div className="fw-woa-dialog" onKeyDown={submitKeys(go)}>
        <Problem parts={parts} />
        {none ? (
          <p>{none}</p>
        ) : !hold ? (
          parts.productionHolds?.problem ? (
            <EmptyState
              title={t('part.failed', { part: t('liftHold.title') })}
              description={t(parts.productionHolds.problem)}
              action={
                <Button size="sm" onClick={() => onRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : (
            <p className="fw-woa-hint" role="status">
              <Spinner size={12} /> {t('part.loading', { part: t('liftHold.title') })}
            </p>
          )
        ) : (
          <>
            <p>
              <b>{hold.kind === 'BRAND' ? t('holds.customerPause') : plainHoldWords(hold, parts.reasons ? [...parts.reasons] : null, locale)}</b>
            </p>
            <p>{hold.kind === 'BRAND' ? t('liftHold.bodyCustomer') : t('liftHold.body')}</p>
            <Field label={t('liftHold.reason')} hint={t('liftHold.reasonHint')}>
              <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={HOLD_DIALOG_LIMITS.liftReason} />
            </Field>
            {read && read.qualityHoldsActive > 0 && <p className="fw-woa-hint">{t('liftHold.qualityStays', { count: read.qualityHoldsActive })}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}
// ---- end F-PR-05b
