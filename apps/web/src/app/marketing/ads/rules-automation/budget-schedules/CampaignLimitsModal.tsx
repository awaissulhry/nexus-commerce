'use client'

/**
 * ⛔ PARKED 2026-08-18 (U8) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the per-campaign min/max limits modal.
 * Why it left: the Budget Schedules tab is now Helium 10's shape — the hourly-performance card over
 *   the schedules grid, and nothing else (`BudgetSchedulesTabClient.tsx`; study
 *   `docs/2026-08-16-ra-h10-reference-study.md` §3.7, §7.9).
 * Candidate home: **Control Room › Guardrails**.
 *
 * ⚠ Nothing here was changed and no endpoint was retired — `/budget-manager*`, `/budget-binding`
 * and `/budget-schedules*` are all still served. The file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BSP.1 — per-campaign min/max budget limits, migrated from Budget Manager's "More" view.
 *
 * ── Why a modal and not the rail ───────────────────────────────────────────────────────────────
 *
 * Measured on production: the inspector rail gives **294px of usable body width** (320px outer).
 * Four columns plus a toolbar and a filter need roughly twice that. Cramming `AdsDataGrid` into
 * 294px would produce a horizontally-scrolling table inside a sticky column — so the rail holds the
 * entry point and the grid gets a full-width `Modal` with room to be a grid.
 *
 * 🔴 The DS `Modal` portals to `document.body` (`Modal.tsx:37`), which leaves `.h10-shell` and its
 * `color-scheme: light` pin behind — the known trap that renders portalled DS surfaces dark inside
 * this permanently-light section. The pin is re-applied on the modal's own class.
 *
 * ── What the numbers mean ──────────────────────────────────────────────────────────────────────
 *
 * The limits clamp what the PACING ENGINE may set, not what Amazon accepts. `FLOOR_CENTS = 100`
 * (€1/day) is Amazon's own minimum and `ads-budget-enforce.service.ts:148` already treats a missing
 * `minCents` as that floor — so "no minimum" and "€1.00" are the same instruction, and the column
 * says so rather than printing an em-dash that looks like an absence.
 *
 * Today's daily budget sits beside the limits because it is the number they clamp; a min above the
 * current budget means the engine may only ever raise it.
 */

import { useCallback, useMemo, useState } from 'react'
import { Info } from 'lucide-react'
import { Modal } from '@/design-system/components'
import { AdsDataGrid, type GridColumn } from '../../campaigns/_grid/AdsDataGrid'
import type { BmCampaignRow, ResolvedScope } from './slot-contract'

