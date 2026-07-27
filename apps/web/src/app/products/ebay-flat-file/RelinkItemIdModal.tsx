'use client'

/**
 * Re-link a family's eBay ItemID — verify FIRST, write only on proof.
 *
 * Built for the VENTRA case: listings were ended and rebuilt, so
 * ChannelListing.externalListingId held dead IDs (status DRAFT) while
 * SharedListingMembership held the live ones. The flat file renders the
 * ChannelListing value, so the grid showed dead IDs with no way to fix them.
 *
 * Re-pointing a family at an ItemID is one of the most dangerous edits in the
 * system — get it wrong and Nexus drives someone else's listing, pushing this
 * family's price, quantity, title and images onto it. So this surface is
 * deliberately two-step: CHECK (dry run, always safe) then APPLY, and Apply
 * stays disabled until the server has proven ownership from eBay's own data.
 * The operator never types an ID straight into a write.
 */

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Search, XCircle } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { Select } from '@/design-system/primitives/Select'
import { Checkbox } from '@/design-system/primitives/Checkbox'
import { Banner } from '@/design-system/components/Banner'
import { getBackendUrl } from '@/lib/backend-url'
import { EBAY_MARKETPLACES } from './ebay-columns'

type Verdict = 'verified' | 'unverifiable' | 'rejected' | 'invalid'

interface RelinkResult {
  parentSku: string
  marketplace: string
  itemId: string
  verdict: Verdict
  reason: string
  matchedSkus: string[]
  foreignSkus: string[]
  liveTitle?: string
  liveStatus?: string | null
  before: {
    externalListingId: string | null
    listingStatus: string | null
    membershipItemIds: string[]
    membershipRows: number
  }
  applied: boolean
  changes: string[]
}

const VERDICT_TONE: Record<Verdict, 'success' | 'warning' | 'danger'> = {
  verified: 'success',
  unverifiable: 'warning',
  rejected: 'danger',
  invalid: 'danger',
}

