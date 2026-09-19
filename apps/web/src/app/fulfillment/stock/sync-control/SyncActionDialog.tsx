'use client'

/**
 * Shared stock plan step 3/5 — the end of an override, chosen when it is set (plan
 * docs/2026-09-19-shared-stock-plan.md §5): "Fixed number 2 until Monday 09:00". For Pin, Zero & Pin,
 * Pause and Exclude the Sync Control screens ask here instead of the plain confirm: no end, or an end
 * date and time in the person's own time zone (the API stores it in UTC and ends the override within a
 * minute of it, with a history row). For a Fixed number on shared eBay variants only, the number to
 * fix can be chosen (a listing's Fixed number keeps what it shows now — the API refuses a number there).
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Banner, DateTimeField, Field, Modal } from '@/design-system/components'
import { Button, Input, SegmentedControl } from '@/design-system/primitives'
import styles from './styles.module.css'

export const END_TIME_ACTIONS = new Set(['PIN', 'ZERO_PIN', 'PAUSE', 'EXCLUDE'])

/** What the API receives besides the action: `until` null = no end; `quantity` only for shared variants. */
export interface SyncActionAnswer { until: string | null; quantity?: number }

interface Ask { action: string; title: string; description: string; allowQuantity: boolean }

const WHAT_ENDS: Record<string, string> = {
  PIN: 'At that time the listing goes back to Follow by itself.',
  ZERO_PIN: 'At that time the listing goes back to Follow by itself.',
  PAUSE: 'At that time the pause ends by itself: the listing goes back to Follow or its Fixed number.',
  EXCLUDE: 'At that time the variant is included again by itself.',
}

/** One end-time dialog per screen: render `dialog`, call `ask` in place of the confirm. */
export function useSyncActionDialog(): { dialog: ReactNode; ask: (request: Ask) => Promise<SyncActionAnswer | null> } {
  const [request, setRequest] = useState<Ask | null>(null)
  const resolver = useRef<((answer: SyncActionAnswer | null) => void) | null>(null)
  const ask = useCallback((next: Ask) => new Promise<SyncActionAnswer | null>((resolve) => {
    resolver.current = resolve
    setRequest(next)
  }), [])
  const finish = (answer: SyncActionAnswer | null) => {
    resolver.current?.(answer)
    resolver.current = null
    setRequest(null)
  }
  return { dialog: request ? <SyncActionDialog key={`${request.action}:${request.title}`} request={request} onDone={finish} /> : null, ask }
}

function SyncActionDialog({ request, onDone }: { request: Ask; onDone: (answer: SyncActionAnswer | null) => void }) {
  const [ends, setEnds] = useState<'none' | 'at'>('none')
  const [until, setUntil] = useState('')
  const [quantity, setQuantity] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The API accepts an end one minute to one year ahead; the field offers a little inside that.
  const [bounds] = useState(() => ({ min: new Date(Date.now() + 2 * 60_000).toISOString(), max: new Date(Date.now() + 365 * 24 * 3600_000).toISOString() }))

  const apply = () => {
    if (ends === 'at' && !until) { setError('Choose the date and time it ends, or choose No end.'); return }
    if (ends === 'at' && new Date(until).getTime() < Date.now() + 60_000) { setError('The end must be at least one minute from now.'); return }
    const answer: SyncActionAnswer = { until: ends === 'at' ? until : null }
    if (request.allowQuantity && quantity !== '') answer.quantity = Number(quantity)
    onDone(answer)
  }

  return <Modal open onClose={() => onDone(null)} size="md" title={request.title}
    footer={<><Button onClick={() => onDone(null)}>Cancel</Button><Button variant="primary" onClick={apply}>Apply</Button></>}>
    <div className={styles.actionDialog}>
      <p>{request.description}</p>
      {/* Plan §5, warning 1: a fixed number is shown to buyers whatever is left. */}
      {request.action === 'PIN' && <Banner tone="warning">A fixed number is not real stock. If fewer are left, the channel can sell more than you have.</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}
      {request.allowQuantity && <Field label="Fixed number" hint="For these shared eBay variants. Leave empty to keep the number eBay shows now.">
        <Input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^0-9]/g, ''))} placeholder="As shown now" />
      </Field>}
      <Field label="Ends" hint={ends === 'at' ? WHAT_ENDS[request.action] : 'It stays until someone changes it.'}>
        <SegmentedControl ariaLabel="Ends" value={ends} onChange={(v) => { setEnds(v as 'none' | 'at'); setError(null) }}
          options={[{ value: 'none', label: 'No end' }, { value: 'at', label: 'At a date and time' }]} />
      </Field>
      {ends === 'at' && <Field label="End date and time">
        <DateTimeField value={until} onChange={(v) => { setUntil(v); setError(null) }} min={bounds.min} max={bounds.max} ariaLabel="End" />
      </Field>}
    </div>
  </Modal>
}

/** "until 21 Sept, 09:00" in the viewer's own zone, for a row whose override ends by itself. */
export function endsAtWords(endsAt: string | null | undefined): string | null {
  if (!endsAt) return null
  const at = new Date(endsAt)
  if (Number.isNaN(at.getTime())) return null
  return `until ${at.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
}
