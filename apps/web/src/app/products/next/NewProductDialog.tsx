'use client'

/**
 * "New product" on the Products page (2026-10-01): type the SKU and the name, choose a single product or a product
 * with variations and, if wanted, a product family. Create makes a DRAFT in this business (`POST /api/products`) and
 * opens it in the studio. Nothing is sent to a channel.
 *
 * Every way in opens this one dialog: the page's New product button, and `/products?new=1` (the command palette's
 * "Create new product" / `g n`, Organize's quick action, and the retired `/products/new` and `/catalog/add`).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { NewProductField, NewProductKind } from '@nexus/shared/product-create'
import { Banner, Field, Listbox, Modal } from '@/design-system/components'
import { Button, Input, SegmentedControl } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useRouter } from '@/lib/workspaces/navigation'
import { createOutcome, draftProblems, EMPTY_NEW_PRODUCT, familyOptions, firstProblemField, newProductBody, productStudioPath, type CreateOutcome, type NewProductDraft } from './newProduct'
import styles from './newProduct.module.css'

const KIND_HINT: Record<NewProductKind, string> = {
  single: 'One SKU, sold as it is.',
  parent: 'A parent SKU for variations such as sizes or colours. You add the variations in the studio.',
}

type FieldErrors = Partial<Record<NewProductField, string>>
type Families = { options: ReturnType<typeof familyOptions>; state: 'loading' | 'ready' | 'failed' }

export function NewProductDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const formId = useId()
  const [draft, setDraft] = useState<NewProductDraft>(EMPTY_NEW_PRODUCT)
  const [errors, setErrors] = useState<FieldErrors>({})
  /** The live product that already has the typed SKU, so the person can open it instead. */
  const [existingId, setExistingId] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [families, setFamilies] = useState<Families>({ options: [], state: 'loading' })
  /** The field to focus once the fields are enabled again (a disabled input cannot take the focus). */
  const [focusTarget, setFocusTarget] = useState<NewProductField | null>(null)
  const inFlight = useRef(false)
  const skuRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Each opening starts empty, and reads this business's families again.
  useEffect(() => {
    if (!open) return
    setDraft(EMPTY_NEW_PRODUCT); setErrors({}); setExistingId(null); setFailure(null); setBusy(false); inFlight.current = false
    setFamilies({ options: [], state: 'loading' })
    const controller = new AbortController()
    fetch(`${getBackendUrl()}/api/families`, { cache: 'no-store', signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body) => setFamilies({ options: familyOptions(body), state: 'ready' }))
      .catch(() => { if (!controller.signal.aborted) setFamilies({ options: [], state: 'failed' }) })
    return () => controller.abort()
  }, [open])

  // The type and family controls are never wrong by typing; only the two text fields take the focus back.
  useEffect(() => {
    if (busy || !focusTarget) return
    if (focusTarget === 'sku') skuRef.current?.focus()
    else if (focusTarget === 'name') nameRef.current?.focus()
    setFocusTarget(null)
  }, [busy, focusTarget])

  const update = (patch: Partial<NewProductDraft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    // A field's error goes once its value changes; the server checks it again on Create.
    setErrors((current) => {
      const next = { ...current }
      for (const key of Object.keys(patch) as NewProductField[]) delete next[key]
      return next
    })
    if ('sku' in patch) setExistingId(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (inFlight.current) return
    const problems = draftProblems(draft)
    const first = firstProblemField(problems)
    if (first) { setErrors(problems); setFailure(null); setFocusTarget(first); return }
    inFlight.current = true; setBusy(true); setFailure(null); setErrors({}); setExistingId(null)
    let outcome: CreateOutcome
    try {
      const res = await fetch(`${getBackendUrl()}/api/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProductBody(draft)),
      })
      outcome = createOutcome(res.status, await res.json().catch(() => null))
    } catch {
      outcome = { kind: 'failed', message: 'Nexus could not be reached. Check your connection and try again.' }
    }
    if (outcome.kind === 'created') {
      // Other open Products tabs show the new draft; this tab goes to the studio and stays busy until it opens.
      emitInvalidation({ type: 'product.created', id: outcome.id, meta: { productIds: [outcome.id], source: 'new-product' } })
      router.push(productStudioPath(outcome.id))
      return
    }
    if (outcome.kind === 'field') {
      setErrors({ [outcome.field]: outcome.message })
      setExistingId(outcome.productId ?? null)
      setFocusTarget(outcome.field)
    } else {
      setFailure(outcome.message)
    }
    inFlight.current = false; setBusy(false)
  }

  const familyHint = families.state === 'failed'
    ? 'The product families could not be loaded. You can choose one later in the studio.'
    : families.state === 'ready' && families.options.length === 0
      ? 'This business has no product families yet. You can add one later.'
      : 'Optional. A family sets which attributes the product has. You can choose one later.'

  return (
    <Modal
      open={open}
      onClose={() => { if (!busy) onClose() }}
      size="md"
      title="New product"
      subtitle="It starts as a draft. Nothing is sent to a channel until you publish it."
      footer={<>
        <Button disabled={busy} onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} disabled={busy}>{busy ? 'Creating…' : 'Create product'}</Button>
      </>}
    >
      <form id={formId} className={styles.form} onSubmit={submit} noValidate aria-busy={busy}>
        {failure && <Banner tone="danger" title="The product was not created">{failure}</Banner>}
        <Field
          label="SKU"
          required
          hint="Unique in this business. Letters, numbers, dots, hyphens and underscores, up to 100 characters."
          error={errors.sku && (
            <>
              {errors.sku}
              {existingId && <>{' '}<Button variant="link" inline onClick={() => router.push(productStudioPath(existingId))}>Open it</Button></>}
            </>
          )}
        >
          <Input ref={skuRef} data-autofocus value={draft.sku} onChange={(e) => update({ sku: e.target.value })} disabled={busy}
            autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        </Field>
        <Field label="Name" required error={errors.name}>
          <Input ref={nameRef} value={draft.name} onChange={(e) => update({ name: e.target.value })} disabled={busy} autoComplete="off" />
        </Field>
        <Field label="Type" hint={KIND_HINT[draft.kind]} error={errors.kind}>
          <SegmentedControl ariaLabel="Type" wrap disabled={busy} value={draft.kind} onChange={(value) => update({ kind: value as NewProductKind })} options={[
            { value: 'single', label: 'Single product' },
            { value: 'parent', label: 'Product with variations' },
          ]} />
        </Field>
        <Field label="Product family" hint={familyHint} error={errors.familyId}>
          <Listbox value={draft.familyId} onChange={(familyId) => update({ familyId })} width="100%"
            searchPlaceholder="Search families" emptyLabel={families.state === 'loading' ? 'Loading families…' : 'No family'}
            disabled={busy || families.state !== 'ready' || families.options.length === 0} options={families.options} />
        </Field>
      </form>
    </Modal>
  )
}
