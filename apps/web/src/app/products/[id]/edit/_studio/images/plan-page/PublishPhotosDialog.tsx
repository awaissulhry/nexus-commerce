'use client'

import { useEffect, useRef, useState } from 'react'
import type { StudioPublishResult, StudioPublishReview, StudioPublishScope, StudioPublishSelection } from '@nexus/shared/studio-publication'

import { Banner, Modal } from '@/design-system/components'
import { Button, Checkbox, Tag } from '@/design-system/primitives'
import { usePermission } from '@/lib/auth/AuthProvider'

import { publicationRequest } from '../../publication/request'
import { requestAmazonRun, requestAmazonWorkspace } from '../amazon/transport'
import { destinationLabel, type MediaDestinationRow, type MediaRead } from './model'
import { amazonCheck, amazonOutcome, destinationsToCheck, ebayCheck, ebayOutcome, unsupportedReason, type AmazonSend, type EbaySend, type PhotoCheck, type PhotoOutcome } from './publishModel'
import styles from './planPage.module.css'

interface Line { d: MediaDestinationRow; check: PhotoCheck; ticked: boolean; sending?: boolean; outcome?: PhotoOutcome }
type Phase = 'checking' | 'ready' | 'sending' | 'done'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const TONE = { ready: 'success', same: 'neutral', blocked: 'warning', unsupported: 'neutral', checking: 'neutral' } as const
const STATE = { ready: 'Ready', same: 'No change', blocked: 'Fix first', unsupported: 'Not here', checking: 'Checking…' } as const

export interface PublishPhotosDialogProps {
  read: MediaRead
  open: boolean
  /** Opened from one destination's view: check and offer that destination only, with "Check all destinations". */
  only?: string | null
  onClose(): void
}

/**
 * Images rebuild P4c — "Review & publish photos" (PLAN.md §5.6). Every destination is checked against the channel first
 * (eBay: a fresh review of the listing; Amazon: an image run's review), each says what would change, and only the ticked
 * ones are sent — photos only. One destination at a time, each with its own answer; nothing else about a listing changes.
 */
