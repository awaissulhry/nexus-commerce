'use client'
/**
 * MCP.6 — the Connected apps section. The same component in both places: /settings/security lists
 * the person's own connections (scope "mine"), Team & Access lists the business's (scope
 * "business"). ConnectedAppsView is presentational, so it renders the same in the page and in
 * tests; ConnectedApps owns the requests (connectedAppsModel.ts).
 */
import { useCallback, useEffect, useReducer, useRef, type Ref } from 'react'
import { AsOf, Banner, Card, EmptyState, KeyValue, Modal, type KeyValueItem } from '@/design-system/components'
import { Button, Tag } from '@/design-system/primitives'
import {
  accessWords,
  connectedAppsReducer,
  consequence,
  COPY,
  initialConnectedApps,
  loadConnectedApps,
  personWords,
  revokeConnectedApp,
  sectionVisible,
  type ConnectedApp,
  type ConnectedAppsScope,
  type ConnectedAppsState,
} from './connectedAppsModel'
import './connected-apps.css'

export interface ConnectedAppsViewProps {
  scope: ConnectedAppsScope
  state: ConnectedAppsState
  onRetry: () => void
  onAsk: (grant: ConnectedApp) => void
  onCancel: () => void
  onConfirm: () => void
  /** Takes focus after a revoke: the row that held it is gone. */
  noticeRef?: Ref<HTMLDivElement>
  headingLevel?: 2 | 3
}

export function ConnectedAppsView({ scope, state, onRetry, onAsk, onCancel, onConfirm, noticeRef, headingLevel = 2 }: ConnectedAppsViewProps) {
  if (!sectionVisible(state)) return null
  return (
    <Card className="connected-apps" headingLevel={headingLevel} header="Connected apps" description={COPY[scope].description}>
      <div className="connected-apps-body">
        {state.notice && (
          <div ref={noticeRef} tabIndex={-1} className="connected-apps-notice">
            <Banner tone="success">{state.notice}</Banner>
          </div>
        )}
        {state.load === 'failed' ? (
          <Banner tone="danger" action={<Button onClick={onRetry}>Retry</Button>}>{state.loadError}</Banner>
        ) : (
          <>
            {!state.enabled && state.grants.length > 0 && (
              <Banner tone="info">Connecting Claude to Nexus is switched off. You can still end these connections.</Banner>
            )}
            {state.grants.length === 0 ? (
              <EmptyState title="No apps are connected." description={COPY[scope].empty} />
            ) : (
              <ul className="connected-apps-list" aria-label="Connected apps">
                {state.grants.map((grant) => (
                  <ConnectedAppRow key={grant.id} scope={scope} grant={grant} onAsk={onAsk} />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {state.confirming && (
        <RevokeDialog scope={scope} grant={state.confirming} busy={state.revoking} error={state.revokeError} onCancel={onCancel} onConfirm={onConfirm} />
      )}
    </Card>
  )
}

function ConnectedAppRow({ scope, grant, onAsk }: { scope: ConnectedAppsScope; grant: ConnectedApp; onAsk: (grant: ConnectedApp) => void }) {
  const who: KeyValueItem = scope === 'business' && grant.person
    ? {
        label: 'Connected by',
        value: <>{personWords(grant.person)}{!grant.person.active && <> <Tag tone="warning">Left this business</Tag></>}</>,
        hint: grant.person.name ? grant.person.email : undefined,
      }
    : { label: 'Business', value: grant.businessName }
  const where = scope === 'business' && grant.person ? personWords(grant.person) : grant.businessName
  return (
    <li className="connected-apps-row">
      <div className="connected-apps-main">
        <p className="connected-apps-app">
          <strong>{grant.appName}</strong>
          {grant.appHosts.length > 0 && <span className="connected-apps-host">Returns to {grant.appHosts.join(', ')}</span>}
        </p>
        <KeyValue dense columns={2} items={[
          who,
          { label: 'Access', value: accessWords(grant.scopes) },
          { label: 'Connected', value: <AsOf at={grant.createdAt} kind="event" /> },
          { label: 'Last used', value: <AsOf at={grant.lastUsedAt} kind="event" /> },
        ]} />
      </div>
      <div className="connected-apps-action">
        <Button variant="danger-outline" size="sm" aria-label={`Revoke ${grant.appName} for ${where}`} onClick={() => onAsk(grant)}>Revoke</Button>
      </div>
    </li>
  )
}

function RevokeDialog({ scope, grant, busy, error, onCancel, onConfirm }: {
  scope: ConnectedAppsScope
  grant: ConnectedApp
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const subtitle = scope === 'business' && grant.person ? `${personWords(grant.person)} · ${grant.businessName}` : grant.businessName
  return (
    <Modal open onClose={() => { if (!busy) onCancel() }} size="sm" title={`Revoke ${grant.appName}?`} subtitle={subtitle}
      footer={<>
        <Button data-autofocus disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button variant="danger" disabled={busy} onClick={onConfirm}>{busy ? 'Revoking…' : 'Revoke access'}</Button>
      </>}>
      <div className="connected-apps-dialog">
        {error && <Banner tone="danger">{error}</Banner>}
        <p>{consequence(scope, grant)}</p>
      </div>
    </Modal>
  )
}

/** The section with its own requests: list on mount, revoke after the dialog's answer. */
export function ConnectedApps({ scope, headingLevel }: { scope: ConnectedAppsScope; headingLevel?: 2 | 3 }) {
  const [state, dispatch] = useReducer(connectedAppsReducer, initialConnectedApps)
  const noticeRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const alive = useRef(true)
  // Set on every mount: StrictMode mounts, unmounts and mounts again, and a ref that is only ever
  // cleared would drop every answer after the first unmount.
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async () => {
    dispatch({ type: 'reload' })
    const result = await loadConnectedApps(scope)
    if (alive.current) dispatch({ type: 'loaded', result })
  }, [scope])
  useEffect(() => { void load() }, [load])

  const confirming = state.confirming
  const confirm = useCallback(async () => {
    if (!confirming || inFlight.current) return
    inFlight.current = true
    dispatch({ type: 'revoking' })
    const result = await revokeConnectedApp(scope, confirming.id)
    inFlight.current = false
    if (alive.current) dispatch({ type: 'revoked', result })
  }, [scope, confirming])

  useEffect(() => {
    if (state.notice) noticeRef.current?.focus()
  }, [state.notice])

  return (
    <ConnectedAppsView
      scope={scope}
      state={state}
      headingLevel={headingLevel}
      noticeRef={noticeRef}
      onRetry={() => { void load() }}
      onAsk={(grant) => dispatch({ type: 'ask', grant })}
      onCancel={() => dispatch({ type: 'cancel' })}
      onConfirm={() => { void confirm() }}
    />
  )
}
