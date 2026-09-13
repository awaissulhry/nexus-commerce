'use client'

/**
 * VT.4 — the `Change variation theme…` plan modal (canvas artboard 7, `ChangePlan.dc.html`).
 *
 * ## What opens it, and what it is not
 *
 * The Variation theme column's commit on a LOCKED coordinate does not write (design §3.5): a SET change
 * on a live listing is an OPERATION, and Amazon/eBay/Shopify each do it differently. So the commit opens
 * this, with the dry-run plan the server built. **There is no live executor in this programme** (D-VT6 /
 * VX D8); the footer's primary action is `Copy plan`, never `Run`.
 *
 * VT.2's `AxesPanelEditor` opens it — one import, agreed in `docs/pes-claims.md`:
 *
 * ```tsx
 * import { ThemeChangePlanModal, fetchThemeChangePlan } from '@/app/products/[id]/edit/_studio/variants/channel'
 * ```
 *
 * ## Every number on screen comes from the server
 *
 * The steps, the verbs (`PATCH ×20`), the `Keeps`/`Loses` lists, the banner sentence and the sub-line are
 * all `ThemeChangePlan` fields. Nothing is composed here — a modal that counted the children itself would
 * be a second answer to a question the plan already answers, and the two would disagree the first time a
 * variant was excluded. `meta.adapter` and `meta.tookMs` are printed in the footer for the same reason the
 * canvas prints them: they are the evidence that the payload came from the publish path's own composer.
 *
 * ## Width
 *
 * ASSUMED: the canvas artboard is **680px** wide and the DS `Modal` offers 440 (`sm`) / 560 (`md`) /
 * 660 (`lg`) / 920 (`xl`). `lg` is used — 20px from the canvas and the only size the five-column steps
 * table fits without a horizontal scroller (16 + 80 + 190 + flexible + 70). VT.4's prompt says `md`; that
 * is 120px narrower than the drawing and would wrap every Detail cell, so the drawing wins and the
 * deviation is recorded rather than made silently.
 */
import { Copy } from 'lucide-react'
import { useMemo, useState } from 'react'

