'use client'

/**
 * VP.3 — `Manage shared axes` (§3.1: the axis chips and `+ Add axis` open this).
 *
 * REBUILT, not moved. The old `variants/VariantSummary.tsx` held an `AxisEditor` with the same job,
 * and spec §6 deletes that whole file; §2.10 says the old tree is specification and never source. So
 * this is the DS composition of the same CAPABILITY, against the SAME endpoint — §5.2 keeps
 * `GET/PATCH /products/:id/studio/variation-axes` exactly as it is, and nothing about the write
 * changes.
 *
 * What survives from the old editor because it was right, and would have been easy to lose:
 *   - the unsaved-changes guards, BOTH of them. `registerScopeChangeGuard` protects a scope change
 *     inside the app; `beforeunload` protects a reload or a closed tab. An autosave-less dialog with
 *     only the first is the banked `reference_autosave_still_needs_a_nav_guard` trap.
 *   - the save REPORTER wiring, so the studio header can say "saving" about a write that does not go
 *     through the sheet's `SheetWriter`.
 *   - refusing the save on a non-parent, with the role's reason on screen rather than a dead button.
 *
 * The open field is `focus: 'add'` — `+ Add axis` opens the same modal with the add control focused
 * (§3.1), rather than a second dialog that does one thing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { Banner, Modal, OrderedList } from '@/design-system/components'
import { Button, Select } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

import { useSaveReporter, useStudioScope } from '../../contracts'

/** `GET /products/:id/studio/variation-axes` — mirrored only as far as this file reads it. */
interface AxisSetup {
  product: { id: string; sku: string; version: number; isParent: boolean }
  axes: string[]
  childIds: string[]
  options: Array<{ key: string; label: string; identity: string }>
}

async function readResponse(response: Response) {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.message || body?.error || `Request failed (${response.status})`)
  return body
}

async function saveSetupAxes(setup: AxisSetup, axes: string[], market: string) {
  return readResponse(await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(setup.product.id)}/studio/variation-axes`, {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: setup.product.version, axes, childIds: setup.childIds, market }),
  }))
}

/** The band uses the same observed setup and guarded writer as the full axes dialog. */
export async function saveAxisOrder(productId: string, market: string, expectedVersion: number, axes: string[]) {
  const setup: AxisSetup = await readResponse(await fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/variation-axes?${new URLSearchParams({ market })}`, { credentials: 'include', cache: 'no-store' }))
  if (setup.product.version !== expectedVersion || setup.axes.length !== axes.length || setup.axes.some(key => !axes.includes(key))) throw new Error('The shared axes changed. Reload before reordering.')
  return saveSetupAxes(setup, axes, market)
}

export interface ManageAxesDialogProps {
  open: boolean
  productId: string
  market: string
  /** `add` focuses the "Add an attribute…" control; `list` leaves focus on the order. */
  focus: 'list' | 'add'
  onClose: () => void
  onChanged: () => void
}

export function ManageAxesDialog({ open, productId, market, focus, onClose, onChanged }: ManageAxesDialogProps) {
  const [setup, setSetup] = useState<AxisSetup | null>(null)
  const [axes, setAxes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const addRef = useRef<HTMLSelectElement>(null)
  const { registerScopeChangeGuard } = useStudioScope()
  const reporter = useSaveReporter()

  const dirty = !!setup && JSON.stringify(axes) !== JSON.stringify(setup.axes)
  const canClose = useCallback(() => {
    const allowed = !busy && (!dirty || window.confirm('Discard the unsaved axis changes?'))
    if (allowed && setup) reporter.cleared([`variation-axes:${setup.product.id}`])
    return allowed
  }, [busy, dirty, setup, reporter])

  useEffect(() => {
    if (!open) return
    return registerScopeChangeGuard(canClose)
  }, [open, registerScopeChangeGuard, canClose])

  useEffect(() => {
    if (!open) return
    const unload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    return () => window.removeEventListener('beforeunload', unload)
  }, [open, dirty, busy])

  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    setSetup(null)
    setError(null)
    fetch(`${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/variation-axes?${new URLSearchParams({ market })}`,
      { credentials: 'include', cache: 'no-store', signal: abort.signal })
      .then(readResponse)
      .then((data: AxisSetup) => { if (!abort.signal.aborted) { setSetup(data); setAxes(data.axes) } })
      .catch((e: unknown) => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
    return () => abort.abort()
  }, [open, productId, market, revision])

  useEffect(() => {
    if (open && focus === 'add' && setup) addRef.current?.focus()
  }, [open, focus, setup])

  const save = async () => {
    if (!setup || busy || !dirty) return
    setBusy(true)
    setError(null)
    const writeId = `variation-axes:${setup.product.id}:${Date.now()}`
    reporter.pending(writeId, `variation-axes:${setup.product.id}`)
    try {
      await saveSetupAxes(setup, axes, market)
      reporter.resolved(writeId, true)
      onChanged()
      onClose()
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      reporter.resolved(writeId, false, message)
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  const labelOf = (key: string) => setup?.options.find(option => option.key === key)?.label ?? key
  return (
    <Modal
      open
      size="md"
      title="Manage shared axes"
      subtitle={setup ? `${setup.product.sku} · ${setup.childIds.length} variants · all channels and listing aliases` : 'Loading the shared family…'}
      onClose={() => { if (canClose()) onClose() }}
      footer={
        <>
          <Button size="sm" disabled={busy} onClick={() => { if (canClose()) onClose() }}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!setup?.product.isParent || !dirty || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save axes'}
          </Button>
        </>
      }
    >
      {error && (
        <Banner tone="danger" action={<Button disabled={busy} onClick={() => { if (canClose()) setRevision(n => n + 1) }}>Reload axes</Button>}>
          {error}
        </Banner>
      )}
      {!setup && !error && <p role="status">Loading available attributes…</p>}
      {setup && (
        <>
          <p>Choose the attributes that distinguish this family’s variants. The order below is shared; each channel keeps its own supported variation rules and listing values.</p>
          {!setup.product.isParent && <Banner tone="neutral">Use Add variant to promote this product before defining variation axes.</Banner>}
          <OrderedList
            label="Shared axis order"
            items={axes}
            onChange={setAxes}
            disabled={busy || !setup.product.isParent}
            itemLabel={labelOf}
            renderItem={key => (
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%' }}>
                <span>{labelOf(key)}</span>
                <Button size="sm" disabled={busy} aria-label={`Remove ${labelOf(key)} axis`} onClick={() => setAxes(current => current.filter(axis => axis !== key))}>Remove</Button>
              </span>
            )}
          />
          <Select
            size="sm"
            ref={addRef}
            aria-label="Add variation axis"
            value=""
            disabled={busy || !setup.product.isParent}
            onChange={event => { const key = event.target.value; if (key) setAxes(current => [...current, key]) }}
          >
            <option value="">Add an attribute…</option>
            {setup.options
              .filter(option => !axes.some(axis => setup.options.find(selected => selected.key === axis)?.identity === option.identity))
              .map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
          </Select>
          <Banner tone="neutral">
            Saving changes the shared axis definition for this parent and {setup.childIds.length} variants. Existing attribute values and listing aliases are retained. Review each channel’s requirements before publishing.
          </Banner>
        </>
      )}
    </Modal>
  )
}
