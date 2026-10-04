'use client'
import { useEffect, useState } from 'react'
import { Timeline } from '../components/Timeline'
import { PublishStatusPill, PublishStatusView } from '../grid/renderers/PublishStatusCell'
import { PUBLICATION_STATUSES, PUBLISH_RESULT_STATUSES, publicationStatusMeta, publishResultMeta, type PublishStatusValue } from '../grid/renderers/publishStatus'
import { SheetStatuses } from '../grid/toolbars/SheetStatus'

/**
 * Publish status (sheet publish parity, 2026-10-02) — the one status vocabulary, the "Last publish" cell and its card,
 * the sheet toolbar mark that is also a filter, and the read-only Timeline. Verify: every state below in light and
 * dark and at 390px; open a cell's card by pointer, click, Enter or Space; Tab through "Go to field" and "See publish
 * history"; Esc returns focus to the trigger; the toolbar mark toggles with Space/Enter and announces pressed.
 */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const DAYS_AGO = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const SAMPLES: Array<{ label: string; value: PublishStatusValue | undefined }> = [
  { label: 'Verified', value: { destinationLabel: 'eBay · IT · Xavia Racing', last: { publicationId: 'pub_a', status: 'VERIFIED', at: ago(45), userName: 'Dev Owner', reference: 'ITEM-0001', sentFields: ['Title', 'Description', 'Item specifics'], issues: [] } } },
  {
    label: 'Failed, with fields', value: {
      destinationLabel: 'Amazon · IT', last: {
        publicationId: 'pub_b', status: 'FAILED', at: ago(130), userName: 'Dev Owner', reference: 'FEED-0002', message: 'Amazon refused 2 attributes.', sentFields: ['Colour', 'Size', 'Bullet points'],
        issues: [
          { severity: 'error', code: '8541', message: 'The value is not one of the allowed values.', fieldLabel: 'Colour', columnKey: 'amazon:color' },
          { severity: 'warning', message: 'A recommended attribute is empty.', fieldLabel: 'Care instructions' },
        ],
      },
    },
  },
  { label: 'Partly failed, this row passed', value: { destinationLabel: 'Amazon · DE', last: { publicationId: 'pub_c', status: 'PARTIAL', outcome: 'ACCEPTED', at: DAYS_AGO(3), userName: null, sentFields: ['$create'], issues: [] } } },
  { label: 'Waiting for channel', value: { destinationLabel: 'Amazon · FR', inFlight: { status: 'SUBMITTED' }, last: null } },
  { label: 'Edited since', value: { destinationLabel: 'eBay · DE', editedSince: true, last: { publicationId: 'pub_d', status: 'ACCEPTED', at: DAYS_AGO(1), userName: 'Dev Owner', sentFields: ['Title'], issues: [] } } },
  { label: 'Result unknown', value: { destinationLabel: 'eBay · FR', last: { publicationId: 'pub_e', status: 'UNVERIFIED', at: ago(50), userName: 'Dev Owner', sentFields: ['Pictures'], issues: [] } } },
  { label: 'Never published', value: { destinationLabel: 'Shopify · Xavia', last: null } },
  { label: 'Loading', value: undefined },
  { label: 'Read failed', value: { destinationLabel: 'Amazon · ES', last: null, readError: 'HTTP 500' } },
]

// A caption and its cell side by side; at phone width the cell wraps under its caption instead of running off screen.
const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-2) var(--nds-space-8)', minHeight: 32 } as const
const caption = { fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text)' } as const
const heading = { fontSize: 'var(--nds-font-size-sm)', fontWeight: 700, color: 'var(--nds-text-strong)', margin: 'var(--nds-space-16) 0 var(--nds-space-8)' } as const

export function PublishStatusExample() {
  const [action, setAction] = useState('none')
  const [onlyRejected, setOnlyRejected] = useState(false)
  // The samples' times are relative to the viewer's clock and locale, which exist only in the browser: draw the cells
  // after mount so the server render and the first client render agree (a grid cell is client-only anyway).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return (
    <div id="publish-status-example" style={{ display: 'flex', flexDirection: 'column', maxWidth: 640, color: 'var(--nds-text)' }}>
      <h4 style={{ ...heading, marginTop: 0 }}>Status words · one table for every surface</h4>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-6)' }} aria-label="Publication statuses">
        {PUBLICATION_STATUSES.map(s => { const m = publicationStatusMeta(s); return <span key={s} title={m.hint}><PublishStatusPill meta={m} /></span> })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--nds-space-6)', marginTop: 'var(--nds-space-8)' }} aria-label="Per-product results">
        {PUBLISH_RESULT_STATUSES.map(s => { const m = publishResultMeta(s); return <span key={s} title={m.hint}><PublishStatusPill meta={m} /></span> })}
      </div>

      <h4 style={heading}>Last publish cell · every state</h4>
      {SAMPLES.map(sample => (
        <div key={sample.label} style={row}>
          <span style={{ ...caption, flex: '0 0 170px' }}>{sample.label}</span>
          <span style={{ minWidth: 0, maxWidth: '100%' }}>
            <PublishStatusView value={mounted ? sample.value : undefined} onGoToField={key => setAction(`Go to field ${key}`)} onOpenHistory={id => setAction(`Open history ${id}`)} />
          </span>
        </div>
      ))}
      <p style={{ ...caption, margin: 'var(--nds-space-8) 0 0' }}>Last action: {action}</p>

      <h4 style={heading}>Toolbar mark · a status that is also a filter</h4>
      <SheetStatuses status={[
        { tone: 'danger', label: '2 rejected on Amazon · IT', detail: 'Amazon refused 2 products in the last publish.', onSelect: () => setOnlyRejected(v => !v), actionLabel: onlyRejected ? 'Show all rows' : 'Show these rows', selected: onlyRejected },
        { tone: 'info', label: 'Processing on Amazon · FR', detail: 'Amazon has 21 products. Nexus reads Amazon’s report by itself; results appear on each row.' },
      ]} />
      <p style={{ ...caption, margin: 'var(--nds-space-8) 0 0' }}>Filter: {onlyRejected ? 'only rejected rows' : 'all rows'}</p>

      <h4 style={heading}>Timeline · what happened, in order</h4>
      <Timeline label="Publish steps" steps={[
        { key: 'reviewed', label: 'Reviewed', tone: 'neutral', at: ago(14), detail: '23 products · 3 fields each' },
        { key: 'sent', label: 'Sent to Amazon · IT', tone: 'info', at: ago(13), detail: 'Feed FEED-0002' },
        { key: 'processed', label: 'Amazon refused 2 of 23', tone: 'danger', at: ago(6), detail: '21 accepted. Open a failed product to see why.' },
        { key: 'verified', label: 'Read back from Amazon', tone: 'neutral', at: null },
      ]} />
    </div>
  )
}
