'use client'

/**
 * Meta ads step 1 — "Connect Meta" / "Replace credentials": the business's own Meta app (App ID, App secret) and its
 * system-user token, typed in once (POST /api/meta-ads/connect, or PUT …/connections/:id/credentials to replace them).
 *
 * Centred DS `Modal`; every control is a DS `Field` + `Input`. The secret and the token are password fields: Nexus never
 * shows them back, they are kept in this dialog's memory only (never in browser storage), and they are cleared the
 * moment they are sent, whatever Meta answers. Meta checks the token before anything is saved; a refusal is said in
 * words. The words and every decision are in `./meta-selection.ts`.
 */
import { useId, useRef, useState, type FormEvent } from 'react'
import { Banner, Field, Modal } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'
import { saveMetaCredentials, type MetaConnectAnswer } from '@/lib/meta-ads/contract'
import { EMPTY_CREDENTIALS, canSubmitCredentials, connectRefusal, credentialProblems, credentialsBody, type CredentialsDraft } from './meta-selection'

export function MetaCredentialsDialog({ connectionId, appId, onClose, onSaved }: {
  /** Replace the credentials of this connection; null connects Meta in this business. */
  connectionId: string | null
  /** The saved App ID (not a secret) the replace form opens on. */
  appId?: string | null
  onClose: () => void
  onSaved: (answer: MetaConnectAnswer) => void
}) {
  const formId = useId()
  const replacing = connectionId !== null
  const [draft, setDraft] = useState<CredentialsDraft>({ ...EMPTY_CREDENTIALS, appId: appId ?? '' })
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ title: string; text: string } | null>(null)
  const inFlight = useRef(false)
  const problems = credentialProblems(draft)
  const set = (key: keyof CredentialsDraft) => (event: { target: { value: string } }) => { setRefusal(null); setDraft((d) => ({ ...d, [key]: event.target.value })) }
  const close = () => { if (!busy) onClose() }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    setTried(true)
    if (!canSubmitCredentials(draft)) return
    const body = credentialsBody(draft)
    // Sent once: the secret and the token leave this dialog's memory now, whatever Meta answers.
    setDraft((d) => ({ ...d, appSecret: '', systemUserToken: '' }))
    setTried(false)
    inFlight.current = true
    setBusy(true)
    setRefusal(null)
    try {
      const result = await saveMetaCredentials(body, connectionId)
      if (result.ok) { onSaved(result.answer); return }
      setRefusal(connectRefusal(result.code, result.error))
    } catch (err) {
      setRefusal({ title: 'Meta was not connected', text: `${err instanceof Error ? err.message : 'Nexus could not reach the server.'} Nothing was saved.` })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return <Modal open onClose={close} size="md" readable
    title={replacing ? 'Replace Meta credentials' : 'Connect Meta'}
    subtitle="Your business's own Meta app and system-user token. Nexus checks the token with Meta before it saves anything, and never shows the secret or the token again."
    footer={<>
      <Button onClick={close} disabled={busy}>Cancel</Button>
      <Button variant="primary" type="submit" form={formId} aria-busy={busy || undefined}
        heldReason={busy ? null : tried && !canSubmitCredentials(draft) ? 'Fill in the three fields as Meta shows them.' : null}>
        {busy ? 'Checking with Meta…' : replacing ? 'Check and replace' : 'Check and connect'}
      </Button>
    </>}>
    <form id={formId} className="nds-account-profile-form" onSubmit={submit} aria-busy={busy} autoComplete="off">
      {refusal && <Banner tone="danger" title={refusal.title}>{refusal.text}</Banner>}
      <Field label="App ID" required error={tried ? problems.appId : null}
        hint="In Meta for Developers: your app › App settings › Basic.">
        <Input value={draft.appId} onChange={set('appId')} inputMode="numeric" autoComplete="off" spellCheck={false} disabled={busy} />
      </Field>
      <Field label="App secret" required error={tried ? problems.appSecret : null}
        hint={replacing ? 'The saved secret is never shown. Paste it again, or paste a new one.' : 'On the same page. Stored encrypted and never shown again.'}>
        <Input type="password" value={draft.appSecret} onChange={set('appSecret')} autoComplete="new-password" spellCheck={false} disabled={busy} />
      </Field>
      <Field label="System-user token" required error={tried ? problems.systemUserToken : null}
        hint="In Meta Business settings › Users › System users: generate a token for this app. ads_read is required; business_management, pages_show_list and instagram_basic let Nexus list the Pages and Instagram accounts. Stored encrypted and never shown again.">
        <Input type="password" value={draft.systemUserToken} onChange={set('systemUserToken')} autoComplete="new-password" spellCheck={false} disabled={busy} />
      </Field>
    </form>
  </Modal>
}
