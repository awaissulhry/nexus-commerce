'use client'
/**
 * MCP.5 — what a person sees when Claude asks to connect: which app, where it returns, which one
 * business, what it may do, and a fresh 2FA code. Presentational only: page.tsx owns the requests,
 * so this renders the same in the page, in tests and in the design lab.
 *
 * MCP full control C4 — when Claude signs in at one business's own Nexus address (/mcp/w/<business>), the business is
 * locked: the form names it and offers no other (the API refuses any other too).
 *
 * C5 — when the app asks for nexus.run, one more tick, unticked to start: Claude may then run the changes the business
 * set to run by rule (auto, inside its limits) without a person. It needs "ask for changes".
 */
import { useId, type FormEvent } from 'react'
import { Banner, Card, Field, KeyValue } from '@/design-system/components'
import { Button, Checkbox, Input, Select } from '@/design-system/primitives'

export interface ConsentView {
  clientName: string
  redirectHost: string
  loopback: boolean
  scopes: Array<'nexus.read' | 'nexus.write' | 'nexus.run'>
  mfaEnrolled: boolean
  businesses: Array<{ id: string; name: string; canConnect: boolean }>
  /** C4 — the business the connection's address names; `businesses` then holds that one at most. */
  lockedWorkspaceId: string | null
}

export interface ConsentFormProps {
  view: ConsentView
  workspaceId: string
  allowWrite: boolean
  /** C5 — nexus.run: run the changes the business set to run by rule. */
  allowRun: boolean
  code: string
  busy: boolean
  error: string | null
  onWorkspace: (id: string) => void
  onAllowWrite: (allow: boolean) => void
  onAllowRun: (allow: boolean) => void
  onCode: (code: string) => void
  onApprove: () => void
  onDeny: () => void
}

export function ConsentForm(props: ConsentFormProps) {
  const { view } = props
  const scopesLabel = useId()
  const connectable = view.businesses.filter((business) => business.canConnect)
  const locked = view.lockedWorkspaceId ? view.businesses.find((business) => business.id === view.lockedWorkspaceId) : undefined
  const ready = !props.busy && connectable.some((b) => b.id === props.workspaceId) && /^\d{6}$/.test(props.code)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready) props.onApprove()
  }
  return (
    <Card
      header={`Connect ${view.clientName} to Nexus`}
      description={`${view.clientName} will work in one business as you. It can read what you can see. If you allow it, it can also ask for changes, and nothing changes until someone with permission approves it in Nexus${view.scopes.includes('nexus.run') ? ' — unless you also let it run the changes your business set to run by rule' : ''}.`}
    >
      <form className="business-profile-form" onSubmit={submit} aria-busy={props.busy}>
        <p>
          Returns to <strong>{view.redirectHost}</strong>
        </p>
        {view.loopback && (
          <Banner tone="warning">
            This sends you back to a program on this computer. Continue only if you started Claude Code here yourself.
          </Banner>
        )}
        {props.error && <Banner tone="danger">{props.error}</Banner>}
        {!view.mfaEnrolled ? (
          <>
            <Banner tone="warning">Turn on two-factor authentication before you connect Claude.</Banner>
            <div className="business-profile-actions">
              <Button variant="primary" asChild>
                <a href="/settings/security">Turn on two-factor authentication</a>
              </Button>
              <Button type="button" onClick={props.onDeny} disabled={props.busy}>
                Cancel
              </Button>
            </div>
          </>
        ) : connectable.length === 0 ? (
          <>
            <Banner tone="warning">
              {view.lockedWorkspaceId
                ? 'You cannot connect Claude to the business this connection is for: you are not a member, it is not open to Claude yet, or your role there lacks the permission to use the assistant (ai.run).'
                : 'You cannot connect Claude to any of your businesses. It needs the permission to use the assistant (ai.run).'}
            </Banner>
            <div className="business-profile-actions">
              <Button type="button" onClick={props.onDeny} disabled={props.busy}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            {locked ? (
              <KeyValue
                items={[{
                  label: 'Business',
                  value: locked.name,
                  hint: `This connection is for ${locked.name} only: Claude sees and changes nothing else. To use another business, add it in Claude with that business’s own Nexus address.`,
                }]}
              />
            ) : (
              <Field label="Business" hint="Claude sees only this business. Connect it again to use another one.">
                <Select value={props.workspaceId} onChange={(event) => props.onWorkspace(event.target.value)} disabled={props.busy}>
                  {view.businesses.map((business) => (
                    <option key={business.id} value={business.id} disabled={!business.canConnect}>
                      {business.canConnect ? business.name : `${business.name} — needs ai.run`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div role="group" aria-labelledby={scopesLabel} className="business-profile-form">
              <p id={scopesLabel} className="oauth-consent-group-label">
                Claude may
              </p>
              <Checkbox checked disabled label="Read the products, orders, stock, listings and reports you can see" />
              {view.scopes.includes('nexus.write') && (
                <Checkbox
                  checked={props.allowWrite}
                  onChange={(event) => props.onAllowWrite(event.target.checked)}
                  disabled={props.busy}
                  label="Ask for changes — each one waits for approval in Nexus by someone with permission"
                />
              )}
              {view.scopes.includes('nexus.run') && view.scopes.includes('nexus.write') && (
                <Checkbox
                  checked={props.allowWrite && props.allowRun}
                  onChange={(event) => props.onAllowRun(event.target.checked)}
                  disabled={props.busy || !props.allowWrite}
                  label="Run the changes your business set to run by rule — only those, only inside their limits, and anyone with permission can stop each one in Nexus"
                />
              )}
            </div>
            <Field label="Two-factor code" required hint="The 6-digit code from your authenticator app.">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={props.code}
                onChange={(event) => props.onCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                disabled={props.busy}
              />
            </Field>
            <div className="business-profile-actions">
              <Button variant="primary" type="submit" disabled={!ready}>
                {props.busy ? 'Connecting…' : 'Connect'}
              </Button>
              <Button type="button" onClick={props.onDeny} disabled={props.busy}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </form>
    </Card>
  )
}
