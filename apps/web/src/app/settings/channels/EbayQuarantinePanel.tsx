'use client'

import { useEffect, useRef, useState } from 'react'
import { Card } from '@/design-system/components/Card'
import { Banner } from '@/design-system/components/Banner'
import { Field } from '@/design-system/components/Field'
import { Listbox } from '@/design-system/components/Listbox'
import { Modal } from '@/design-system/components/Modal'
import { EmptyState } from '@/design-system/components/EmptyState'
import { Button } from '@/design-system/primitives/Button'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { WORKSPACES_ENABLED } from '@/lib/workspaces/paths'
import type { AccountRow } from './channels-data'
import { assignQuarantineNotice, readQuarantinePage, QuarantineRequestError, type QuarantineNotice, type QuarantinePage } from './quarantine-client'

interface Props {
  accounts: AccountRow[]
  loading: boolean
  error: string | null
  workspaceId?: string | null
  workspaceName?: string
  onAssigned: () => void
}

/** Includes inactive owned identities; recovery must never require reconnecting an account. */
export function EbayQuarantinePanel(props: Props) {
  const [selected, setSelected] = useState('')
  const accounts = props.accounts.filter(account => account.channel === 'EBAY' && account.managedBy === 'oauth' && account.externalAccountId)
  const account = accounts.find(item => item.id === selected) ?? accounts.find(item => item.isActive !== false) ?? accounts[0]
  if (props.loading) return <Card header="Unassigned eBay notices"><Skeleton height={100} /></Card>
  if (props.error) return <Card header="Unassigned eBay notices"><Banner tone="danger" title="Accounts unavailable">{props.error}</Banner></Card>
  if (WORKSPACES_ENABLED && !props.workspaceId) return <Card header="Unassigned eBay notices"><Banner tone="info" title="Business profile required">Choose a business profile to review its matching notices.</Banner></Card>
  if (!account) return null
  return <Card header="Unassigned eBay notices" headingLevel={3}
    description="Review verified authorization notices matching this account and assign them to the current business profile.">
    <Field label="eBay account">
      <Listbox ariaLabel="eBay account for notice recovery" value={account.id} onChange={setSelected}
        options={accounts.map(item => ({ value: item.id, label: `${item.label}${item.isActive === false ? ' · inactive' : ''} · ${item.id.slice(-6)}` }))} />
    </Field>
    <RecoveryList key={`${props.workspaceId ?? 'legacy'}:${account.id}`} account={account} workspaceId={props.workspaceId}
      workspaceName={props.workspaceName} onAssigned={props.onAssigned} />
  </Card>
}

function RecoveryList({ account, workspaceId, workspaceName, onAssigned }: Pick<Props, 'workspaceId' | 'workspaceName' | 'onAssigned'> & { account: AccountRow }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const after = cursors[cursors.length - 1]
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<QuarantinePage | null>(null)
  const [readError, setReadError] = useState<{ message: string; ownerOnly: boolean } | null>(null)
  const [pending, setPending] = useState<QuarantineNotice | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false), alive = useRef(true), writeAbort = useRef<AbortController | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const scope = { connectionId: account.id, workspaceId }
  useEffect(() => { alive.current = true; return () => { alive.current = false; writeAbort.current?.abort() } }, [])
  useEffect(() => { if (result) resultRef.current?.focus() }, [result])
  useEffect(() => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000)
    let cancelled = false
    setPage(null); setReadError(null)
    void readQuarantinePage({ connectionId: account.id, workspaceId }, after, controller.signal)
      .then(value => { if (!cancelled) setPage(value) })
      .catch(error => { if (!cancelled) setReadError({ message: error instanceof Error && error.name !== 'AbortError'
        ? error.message : 'The notice list timed out. Refresh to try again.', ownerOnly: error instanceof QuarantineRequestError && error.status === 403 }) })
      .finally(() => clearTimeout(timeout))
    return () => { cancelled = true; clearTimeout(timeout); controller.abort() }
  }, [account.id, workspaceId, after, revision])

  const assign = async () => {
    if (!pending || busyRef.current) return
    busyRef.current = true; setBusy(true)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 45_000)
    writeAbort.current = controller
    try {
      await assignQuarantineNotice(scope, pending.id, controller.signal)
      if (alive.current) {
        setResult({ ok: true, text: `Assigned to ${account.label}. Check the event’s processing status in Ingress.` })
        onAssigned()
      }
    } catch (error) {
      if (alive.current) setResult({ ok: false, text: error instanceof Error && error.name !== 'AbortError'
        ? error.message : 'Assignment could not be confirmed. Refresh before trying again.' })
    } finally {
      clearTimeout(timeout); writeAbort.current = null; busyRef.current = false
      if (alive.current) { setBusy(false); setPending(null); setRevision(value => value + 1) }
    }
  }

  return <div className="grid gap-3 mt-4">
    {result && <div ref={resultRef} tabIndex={-1} role="region" aria-label={result.ok ? 'Notice assigned' : 'Assignment not confirmed'}>
      <Banner tone={result.ok ? 'info' : 'danger'} title={result.ok ? 'Notice assigned' : 'Assignment not confirmed'}>{result.text}</Banner>
    </div>}
    {readError ? <Banner tone={readError.ownerOnly ? 'info' : 'danger'} title={readError.ownerOnly ? 'Owner access required' : 'Notices unavailable'}>{readError.message}</Banner>
      : !page ? <Skeleton height={100} />
        : page.items.length === 0 ? <EmptyState title={cursors.length > 1 ? 'No notices on this page' : 'No matching notices need assignment'}
          description={cursors.length > 1 ? 'Return to the previous page to review earlier notices.' : `Verified authorization notices awaiting assignment to ${account.label} appear here.`} />
          : <ul className="grid gap-3" aria-label="Matching unassigned notices">
            {page.items.map(notice => <li key={notice.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0 text-sm">
                <strong>Authorization notice · {notice.environment === 'sandbox' ? 'Sandbox' : 'Production'}</strong>
                <p className="text-[var(--nds-text-muted)]">Received {new Date(notice.receivedAt).toLocaleString()} · {notice.deliveries} deliveries</p>
                <p className="break-all text-[var(--nds-text-muted)]">Reference: {notice.externalId}</p>
              </div>
              <Button size="sm" disabled={busy} onClick={() => { setResult(null); setPending(notice) }} aria-label={`Review notice ${notice.externalId}`}>Review assignment</Button>
            </li>)}
          </ul>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh notices</Button>
      {cursors.length > 1 && <Button size="sm" disabled={busy || !page} onClick={() => setCursors(value => value.slice(0, -1))}>Previous notices</Button>}
      {page?.nextCursor && <Button size="sm" disabled={busy} onClick={() => setCursors(value => [...value, page.nextCursor])}>More notices</Button>}
    </div>
    <Modal open={!!pending} onClose={() => { if (!busyRef.current) setPending(null) }} title="Assign this eBay notice?"
      subtitle={`${account.label} · connection ending ${account.id.slice(-6)}${workspaceName ? ` · ${workspaceName}` : ''}`}
      footer={<><Button disabled={busy} onClick={() => setPending(null)}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => void assign()}>{busy ? 'Assigning…' : 'Assign notice'}</Button></>}>
      <p>This keeps the original delivery history and assigns the verified notice to this exact account. When eBay processing is enabled, the notice may change the account’s authorization status.</p>
      {pending && <p className="mt-3 break-all text-sm">Reference: {pending.externalId}</p>}
    </Modal>
  </div>
}
