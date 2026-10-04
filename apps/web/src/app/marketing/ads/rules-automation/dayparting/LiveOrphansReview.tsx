'use client'

/**
 * Owner 2026-10-04 — the review behind the Rank & Dayparting list's banner: the live campaigns that still carry a bid
 * floor or a base-bid change Rank & Dayparting made, with no schedule or plan holding them. The rank loop never changes
 * a live campaign by itself, so a person gives each one back here, one campaign per click, after the design system's
 * confirmation lists every bid (now → goes back to).
 */
import { useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { usePermission } from '@/lib/auth/AuthProvider'
import { Button } from '@/design-system/primitives'
import { Banner, Card, Modal, SummaryTable, useActionConfirm } from '@/design-system/components'
import { giveBackImpact, giveBackOutcome, liveOrphanLine, liveOrphanRows, type LiveOrphan, type LiveOrphanList, type LiveOrphanRelease } from './liveOrphans'

export function LiveOrphansReview({ list, onClose, onChanged }: {
  list: LiveOrphanList
  onClose: () => void
  /** Re-read the list after a give-back. */
  onChanged: () => Promise<void> | void
}) {
  const canGiveBack = usePermission('ads.campaigns.manage')
  const confirm = useActionConfirm()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null)

  const giveBack = async (o: LiveOrphan) => {
    if (busy || !(await confirm.ask(giveBackImpact(o, list.waitWhy)))) return
    setBusy(o.campaignId); setNote(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/rank-release/enabled-orphans/${encodeURIComponent(o.campaignId)}/release`, { method: 'POST' })
      const body = await r.json().catch(() => null) as (LiveOrphanRelease & { error?: string }) | null
      setNote(r.ok && body ? giveBackOutcome(body) : { tone: 'warning', text: body?.error ?? `Could not give the bids back on ${o.name} (${r.status}). Check its bids before you try again.` })
    } catch {
      setNote({ tone: 'warning', text: `The request for ${o.name} did not reach Nexus. Check its bids before you try again.` })
    } finally {
      setBusy(null)
      await onChanged()
    }
  }

  return (
    <>
      <Modal
        open size="lg" onClose={() => { if (!busy) onClose() }}
        title="Live campaigns with bids rank changed"
        footer={<Button variant="secondary" size="sm" onClick={onClose} disabled={!!busy}>Close</Button>}
      >
        <p className="h10-ntm-say">
          These live campaigns still carry a bid floor or a base-bid change that Rank &amp; Dayparting made, and no rank
          schedule or plan holds them any more. The rank loop gives bids back by itself only on paused campaigns, so these
          wait for you. Each button gives back one campaign&rsquo;s bids, and shows every bid before it changes.
        </p>
        {list.waitWhy && <Banner tone="warning">Giving bids back waits right now because {list.waitWhy}. Nothing changes until that changes.</Banner>}
        {!canGiveBack && <Banner tone="info">You can see these campaigns; giving their bids back needs the permission to manage ad campaigns.</Banner>}
        {note && <Banner tone={note.tone} onDismiss={() => setNote(null)}>{note.text}</Banner>}
        {list.items.length === 0 ? (
          <p className="h10-ntm-ok">No live campaign carries bids rank changed any more.</p>
        ) : (
          <div className="rd-orphans">
            {list.items.map((o) => (
              <Card
                key={o.campaignId} header={o.name} headingLevel={3} description={liveOrphanLine(o)}
                headerAction={canGiveBack ? (
                  <Button size="sm" variant="primary" onClick={() => void giveBack(o)} disabled={!!busy}>
                    {busy === o.campaignId ? 'Giving back…' : 'Give bids back'}
                  </Button>
                ) : undefined}
              >
                <SummaryTable label={`Bids on ${o.name}`} columns={['Ad group or target', 'Bid now', 'Goes back to']} rows={liveOrphanRows(o)} />
              </Card>
            ))}
          </div>
        )}
      </Modal>
      {confirm.element}
    </>
  )
}