import { Banner, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

import type { ProjectionCoordinateInput } from './source'

import './theme-change-plan.css'

/* ── the wire, relayed verbatim (`services/pim/theme-change.service.ts`) ────────────────────── */

export interface ThemeChangeStep {
  n: number
  verb: string
  target: string
  detail: string
  /** `null` renders the muted `—`: a wait is neither reversible nor irreversible. */
  reversible: boolean | null
  payload?: unknown
}

export interface ThemeChangePlan {
  kind: 'amazon-new-parent' | 'ebay-relist' | 'shopify-in-place'
  coordinate: { channel: string; market: string; accountId: string | null; aliasKey: string; label: string }
  title: string
  subline: string
  from: string
  to: string
  banner: string
  steps: ThemeChangeStep[]
  keeps: string[]
  loses: string[]
  warnings: string[]
  dryRun: true
  meta: { tookMs: number; adapter: string; providerCalls: 0 }
}

export interface ThemeChangeRequest {
  coordinate: ProjectionCoordinateInput
  expectedVersion: number
  reset?: boolean
  theme?: string | null
  mapping?: Array<{ axisKey: string; target: string; order?: number }>
}

export class ThemeChangePlanError extends Error {}

/**
 * Ask the server for the plan. `dryRun: true` is sent explicitly and is the only value the route takes —
 * a client that could omit it would be one refactor away from a live run.
 *
 * A refusal is a SENTENCE, not an empty modal: the route answers 400 for an order-only eBay change, for a
 * theme the product type does not offer and for a stale version, and each of those is something the
 * operator can act on. Swallowing them into "the plan could not be built" would delete the instruction.
 */
export async function fetchThemeChangePlan(request: ThemeChangeRequest): Promise<ThemeChangePlan> {
  const { coordinate: c } = request
  const params = new URLSearchParams({ channel: c.channel, market: c.market })
  if (c.accountId) params.set('accountId', c.accountId)
  if (c.aliasKey != null) params.set('aliasKey', c.aliasKey)
  const res = await fetch(
    `${getBackendUrl()}/api/products/${encodeURIComponent(c.productId)}/studio/projection/theme-change?${params}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dryRun: true,
        expectedVersion: request.expectedVersion,
        ...(request.reset ? { reset: true } : {}),
        ...(request.theme !== undefined ? { theme: request.theme } : {}),
        ...(request.mapping !== undefined ? { mapping: request.mapping } : {}),
      }),
    },
  )
  const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | ThemeChangePlan | null
  if (!res.ok || !body || !('steps' in body)) {
    const named = body && 'message' in body ? body.message : undefined
    throw new ThemeChangePlanError(named ?? `The plan could not be built (HTTP ${res.status}).`)
  }
  return body
}

/** The plan as plain text, for `Copy plan`. Every line is the server's; nothing is re-worded here. */
export function planAsText(plan: ThemeChangePlan): string {
  const rev = (value: boolean | null) => (value === null ? '—' : value ? 'yes' : 'no')
  return [
    plan.title,
    plan.subline,
    '',
    plan.banner,
    '',
    ...plan.steps.map((s) => `${s.n}. ${s.verb} · ${s.target} · ${s.detail} · reversible: ${rev(s.reversible)}`),
    '',
    `Keeps: ${plan.keeps.map((k) => `· ${k}`).join(' ')}`,
    `Loses: ${plan.loses.map((k) => `· ${k}`).join(' ')}`,
    ...(plan.warnings.length ? ['', ...plan.warnings.map((w) => `! ${w}`)] : []),
    '',
    `${plan.meta.adapter} · dry run · ${plan.meta.providerCalls} provider calls`,
  ].join('\n')
}

export interface ThemeChangePlanModalProps {
  open: boolean
  onClose(): void
  /** `null` while the plan is being fetched. */
  plan: ThemeChangePlan | null
  /** The server's refusal, verbatim, when there is one. */
  error?: string | null
}

const COLUMNS = ['#', 'Verb', 'Target', 'Detail', 'Reversible'] as const

export function ThemeChangePlanModal({ open, onClose, plan, error }: ThemeChangePlanModalProps) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => (plan ? planAsText(plan) : ''), [plan])

  const copy = async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      // The label returns on its own: a button that stays on "Copied" is lying by the next click.
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // A clipboard the browser refuses is not a plan failure. Say so where the click happened.
      setCopied(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={plan?.title ?? 'Change variation theme'}
      subtitle={plan?.subline ?? undefined}
      footer={
        <>
          {plan && (
            <span className="nds-vt-plan-note">
              {plan.meta.adapter === '' ? null : 'Plan built by the same adapter the publish path calls'}
              {' · '}
              {(plan.meta.tookMs / 1000).toFixed(2)} s
            </span>
          )}
          <span className="grow" />
          <Button size="sm" onClick={onClose}>Close</Button>
          <Button size="sm" variant="primary" disabled={!plan} onClick={copy}>
            <Copy size={13} aria-hidden /> {copied ? 'Copied' : 'Copy plan'}
          </Button>
        </>
      }
    >
      {error ? (
        <Banner tone="danger" title="This change cannot be planned">{error}</Banner>
      ) : !plan ? (
        <p className="nds-vt-plan-note">Building the plan…</p>
      ) : (
        <>
          {/* The dry-run banner is the server's sentence — one source for the page, the dock and this. */}
          <Banner tone="warning">{plan.banner}</Banner>

          <div className="nds-vt-plan-table" role="table" aria-label={`Steps for ${plan.title}`}>
            <div className="nds-vt-plan-head" role="row">
              {COLUMNS.map((column) => (
                <span key={column} role="columnheader" className={`nds-vt-plan-c-${column === '#' ? 'n' : column.toLowerCase()}`}>{column}</span>
              ))}
            </div>
            {plan.steps.map((step) => (
              <div key={step.n} className="nds-vt-plan-row" role="row">
                <span role="cell" className="nds-vt-plan-c-n">{step.n}</span>
                <span role="cell" className="nds-vt-plan-c-verb">{step.verb}</span>
                <span role="cell" className="nds-vt-plan-c-target">{step.target}</span>
                <span role="cell" className="nds-vt-plan-c-detail">{step.detail}</span>
                <span
                  role="cell"
                  className={`nds-vt-plan-c-reversible ${step.reversible === null ? 'none' : step.reversible ? 'yes' : 'no'}`}
                >
                  {step.reversible === null ? '—' : step.reversible ? 'yes' : 'no'}
                </span>
              </div>
            ))}
          </div>

          <div className="nds-vt-plan-outcomes">
            <div>
              <div className="nds-vt-plan-keeps-title">Keeps</div>
              {plan.keeps.map((item) => <div key={item} className="nds-vt-plan-item">· {item}</div>)}
            </div>
            <div>
              <div className="nds-vt-plan-loses-title">Loses</div>
              {plan.loses.map((item) => <div key={item} className="nds-vt-plan-item">· {item}</div>)}
            </div>
          </div>

          {/* 🔴 Rendered, never hidden. These are what the LIVE run would refuse or fall back to, stated
              by the adapter that would refuse it — the whole value of building the plan from the real
              composer instead of describing it. */}
          {plan.warnings.length > 0 && (
            <Banner tone="warning" title={plan.warnings.length === 1 ? 'One thing the live run would hit' : `${plan.warnings.length} things the live run would hit`}>
              {plan.warnings.map((warning) => <div key={warning} className="nds-vt-plan-item">{warning}</div>)}
            </Banner>
          )}
        </>
      )}
    </Modal>
  )
}
