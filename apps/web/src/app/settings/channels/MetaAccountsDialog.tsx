'use client'

/**
 * Meta ads step 1 — "Choose Meta assets": the ad account this business reads (required), and its Facebook Page and
 * Instagram account (optional, chosen now and read in a later step).
 *
 * Centred DS `Modal`; every control is a DS `Field` + `Listbox`. Each list is read on its own (GET …/choices), so one
 * failing shows its own banner and leaves the others usable. An asset another business in Nexus already picked is a
 * held option (its id and "Used by another business", never a name), never chosen for the person. Saving (PUT …/selection) is checked
 * by the server against what Meta offers and queues the first read; a refusal (409) is said in words and never names
 * another business. The words and every decision are in `./meta-selection.ts`.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Banner, Field, Listbox, Modal } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { fetchMetaChoices, saveMetaSelection, type MetaChoices, type MetaConnection } from '@/lib/meta-ads/contract'
import {
  adAccountOptions, canSaveMeta, initialMetaDraft, instagramOptions, metaConflictText, metaSaveHeldReason, metaSelectionBody, pageOptions,
  reconcileMetaDraft, type MetaDraft,
} from './meta-selection'

const LATER_HINT = 'Nexus reads nothing from it yet; it is used in a later step.'

export function MetaAccountsDialog({ connectionId, current, onClose, onSaved }: {
  connectionId: string
  /** The saved choice, if any — the dialog opens on it. */
  current?: MetaConnection | null
  onClose: () => void
  onSaved: (connection: MetaConnection) => void
}) {
  const formId = useId()
  const [choices, setChoices] = useState<MetaChoices | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState<MetaDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState<{ title: string; text: string } | null>(null)
  const inFlight = useRef(false)
  const request = useRef(0)
  // The saved choice the dialog opens on, read once: a parent re-render must not read Meta's lists again.
  const opening = useRef(current)

  const load = useCallback(async (refresh: boolean) => {
    const sequence = ++request.current
    setLoading(true)
    setLoadError(null)
    try {
      const next = await fetchMetaChoices(connectionId, refresh)
      if (request.current !== sequence) return
      setChoices(next)
      setDraft((prev) => (prev ? reconcileMetaDraft(prev, next) : initialMetaDraft(opening.current, next)))
    } catch (err) {
      if (request.current === sequence) setLoadError(err instanceof Error ? err.message : 'Meta did not answer. Try again.')
    } finally {
      if (request.current === sequence) setLoading(false)
    }
  }, [connectionId])

  useEffect(() => {
    void load(false)
    return () => { request.current++ }
  }, [load])

  const adAccounts = useMemo(() => adAccountOptions(choices), [choices])
  const pages = useMemo(() => pageOptions(choices), [choices])
  const instagram = useMemo(() => instagramOptions(choices), [choices])
  const ready = !!draft && canSaveMeta(draft, choices)
  const close = () => { if (!busy) onClose() }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current || !draft || !ready) return
    inFlight.current = true
    setBusy(true)
    setSaveError(null)
    try {
      const result = await saveMetaSelection(connectionId, metaSelectionBody(draft))
      if (result.ok) { onSaved(result.connection); return }
      setSaveError(metaConflictText(result.code, result.error, result.product))
      // Meta no longer offers a pick, or another business picked it meanwhile: ask Meta again, so the dialog shows what
      // may be chosen now.
      if (result.code === 'not_offered' || result.code === 'taken_by_other_business') void load(true)
    } catch (err) {
      setSaveError({ title: 'The choice was not saved', text: err instanceof Error ? err.message : 'Nexus could not reach the server. Try again.' })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  const sectionBanner = (title: string, error: string | null | undefined) => error && (
    <Banner tone="warning" title={title}
      action={<Button onClick={() => { void load(true) }} disabled={busy || loading}>Try again</Button>}>
      {error}
    </Banner>
  )

  return <Modal open onClose={close} size="md" readable busy={loading}
    title="Choose Meta assets"
    subtitle="Nexus reads the ad account you choose once a day. It changes nothing in Meta."
    footer={<>
      <Button onClick={() => { void load(true) }} disabled={busy || loading}>Read the lists again</Button>
      <Button onClick={close} disabled={busy}>Cancel</Button>
      <Button variant="primary" type="submit" form={formId} aria-busy={busy || undefined}
        heldReason={busy ? null : loading && !choices ? 'Nexus is still asking Meta which assets this system user can see.' : metaSaveHeldReason(draft, choices)}>
        {busy ? 'Saving…' : 'Save and start reading'}
      </Button>
    </>}>
    <form id={formId} className="nds-account-profile-form" onSubmit={submit} aria-busy={busy}>
      {loading && !choices && <p role="status">Asking Meta which assets this system user can see…</p>}
      {loadError && <Banner tone="danger" title="Meta's lists could not be read"
        action={<Button onClick={() => { void load(true) }} disabled={loading}>Try again</Button>}>{loadError}</Banner>}
      {saveError && <Banner tone="danger" title={saveError.title}>{saveError.text}</Banner>}

      {choices && draft && <>
        {sectionBanner('The ad accounts could not be read', choices.adAccounts.error)}
        <Field label="Ad account" required
          hint="The ad account whose campaigns and daily numbers Nexus reads. Only ad accounts assigned to this system user are listed.">
          <Listbox value={draft.adAccount || undefined} options={adAccounts} width="100%" disabled={busy}
            placeholder={adAccounts.length ? 'Choose an ad account' : 'No ad account to choose'}
            searchPlaceholder="Search by name or account id"
            onChange={(value) => { setSaveError(null); setDraft((d) => (d ? { ...d, adAccount: value } : d)) }} />
        </Field>

        {sectionBanner('The Facebook Pages could not be read', choices.pages.error)}
        <Field label="Facebook Page (optional)" hint={LATER_HINT}>
          <Listbox value={draft.page} options={pages} width="100%" disabled={busy}
            onChange={(value) => { setSaveError(null); setDraft((d) => (d ? { ...d, page: value } : d)) }} />
        </Field>

        {sectionBanner('The Instagram accounts could not be read', choices.instagram.error)}
        <Field label="Instagram account (optional)" hint={LATER_HINT}>
          <Listbox value={draft.instagram} options={instagram} width="100%" disabled={busy}
            onChange={(value) => { setSaveError(null); setDraft((d) => (d ? { ...d, instagram: value } : d)) }} />
        </Field>
      </>}
    </form>
  </Modal>
}
