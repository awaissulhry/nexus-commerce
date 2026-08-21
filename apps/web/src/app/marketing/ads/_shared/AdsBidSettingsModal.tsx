'use client'

/**
 * SG.5 — the Bid Settings gear (H10's Section A), mapped to this account's REAL enforcement
 * points instead of a settings page that stores wishes:
 *
 *   · Market bid limits → `AdBidPolicy { grain: 'MARKET' }` rows via the existing
 *     GET/PUT/DELETE /advertising/bid-policies. The WRITE GATE enforces these on every bid
 *     write — rules, suggestions, A.I., manual — by REFUSING a write outside the band and
 *     naming the policy in the refusal (ads-write-gate.ts, entity_bounds). Existing bids are
 *     never pulled in; the copy says so because that surprised the operator once (BID.S5:
 *     14 of 15 targets in one campaign sat above their own ceiling).
 *   · Enforce maximum → POST /advertising/suggestions/enforce-max-bid: clamps PENDING bid
 *     suggestions that project above their market's ceiling, so what the operator approves is
 *     a bid that will actually land. Dry-run count first; the button carries the count.
 *   · Default ACoS target → `AdsAutomationState.defaultTargetAcosPct` (INTEGER percent — the
 *     0.3-vs-30 encoding trap is live in this codebase, so the field validates integers and
 *     the server rejects fractions). ONE reader: bid_apply's targetAcos/curBidTargetAcos ops,
 *     as fallback when the rule itself has no target. The copy names that reader exactly —
 *     a setting that doesn't say who reads it reads like it governs everything.
 */
import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { useToast } from '@/design-system/components/Toast'
import { getBackendUrl } from '@/lib/backend-url'

interface BidPolicy { grain: string; scopeId: string; label: string; minBidCents: number | null; maxBidCents: number | null; enabled: boolean }

const DEFAULT_MARKETS = ['IT', 'DE', 'ES', 'FR']

/** '' ⇄ cents. Empty string = no bound; parse refuses negatives and NaN. */
const toEur = (cents: number | null) => (cents == null ? '' : (cents / 100).toFixed(2))
const toCents = (s: string): number | null | 'invalid' => {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 'invalid'
}