/** €1/day — Amazon's minimum campaign budget, and the enforcement engine's implicit floor. */
const FLOOR_CENTS = 100

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const parseEur = (s: string): number | null => {
  const t = s.trim().replace(',', '.').replace(/^€/, '')
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

export function CampaignLimitsModal({
  open, onClose, marketplace, month, rows, loading, scope, busy, onSave,
}: {
  open: boolean
  onClose: () => void
  marketplace: string
  month: string
  rows: BmCampaignRow[]
  loading: boolean
  scope: ResolvedScope
  busy: boolean
  onSave: (edits: Array<{ campaignId: string; minCents: number | null; maxCents: number | null }>) => Promise<void>
}) {
  const [saveErr, setSaveErr] = useState<string | null>(null)

  // 🔴 Narrowed by the spine. An operator who scoped to one portfolio should not be handed all 86
  // campaigns — the scope on this page means the same thing in every surface it reaches.
  const narrowed = useMemo(() => {
    if (!scope.campaignIds.length) return rows
    const keep = new Set(scope.campaignIds)
    const hit = rows.filter((r) => keep.has(r.id))
    // A scope that matches nothing HERE is a scope over another market; showing zero rows would
    // read as "this market has no campaigns", which is a different and wrong statement.
    return hit.length ? hit : rows
  }, [rows, scope.campaignIds])

  const scopedOut = rows.length - narrowed.length

  const columns: GridColumn<BmCampaignRow>[] = useMemo(() => [
    {
      key: 'status', label: 'Status', metric: false, sortable: true,
      render: (r) => <span className="h10-bsp-cstat">{r.status.toLowerCase()}</span>,
      sortValue: (r) => r.status,
    },
    {
      key: 'daily', label: 'Daily budget', metric: false, sortable: true,
      tip: 'What the campaign is set to today. The limits below clamp what the pacing engine may change it to.',
      render: (r) => <span className="h10-bsp-num">{eur(r.dailyBudgetCents)}</span>,
      sortValue: (r) => String(r.dailyBudgetCents).padStart(12, '0'),
    },
    {
      key: 'minCents', label: 'Min', metric: false, sortable: true,
      tip: 'The engine will not lower this campaign below here. Amazon’s own floor is €1.00, so leaving it empty and setting €1.00 are the same instruction.',
      render: (r) => (r.minCents == null
        ? <span className="h10-bsp-dim">{eur(FLOOR_CENTS)} (floor)</span>
        : <span className="h10-bsp-num">{eur(r.minCents)}</span>),
      sortValue: (r) => String(r.minCents ?? FLOOR_CENTS).padStart(12, '0'),
    },
    {
      key: 'maxCents', label: 'Max', metric: false, sortable: true,
      tip: 'The engine will not raise this campaign above here. Empty means no ceiling.',
      render: (r) => (r.maxCents == null
        ? <span className="h10-bsp-dim">no ceiling</span>
        : <span className="h10-bsp-num">{eur(r.maxCents)}</span>),
      sortValue: (r) => String(r.maxCents ?? 99999999).padStart(12, '0'),
    },
  ], [])

  const onApply = useCallback(async (edits: Array<{ id: string; values: Record<string, string> }>) => {
    setSaveErr(null)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const payload = edits.map((e) => {
      const cur = byId.get(e.id)
      return {
        campaignId: e.id,
        minCents: 'minCents' in e.values ? parseEur(e.values.minCents) : cur?.minCents ?? null,
        maxCents: 'maxCents' in e.values ? parseEur(e.values.maxCents) : cur?.maxCents ?? null,
      }
    })
    // A min above its own max can never be satisfied — refuse it here rather than storing a pair
    // the engine will silently clamp into something nobody asked for.
    const bad = payload.find((p) => p.minCents != null && p.maxCents != null && p.minCents > p.maxCents)
    if (bad) {
      const name = byId.get(bad.campaignId)?.name ?? bad.campaignId
      setSaveErr(`${name}: the minimum (${eur(bad.minCents as number)}) is above the maximum (${eur(bad.maxCents as number)}). Nothing was saved.`)
      return
    }
    try {
      await onSave(payload)
    } catch (e) {
      setSaveErr((e as Error).message)
    }
  }, [rows, onSave])

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      /* 🔴 NOT `h10-shell`. That class is the ads console's page WRAPPER — it carries
         `background: var(--nds-grey-50)`, `height: 100dvh`, `display: flex` and
         `overflow: hidden` alongside the light token pin. Measured on this modal
         2026-08-25: with it the panel rendered #f4f6f9 and **742.9px tall**; without
         it, white and 96px of content. The pin it was reaching for is unnecessary —
         `tokens-global.css` declares every `--nds-*` on `:root`, so a portaled panel
         resolves them without any wrapper. */
      className="h10-bsp-modal"
      title={`Per-campaign limits · ${marketplace}`}
      subtitle={`${month} · what the pacing engine may set each campaign to`}
    >
      <p className="h10-bsp-note">
        <Info size={12} />
        <span>
          These clamp the <b>pacing engine</b>, not Amazon. A campaign with no minimum still cannot go
          below Amazon&rsquo;s €1.00 floor.
          {scopedOut > 0 && <> {scopedOut} campaign{scopedOut === 1 ? '' : 's'} outside the current scope {scopedOut === 1 ? 'is' : 'are'} hidden.</>}
        </span>
      </p>

      {saveErr && <p className="h10-bsp-note bad"><span>{saveErr}</span></p>}

      <AdsDataGrid<BmCampaignRow>
        rows={narrowed}
        loading={loading}
        rowId={(r) => r.id}
        noun="Campaign"
        firstColLabel="Campaign"
        renderFirst={(r) => <span className="h10-bsp-cname" title={r.name}>{r.name}</span>}
        firstSortValue={(r) => r.name.toLowerCase()}
        columns={columns}
        searchable
        searchPlaceholder="Search campaigns…"
        searchValue={(r) => r.name}
        filters={[{
          key: 'status', label: 'Status', kind: 'select',
          options: [{ value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }],
          value: (r) => (r as BmCampaignRow).status,
        }]}
        customizable={false}
        pagerCentered
        defaultSort={{ key: 'daily', dir: 'desc' }}
        emptyLabel="No campaigns in this market"
        editMode={{
          label: busy ? 'Saving…' : 'Edit limits',
          bulk: true,
          fields: [
            { key: 'minCents', initial: (r) => (r.minCents == null ? '' : (r.minCents / 100).toFixed(2)),
              render: (v, set) => <input className="h10-bsp-cellin" value={v} onChange={(e) => set(e.target.value)} placeholder="floor" aria-label="Minimum daily budget" inputMode="decimal" /> },
            { key: 'maxCents', initial: (r) => (r.maxCents == null ? '' : (r.maxCents / 100).toFixed(2)),
              render: (v, set) => <input className="h10-bsp-cellin" value={v} onChange={(e) => set(e.target.value)} placeholder="none" aria-label="Maximum daily budget" inputMode="decimal" /> },
          ],
          onApply,
        }}
      />
    </Modal>
  )
}