export function PublishPhotosDialog({ read, open, only = null, onClose }: PublishPhotosDialogProps) {
  const canPublish = usePermission('products.publish')
  const [lines, setLines] = useState<Line[]>([])
  const [phase, setPhase] = useState<Phase>('checking')
  // Which destinations this window checks: the one it was opened from, until "Check all destinations".
  const [scope, setScope] = useState<string | null>(only)
  const round = useRef(0)
  const base = `/api/products/${encodeURIComponent(read.rootId)}/studio-publication`
  const update = (key: string, change: Partial<Line>) => setLines(list => list.map(l => l.d.key === key ? { ...l, ...change } : l))

  const checkOne = async (d: MediaDestinationRow): Promise<PhotoCheck> => {
    if (d.channel === 'EBAY') {
      const scope: StudioPublishScope = { channel: 'EBAY', marketplace: d.marketplace, accountId: d.accountId, ...(d.alias ? { listingId: d.alias.id } : {}) }
      return ebayCheck(await publicationRequest<StudioPublishReview>(`${base}/preview`, 'POST', scope))
    }
    // Amazon photos belong to the ASIN: one run for the account, through its first listed market (PLAN.md §7).
    const path = `/api/products/${encodeURIComponent(read.rootId)}/images-workspace/amazon?${new URLSearchParams({ market: d.markets[0], accountId: d.accountId })}`
    const workspace = await requestAmazonWorkspace(path)
    const listingIds = workspace.items.filter(i => i.asin).map(i => i.id)
    if (!listingIds.length) return { kind: 'blocked', reason: 'No Amazon SKU of this family has an ASIN yet.' }
    let run = await requestAmazonRun(path, '/review', { expectedRevision: workspace.revision, listingIds })
    for (let i = 0; i < 60 && amazonCheck(run, path).kind === 'checking'; i++) { await pause(2000); run = await requestAmazonRun(path, `/runs/${run.id}`) }
    const check = amazonCheck(run, path)
    return check.kind === 'checking' ? { kind: 'blocked', reason: 'Amazon is taking long to check these photos. Check again in a minute.' } : check
  }

  const check = async (onlyKey: string | null = scope) => {
    const token = ++round.current
    const chosen = destinationsToCheck(read.destinations, onlyKey)
    const initial: Line[] = chosen.map(d => { const reason = unsupportedReason(d); return { d, check: reason ? { kind: 'unsupported', reason } : { kind: 'checking' }, ticked: false } })
    setLines(initial); setPhase('checking')
    for (const line of initial) {
      if (line.check.kind !== 'checking') continue
      // A check that could not complete names its channel: the older tools' sentences speak of "the gallery".
      const result = await checkOne(line.d).catch((error: Error): PhotoCheck => ({ kind: 'blocked', reason: `${line.d.channel === 'AMAZON' ? 'Amazon' : 'eBay'} could not be checked: ${error.message}` }))
      if (token !== round.current) return
      update(line.d.key, { check: result, ticked: result.kind === 'ready' })
    }
    setPhase('ready')
  }
  // A new opening checks again (a review is only good for a few minutes): the destination it was opened from, else all.
  useEffect(() => { if (open) setScope(only); if (open && canPublish) void check(only); return () => { round.current++ } }, [open, canPublish, only]) // eslint-disable-line react-hooks/exhaustive-deps
  const checkAll = () => { setScope(null); void check(null) }

  const sendOne = async (send: EbaySend | AmazonSend): Promise<PhotoOutcome> => {
    if (send.channel === 'EBAY') {
      const selection = await publicationRequest<StudioPublishSelection>(`${base}/${encodeURIComponent(send.reviewId)}/selection`, 'POST', { selectedIds: send.selectedIds })
      let result = await publicationRequest<StudioPublishResult>(`${base}/${encodeURIComponent(send.reviewId)}/submit`, 'POST', { selectionToken: selection.token })
      for (let i = 0; i < 10 && !ebayOutcome(result).final; i++) { await pause(3000); result = await publicationRequest<StudioPublishResult>(`${base}/${encodeURIComponent(send.reviewId)}`, 'GET') }
      return ebayOutcome(result)
    }
    let run = await requestAmazonRun(send.path, `/runs/${send.runId}/publish`, { expectedRevision: send.revision })
    for (let i = 0; i < 90 && !amazonOutcome(run).final; i++) { await pause(2000); run = await requestAmazonRun(send.path, `/runs/${run.id}`) }
    return amazonOutcome(run)
  }

  const publish = async () => {
    setPhase('sending')
    for (const line of lines.filter(l => l.ticked && l.check.kind === 'ready')) {
      if (line.check.kind !== 'ready') continue
      update(line.d.key, { sending: true })
      const outcome = await sendOne(line.check.send).catch((error: Error): PhotoOutcome => ({ tone: 'danger', text: error.message, final: true }))
      update(line.d.key, { sending: false, outcome })
    }
    setPhase('done')
  }

  const count = (kind: PhotoCheck['kind']) => lines.filter(l => l.check.kind === kind).length
  const ticked = lines.filter(l => l.ticked && l.check.kind === 'ready')
  const skipped = count('ready') - ticked.length
  const footer = <>
    {phase !== 'sending' && <Button size="sm" variant="secondary" disabled={phase === 'checking' || !canPublish} onClick={() => void check()}>Check again</Button>}
    {phase !== 'sending' && scope && read.destinations.length > 1 && <Button size="sm" variant="secondary" disabled={phase === 'checking' || !canPublish} onClick={checkAll}>
      Check all {read.destinations.length} destinations</Button>}
    <span className={styles.spacer} />
    <Button size="sm" variant={phase === 'done' ? 'primary' : 'secondary'} disabled={phase === 'sending'} onClick={onClose}>{phase === 'done' ? 'Done' : 'Cancel'}</Button>
    {phase !== 'done' && <Button size="sm" variant="primary" disabled={phase !== 'ready' || !ticked.length || !canPublish} onClick={() => void publish()}>
      {phase === 'sending' ? 'Publishing…' : ticked.length ? `Publish photos to ${ticked.length} destination${ticked.length === 1 ? '' : 's'}${skipped ? ` · skip ${skipped}` : ''}` : 'Nothing to publish'}
    </Button>}
  </>

  return <Modal open={open} onClose={() => { if (phase !== 'sending') onClose() }} size="xl" title="Publish photos"
    subtitle="Only photos are sent. Titles, prices and stock are not touched." footer={footer}>
    <div className={styles.compareBody}>
      {!canPublish && <Banner tone="warning" title="Publishing permission required">Your role needs product publishing access.</Banner>}
      <p className={styles.muted} role="status">{phase === 'checking' ? `Checking each destination against the channel… ${lines.filter(l => l.check.kind !== 'checking').length} of ${lines.length}`
        : `Destinations ${lines.length} · With changes ${count('ready')} · Already the same ${count('same')} · Needs a fix ${count('blocked')}${count('unsupported') ? ` · Not sent from here ${count('unsupported')}` : ''}`}</p>
      <ul className={styles.compareLines} aria-label="Destinations to publish">
        {lines.map(line => <li key={line.d.key} className={styles.publishLine}>
          <Checkbox label={destinationLabel(line.d)} checked={line.ticked} disabled={line.check.kind !== 'ready' || phase !== 'ready' || !canPublish}
            onChange={() => update(line.d.key, { ticked: !line.ticked })} />
          <span className={styles.publishDetail}>
            <span className={styles.publishStatus}>
              {line.outcome ? <Tag tone={line.outcome.tone}>{line.outcome.tone === 'success' ? 'Sent' : line.outcome.tone === 'danger' ? 'Failed' : 'Sending'}</Tag>
                : line.sending ? <Tag tone="info">Sending…</Tag> : <Tag tone={TONE[line.check.kind]}>{STATE[line.check.kind]}</Tag>}
              <span>{line.outcome?.text ?? ('summary' in line.check ? line.check.summary : 'reason' in line.check ? line.check.reason : '')}</span>
            </span>
            {!line.outcome && line.check.kind === 'ready' && line.check.note && <span className={styles.muted}>{line.check.note}</span>}
            {!line.outcome && line.check.kind === 'ready' && line.d.channel === 'EBAY' && <span className={styles.muted}>
              Sending is one revision of this listing. eBay allows 250 revisions of a listing per calendar day.</span>}
          </span>
        </li>)}
      </ul>
    </div>
  </Modal>
}