export function RelinkItemIdModal({ open, onClose, defaultSku, defaultMarketplace, onApplied }: {
  open: boolean
  onClose: () => void
  /** Prefill from the grid's current family, when there is one. */
  defaultSku?: string
  defaultMarketplace?: string
  /** Fired after a successful write so the caller can reload rows. */
  onApplied?: () => void
}) {
  const [parentSku, setParentSku] = useState(defaultSku ?? '')
  const [marketplace, setMarketplace] = useState(
    defaultMarketplace && EBAY_MARKETPLACES.includes(defaultMarketplace) ? defaultMarketplace : 'IT',
  )
  const [itemId, setItemId] = useState('')
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RelinkResult | null>(null)
  const [ack, setAck] = useState(false)

  const call = async (apply: boolean) => {
    setBusy(apply ? 'apply' : 'check')
    setError(null)
    if (!apply) setResult(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/relink-item-id`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentSku: parentSku.trim(),
          marketplace,
          itemId: itemId.trim(),
          ...(apply ? { apply: true, acknowledgeUnverifiable: ack } : {}),
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        setError((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`)
        return
      }
      setResult(body as RelinkResult)
      if ((body as RelinkResult).applied) onApplied?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(null)
    }
  }

  // Apply is gated on a fresh, proven check — never on the typed value alone.
  const canApply =
    !!result &&
    !result.applied &&
    result.itemId === itemId.trim() &&
    result.parentSku === parentSku.trim() &&
    (result.verdict === 'verified' || (result.verdict === 'unverifiable' && ack))

  const noChange = !!result && result.before.externalListingId === result.itemId

  return (
    <Modal open={open} onClose={onClose} title="Re-link eBay Item ID" size="xl" elevated>
      <ModalBody>
        <div className="flex flex-col gap-3">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Points a family at a different live eBay listing. The ID is checked against eBay before anything is
            written — Apply stays disabled until ownership is proven from the SKUs eBay reports.
          </p>

          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col gap-1 text-[10.5px] font-medium text-slate-500 dark:text-slate-400 flex-1 min-w-[220px]">
              Family SKU (the parent / listing shell)
              <Input value={parentSku} placeholder="VENTRA-JACKET-ALT1"
                onChange={(e) => { setParentSku(e.target.value); setResult(null) }} />
            </label>
            <label className="flex flex-col gap-1 text-[10.5px] font-medium text-slate-500 dark:text-slate-400">
              Market
              <Select value={marketplace} onChange={(e) => { setMarketplace(e.target.value); setResult(null) }}>
                {EBAY_MARKETPLACES.map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-[10.5px] font-medium text-slate-500 dark:text-slate-400 min-w-[180px]">
              Live eBay Item ID
              <Input value={itemId} placeholder="257629964897" inputMode="numeric"
                onChange={(e) => { setItemId(e.target.value); setResult(null) }} />
            </label>
            <Button size="sm" onClick={() => void call(false)}
              disabled={!parentSku.trim() || !itemId.trim() || busy !== null}>
              {busy === 'check'
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking…</>
                : <><Search className="w-3.5 h-3.5" /> Check against eBay</>}
            </Button>
          </div>

          {error && <Banner tone="danger" title="Request failed" onDismiss={() => setError(null)}>{error}</Banner>}

          {result && (
            <Banner
              tone={result.applied ? 'success' : VERDICT_TONE[result.verdict]}
              title={
                result.applied
                  ? 'Applied — both stores updated'
                  : result.verdict === 'verified' ? 'Verified by eBay'
                  : result.verdict === 'unverifiable' ? 'Cannot be proven from eBay'
                  : 'Refused'
              }
            >
              <div className="flex flex-col gap-1.5">
                <p>{result.reason}</p>
                {result.liveTitle && (
                  <p className="text-[11px]">
                    eBay listing: <span className="font-semibold">{result.liveTitle}</span>
                    {result.liveStatus ? ` · ${result.liveStatus}` : ''}
                  </p>
                )}
                {result.verdict !== 'invalid' && (
                  <p className="text-[11px]">
                    SKU ownership: <span className="font-semibold">{result.matchedSkus.length} matched</span>
                    {result.foreignSkus.length > 0 && (
                      <span className="font-semibold text-red-700 dark:text-red-300">
                        {' '}· {result.foreignSkus.length} belong to another family
                      </span>
                    )}
                  </p>
                )}
              </div>
            </Banner>
          )}

          {result && result.verdict !== 'invalid' && (
            <div className="rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-[11px] flex flex-col gap-1">
              <p className="font-semibold text-slate-700 dark:text-slate-200">
                {result.applied ? 'What changed' : 'What would change'}
              </p>
              {noChange ? (
                <p className="text-slate-600 dark:text-slate-300">
                  Already linked to {result.itemId} — applying would be a no-op.
                </p>
              ) : (
                <>
                  <p>
                    ChannelListing({result.marketplace}): <span className="font-mono">{result.before.externalListingId ?? 'NULL'}</span>
                    {result.before.listingStatus ? ` (${result.before.listingStatus})` : ''} →{' '}
                    <span className="font-mono font-semibold">{result.itemId}</span> (ACTIVE)
                  </p>
                  <p>
                    SharedListingMembership: {result.before.membershipRows} row(s) → <span className="font-mono">{result.itemId}</span>
                  </p>
                </>
              )}
              {result.changes.length > 0 && (
                <ul className="mt-1 list-disc pl-4">
                  {result.changes.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              )}
            </div>
          )}

          {result?.verdict === 'unverifiable' && !result.applied && (
            <Checkbox
              checked={ack}
              label="That listing reports no SKUs. I confirm this Item ID is the correct listing for this family."
              onChange={(e) => setAck(e.target.checked)}
            />
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          {result?.verdict === 'verified' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            : result?.verdict === 'rejected' || result?.verdict === 'invalid' ? <XCircle className="w-3.5 h-3.5 text-red-600" />
            : <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />}
          Checking never writes. Apply writes both stores in one transaction.
        </span>
        <Button size="sm" onClick={onClose} disabled={busy !== null}>Close</Button>
        <Button size="sm" variant="danger" disabled={!canApply || busy !== null || noChange}
          title={
            noChange ? 'Already linked to this Item ID'
              : canApply ? undefined
              : 'Run a successful check first — Apply needs proof from eBay'
          }
          onClick={() => void call(true)}>
          {busy === 'apply'
            ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Applying…</>
            : 'Apply re-link'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