export function AdsBidSettingsModal({ open, onClose, markets = DEFAULT_MARKETS }: {
  open: boolean
  onClose: () => void
  markets?: string[]
}) {
  const { toast } = useToast()
  const [band, setBand] = useState<Record<string, { min: string; max: string }>>({})
  const [saved, setSaved] = useState<Record<string, { min: string; max: string }>>({})
  const [acos, setAcos] = useState('')
  const [savedAcos, setSavedAcos] = useState('')
  const [overCap, setOverCap] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [armedClamp, setArmedClamp] = useState(false)

  const load = useCallback(async () => {
    const base = getBackendUrl()
    try {
      const [pol, st, dry] = await Promise.all([
        fetch(`${base}/api/advertising/bid-policies`, { cache: 'no-store' }).then((r) => r.json()),
        fetch(`${base}/api/advertising/automation/state`, { cache: 'no-store' }).then((r) => r.json()),
        fetch(`${base}/api/advertising/suggestions/enforce-max-bid`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun: true }),
        }).then((r) => r.json()),
      ])
      const byMkt: Record<string, { min: string; max: string }> = {}
      for (const m of markets) {
        const row = (pol?.policies as BidPolicy[] | undefined)?.find((p) => p.grain === 'MARKET' && p.scopeId === m)
        byMkt[m] = { min: toEur(row?.minBidCents ?? null), max: toEur(row?.maxBidCents ?? null) }
      }
      setBand(byMkt); setSaved(byMkt)
      const pct = st?.defaultTargetAcosPct
      setAcos(pct == null ? '' : String(pct)); setSavedAcos(pct == null ? '' : String(pct))
      setOverCap(typeof dry?.clamped === 'number' ? dry.clamped : null)
    } catch {
      toast('Could not load the current bid settings', 'danger')
    }
  }, [markets, toast])
  useEffect(() => { if (open) { setArmedClamp(false); void load() } }, [open, load])

  const bandDirty = markets.some((m) => band[m] && saved[m] && (band[m].min !== saved[m].min || band[m].max !== saved[m].max))
  const acosDirty = acos.trim() !== savedAcos.trim()

  const saveBand = async () => {
    setBusy(true)
    try {
      for (const m of markets) {
        const cur = band[m]; const was = saved[m]
        if (!cur || !was || (cur.min === was.min && cur.max === was.max)) continue
        const minC = toCents(cur.min); const maxC = toCents(cur.max)
        if (minC === 'invalid' || maxC === 'invalid') { toast(`${m}: a bound must be a positive euro amount, or empty for none`, 'danger'); return }
        if (minC != null && maxC != null && minC > maxC) { toast(`${m}: the floor is above the ceiling`, 'danger'); return }
        const base = getBackendUrl()
        if (minC == null && maxC == null) {
          const r = await fetch(`${base}/api/advertising/bid-policies?grain=MARKET&scopeId=${m}`, { method: 'DELETE' })
          if (!r.ok && r.status !== 404) { toast(`${m}: could not clear the band`, 'danger'); return }
        } else {
          const r = await fetch(`${base}/api/advertising/bid-policies`, {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ grain: 'MARKET', scopeId: m, label: `${m} market bid band`, minBidCents: minC, maxBidCents: maxC }),
          })
          if (!r.ok) { const j = await r.json().catch(() => null) as { error?: string } | null; toast(`${m}: ${j?.error ?? 'could not save'}`, 'danger'); return }
        }
      }
      toast('Market bid limits saved — the write gate enforces them from the next write on', 'success')
      await load()
    } finally { setBusy(false) }
  }

  const runClamp = async () => {
    if (!armedClamp) { setArmedClamp(true); return }
    setArmedClamp(false); setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/suggestions/enforce-max-bid`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      }).then((x) => x.json())
      toast(r?.ok ? `Clamped ${r.clamped} pending suggestion${r.clamped === 1 ? '' : 's'} to their market ceiling` : 'The sweep failed', r?.ok ? 'success' : 'danger')
      await load()
    } finally { setBusy(false) }
  }

  const saveAcos = async () => {
    const t = acos.trim()
    const pct = t === '' ? null : Number(t)
    if (pct !== null && (!Number.isInteger(pct) || pct < 1 || pct > 500)) {
      toast('The default ACoS target is a whole percent between 1 and 500 — 30 means 30%', 'danger')
      return
    }
    setBusy(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation/default-target-acos`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pct }),
      })
      if (!r.ok) { const j = await r.json().catch(() => null) as { error?: string } | null; toast(j?.error ?? 'Could not save', 'danger'); return }
      setSavedAcos(t)
      toast(pct == null ? 'Default ACoS target cleared — target-ACoS rules without their own target will refuse again' : `Default ACoS target saved at ${pct}%`, 'success')
    } finally { setBusy(false) }
  }

  return (
    <Modal open={open} onClose={onClose} title="Bid Settings" size="lg"
      footer={<Button variant="secondary" size="sm" onClick={onClose}>Close</Button>}>
      <div className="h10-bset">
        <section className="h10-bset-sec">
          <h4>Market bid limits</h4>
          <p className="h10-bset-why">
            <ShieldCheck size={13} aria-hidden />
            <span>Enforced by the write gate on <b>every</b>{' '}bid write — rules, suggestions, A.I., manual.
            A write outside the band is refused, and the refusal names this policy. Existing bids are never pulled in.</span>
          </p>
          <div className="h10-bset-grid" role="group" aria-label="Per-market bid limits">
            <span className="h10-bset-h">Market</span><span className="h10-bset-h">Min bid</span><span className="h10-bset-h">Max bid</span>
            {markets.map((m) => (
              <span key={m} className="h10-bset-row">
                <span className="h10-bset-mkt">{m}</span>
                <Input prefix="€" inputMode="decimal" placeholder="none" aria-label={`${m} minimum bid`}
                  value={band[m]?.min ?? ''} onChange={(e) => setBand((b) => ({ ...b, [m]: { min: e.target.value, max: b[m]?.max ?? '' } }))} />
                <Input prefix="€" inputMode="decimal" placeholder="none" aria-label={`${m} maximum bid`}
                  value={band[m]?.max ?? ''} onChange={(e) => setBand((b) => ({ ...b, [m]: { min: b[m]?.min ?? '', max: e.target.value } }))} />
              </span>
            ))}
          </div>
          <div className="h10-bset-acts">
            {bandDirty
              ? <Button variant="primary" size="sm" disabled={busy} onClick={() => void saveBand()}>Save market limits</Button>
              : <span className="h10-bset-quiet">Saved — edit a bound to change it. Finer grains (line · portfolio · campaign) keep their own rows and win over these.</span>}
          </div>
        </section>

        <section className="h10-bset-sec">
          <h4>Enforce maximum</h4>
          <p className="h10-bset-why">
            {/* {' '} after each </b>: the build strips the plain space and prints "pendingbid" */}
            <span>Clamps <b>pending</b>{' '}bid suggestions that project above their market ceiling, so what you approve is a bid
            that will actually land. The engine&rsquo;s next evaluation may propose above the ceiling again — the write
            gate refuses those applies regardless; this just saves you approving one.</span>
          </p>
          <div className="h10-bset-acts">
            {overCap == null ? (
              <span className="h10-bset-quiet">Checking the pending queue…</span>
            ) : overCap === 0 ? (
              <span className="h10-bset-quiet">No pending bid suggestion sits above a market ceiling right now.</span>
            ) : (
              <Button variant={armedClamp ? 'primary' : 'secondary'} size="sm" disabled={busy} onClick={() => void runClamp()}>
                {armedClamp ? `Click again to clamp ${overCap}` : `Clamp ${overCap} suggestion${overCap === 1 ? '' : 's'} to the ceiling`}
              </Button>
            )}
          </div>
        </section>

        <section className="h10-bset-sec">
          <h4>Default ACoS target</h4>
          <p className="h10-bset-why">
            <span>Read by <b>one</b>{' '}thing: a Bid rule&rsquo;s target-ACoS action, when the rule itself doesn&rsquo;t set a
            target. Whole percent — 30 means 30%. With no default, such a rule refuses and says so.</span>
          </p>
          <div className="h10-bset-acts">
            <Input suffix="%" inputMode="numeric" placeholder="none" aria-label="Default ACoS target percent"
              fieldClassName="h10-bset-pct" value={acos} onChange={(e) => setAcos(e.target.value)} />
            {acosDirty
              ? <Button variant="primary" size="sm" disabled={busy} onClick={() => void saveAcos()}>{acos.trim() === '' ? 'Clear default' : 'Save default'}</Button>
              : <span className="h10-bset-quiet">{savedAcos ? `Saved at ${savedAcos}%.` : 'No default is set.'}</span>}
          </div>
        </section>
      </div>
    </Modal>
  )
}
