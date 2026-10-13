'use client'

/**
 * Google Ads step 1a, W1 — "Choose Google accounts": which Google Ads account this business reads (required), the
 * manager it is reached through (only when that matters), and the Merchant Center account and Google Analytics
 * property (optional, chosen now and read in a later step).
 *
 * Centred DS `Modal`; every control is a DS `Field` + `Listbox`. Each product's list is read on its own (C2), so one
 * failing shows its own banner and leaves the others usable. An account another business in Nexus already picked is a
 * held option ("Chosen in another business in Nexus"), never chosen for the person. Saving (C3) is checked by the
 * server against a fresh read and queues the first read; a refusal (409) is said in words and never names another
 * business.
 * The words and every decision are in `./google-selection.ts`.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Banner, Field, Listbox, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { fetchGoogleChoices, saveGoogleSelection, type GoogleAccount, type GoogleChoices } from '@/lib/google-ads/contract'
import {
  adsAccountOptions,
  analyticsOptions,
  canSave,
  chooseAds,
  conflictText,
  initialDraft,
  managerOptions,
  merchantOptions,
  readableCustomers,
  reconcileDraft,
  saveHeldReason,
  sectionError,
  selectionBody,
  type SectionErrorView,
  type SectionProduct,
  type SelectionDraft,
} from './google-selection'

const LATER_HINT = 'Nexus reads nothing from it yet; it is used in a later step.'

export function GoogleAccountsDialog({ connectionId, current, onClose, onSaved, onReconnect }: {
  connectionId: string
  /** The saved choice, if any — the dialog opens on it. */
  current?: GoogleAccount | null
  onClose: () => void
  onSaved: (account: GoogleAccount) => void
  /** Starts a new Google sign-in for this connection (a missing permission is fixed there). */
  onReconnect?: () => void
}) {
  const formId = useId()
  const [choices, setChoices] = useState<GoogleChoices | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<SelectionDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<{ title: string; text: string; inAds: boolean } | null>(null)
  const inFlight = useRef(false)
  const request = useRef(0)
  // The saved choice the dialog opens on, read once: a parent re-render must not read Google's lists again.
  const opening = useRef(current)

  const load = useCallback(async () => {
    const sequence = ++request.current
    setLoading(true)
    setLoadError(null)
    try {
      const next = await fetchGoogleChoices(connectionId)
      if (request.current !== sequence) return
      setChoices(next)
      setDraft((prev) => (prev ? reconcileDraft(prev, next) : initialDraft(opening.current, next)))
    } catch (err) {
      if (request.current === sequence) setLoadError(err instanceof Error ? err.message : 'Google did not answer. Try again.')
    } finally {
      if (request.current === sequence) setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    void load()
    return () => { request.current++ }
  }, [load])

  const adsOptions = useMemo(() => adsAccountOptions(choices), [choices])
  const chosenCustomer = useMemo(() => readableCustomers(choices).find((c) => c.customerId === draft?.ads), [choices, draft?.ads])
  const managers = useMemo(() => managerOptions(chosenCustomer), [chosenCustomer])
  const merchants = useMemo(() => merchantOptions(choices), [choices])
  const properties = useMemo(() => analyticsOptions(choices), [choices])
  const ready = !!draft && canSave(draft, choices)

  const close = () => { if (!busy) onClose() }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || !draft) return
    if (!ready) return
    inFlight.current = true
    setBusy(true)
    setSaveError(null)
    try {
      const result = await saveGoogleSelection(connectionId, selectionBody(draft))
      if (result.ok) { onSaved(result.account); return }
      const words = conflictText(result.code, result.error, result.product)
      setSaveError({ ...words, inAds: result.code === 'customer_taken' || (result.code === 'taken_by_other_business' && result.product === 'ads') })
      // Google no longer offers a pick, or another business picked it meanwhile: read the lists again, so the dialog
      // shows what may be chosen now (Google's lists are kept for 5 minutes; who picked what is read fresh).
      if (result.code === 'not_offered' || result.code === 'taken_by_other_business') void load()
    } catch (err) {
      setSaveError({ title: 'The choice was not saved', text: err instanceof Error ? err.message : 'Nexus could not reach the server. Try again.', inAds: false })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const sectionBanner = (product: SectionProduct, view: SectionErrorView | null) => view && (
    <Banner tone={view.tone} title={view.title} action={view.action === 'reconnect' && onReconnect
      ? <Button onClick={onReconnect} disabled={busy}>Reconnect</Button>
      : view.action === 'retry'
        ? <Button onClick={() => { void load() }} disabled={busy || loading}>Try again</Button>
        : undefined}>
      <span data-google-section={product}>{view.text}</span>
    </Banner>
  )

  const adsError = sectionError('ads', choices?.ads.error ?? null)
  const merchantError = sectionError('merchant_center', choices?.merchantCenter.error ?? null)
  const analyticsError = sectionError('analytics', choices?.analytics.error ?? null)

  return <Modal open onClose={close} size="md" readable busy={loading}
    title="Choose Google accounts"
    subtitle="Nexus reads the Google Ads account you choose once a day. It changes nothing in Google."
    footer={<>
      <Button onClick={close} disabled={busy}>Cancel</Button>
      <Button variant="primary" type="submit" form={formId} aria-busy={busy || undefined}
        heldReason={busy ? null : loading && !choices ? 'Nexus is still asking Google which accounts this sign-in can see.' : saveHeldReason(draft, choices)}>
        {busy ? 'Saving…' : 'Save and start reading'}
      </Button>
    </>}>
    <form id={formId} className="nds-account-profile-form" onSubmit={submit} aria-busy={busy}>
      {loading && !choices && <p role="status">Asking Google which accounts this sign-in can see…</p>}
      {loadError && <Banner tone="danger" title="Google's account lists could not be read"
        action={<Button onClick={() => { void load() }} disabled={loading}>Try again</Button>}>{loadError}</Banner>}
      {saveError && !saveError.inAds && <Banner tone="danger" title={saveError.title}>{saveError.text}</Banner>}

      {choices && draft && <>
        {sectionBanner('ads', adsError)}
        {saveError?.inAds && <Banner tone="danger" title={saveError.title}>{saveError.text}</Banner>}
        <Field label="Google Ads account" required
          hint="The account whose campaigns and daily numbers Nexus reads. Manager accounts hold no campaigns, so they are not listed.">
          <Listbox value={draft.ads || undefined} options={adsOptions} width="100%" disabled={busy}
            placeholder={adsOptions.length ? 'Choose a Google Ads account' : 'No Google Ads account to choose'}
            searchPlaceholder="Search by name or customer id"
            onChange={(value) => { setSaveError(null); setDraft((d) => (d ? chooseAds(d, value, choices) : d)) }} />
        </Field>

        {managers && <Field label="Manager account"
          hint={chosenCustomer?.direct
            ? 'This sign-in reaches the account directly and through a manager. Choose how Nexus reaches it.'
            : 'This sign-in reaches the account only through a manager account.'}>
          <Listbox value={draft.manager} options={managers} width="100%" disabled={busy}
            onChange={(value) => setDraft((d) => (d ? { ...d, manager: value } : d))} />
        </Field>}

        {sectionBanner('merchant_center', merchantError)}
        <Field label="Merchant Center account (optional)" hint={LATER_HINT}>
          <Listbox value={draft.merchantCenter} options={merchants} width="100%" disabled={busy}
            onChange={(value) => setDraft((d) => (d ? { ...d, merchantCenter: value } : d))} />
        </Field>

        {sectionBanner('analytics', analyticsError)}
        <Field label="Google Analytics property (optional)" hint={LATER_HINT}>
          <Listbox value={draft.analytics} options={properties} width="100%" disabled={busy}
            onChange={(value) => setDraft((d) => (d ? { ...d, analytics: value } : d))} />
        </Field>
      </>}
    </form>
  </Modal>
}
