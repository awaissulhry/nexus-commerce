'use client'
/**
 * MCP.5 — the page Claude sends a person to when it asks to connect to Nexus (OAuth 2.1
 * authorization endpoint; the API is the authorization server, apps/api/src/routes/oauth.routes.ts).
 *
 * It reads Claude's request from the query, asks the API to check it, and shows the ConsentForm. The
 * person picks one business and approves with a fresh 2FA code; the API answers with Claude's
 * redirect URI, and the browser goes there. A signed-out visitor signs in first and comes back with
 * the whole query (this path is public for exactly that; see lib/auth/public-paths.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import { Banner, Card } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { useAuth } from '@/lib/auth/AuthProvider'
import { installAuthFetch } from '@/lib/auth/install-fetch'
import { setCsrfToken } from '@/lib/auth/csrf-store'
import { useTheme } from '@/lib/theme/use-theme'
import { ConsentForm, type ConsentView } from './ConsentForm'
import '../../profiles/profiles.css'
import './consent.css'

interface OAuthProblem {
  error?: string
  error_description?: string
  redirectTo?: string
}

type Stage =
  | { kind: 'checking' }
  | { kind: 'ready'; view: ConsentView }
  | { kind: 'problem'; message: string; redirectTo?: string; signIn?: boolean }
  | { kind: 'leaving'; message: string }

const describe = (problem: OAuthProblem, fallback: string) => problem.error_description || fallback

export default function AuthorizePage() {
  // MCP.12 — like /profiles, this page has no application top bar to apply the saved theme, so it never turned dark.
  useTheme()
  const { status } = useAuth()
  const [search, setSearch] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'checking' })
  const [workspaceId, setWorkspaceId] = useState('')
  const [allowWrite, setAllowWrite] = useState(true)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    installAuthFetch()
    setSearch(window.location.search)
  }, [])
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search ?? '')), [search])
  const signInHref = `/login?next=${encodeURIComponent(`/oauth/authorize${search ?? ''}`)}`

  useEffect(() => {
    if (search === null || status !== 'authed') return
    let alive = true
    fetch(`${getBackendUrl()}/api/oauth/authorize/check${search}`)
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!alive) return
        if (response.ok) {
          const view = data as ConsentView
          setWorkspaceId(view.businesses.find((business) => business.canConnect)?.id ?? '')
          setAllowWrite(view.scopes.includes('nexus.write'))
          setStage({ kind: 'ready', view })
          return
        }
        const problem = data as OAuthProblem
        if (problem.error === 'mfa_required') {
          setStage({ kind: 'problem', message: 'Finish signing in with your two-factor code first.', signIn: true })
          return
        }
        setStage({ kind: 'problem', message: describe(problem, 'This connection request could not be read.'), redirectTo: problem.redirectTo })
      })
      .catch(() => alive && setStage({ kind: 'problem', message: 'Nexus could not be reached. Try again in a moment.' }))
    return () => { alive = false }
  }, [search, status])

  async function answer(decision: 'approve' | 'deny') {
    if (busy || stage.kind !== 'ready') return
    setBusy(true)
    setError(null)
    try {
      const csrf = await fetch(`${getBackendUrl()}/api/auth/csrf`).then((response) => response.json())
      setCsrfToken(csrf.csrfToken)
      const scopes = allowWrite ? ['nexus.read', 'nexus.write'] : ['nexus.read']
      const response = await fetch(`${getBackendUrl()}/api/oauth/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params, decision, workspaceId, scopes, code }),
      })
      const data = (await response.json().catch(() => ({}))) as OAuthProblem & { redirectTo?: string }
      if (response.ok && data.redirectTo) {
        setStage({ kind: 'leaving', message: decision === 'approve' ? `Connected. Returning to ${stage.view.clientName}…` : 'Cancelled. Returning…' })
        window.location.assign(data.redirectTo)
        return
      }
      if (data.redirectTo) {
        setStage({ kind: 'problem', message: describe(data, 'This connection request is no longer valid.'), redirectTo: data.redirectTo })
        return
      }
      setError(describe(data, 'Claude could not be connected. Try again.'))
      if (data.error === 'mfa_invalid' || data.error === 'mfa_locked') setCode('')
    } catch {
      setError('Nexus could not be reached. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  if (status === 'anon') {
    return (
      <div className="business-profiles-surface">
        <div className="business-profiles oauth-consent">
          <Card header="Connect Claude to Nexus" description="Sign in to Nexus to continue.">
            <div className="business-profile-actions">
              <Button variant="primary" asChild>
                <a href={signInHref}>Sign in</a>
              </Button>
            </div>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="business-profiles-surface">
      <div className="business-profiles oauth-consent">
        {stage.kind === 'checking' && (
          <Card header="Connect Claude to Nexus">
            <p role="status">Checking the request…</p>
          </Card>
        )}
        {stage.kind === 'ready' && (
          <ConsentForm
            view={stage.view}
            workspaceId={workspaceId}
            allowWrite={allowWrite}
            code={code}
            busy={busy}
            error={error}
            onWorkspace={setWorkspaceId}
            onAllowWrite={setAllowWrite}
            onCode={setCode}
            onApprove={() => void answer('approve')}
            onDeny={() => void answer('deny')}
          />
        )}
        {stage.kind === 'problem' && (
          <Card header="Connect Claude to Nexus">
            <div className="business-profile-form">
              <Banner tone="danger">{stage.message}</Banner>
              <div className="business-profile-actions">
                {stage.redirectTo && (
                  <Button variant="primary" onClick={() => window.location.assign(stage.redirectTo!)}>
                    Return to Claude
                  </Button>
                )}
                {stage.signIn && (
                  <Button variant="primary" asChild>
                    <a href={signInHref}>Sign in again</a>
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}
        {stage.kind === 'leaving' && (
          <Card header="Connect Claude to Nexus">
            <p role="status">{stage.message}</p>
          </Card>
        )}
      </div>
    </div>
  )
}
