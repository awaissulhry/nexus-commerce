'use client'

/**
 * Reviews › Insights › Fixes — "Edit the proposal" (the Fixes board): change an open fix's text before it is sent. Title
 * for every kind; Bullets: the bullet points (one per line, 10 at most, 500 characters each), their language and what
 * they mean in English; A+ content: the headline, the text (2,000 characters), the language and the English; Recall
 * check: how many days the hold lasts; Size guide: the sizing bullet point (in the language the product's text is kept
 * in) and what it means in English — Nexus keeps a person's words while the evidence names the same sizes. Saves only
 * what changed (`PATCH /api/reviews/action-items/:id`); nothing reaches a channel — the fix is still sent for approval
 * afterwards. Translations into the market's language are made when it is
 * sent, and show in the change plan.
 */
import { useId, useState } from 'react'
import { Banner, Field, Listbox, Modal, useToast } from '@/design-system/components'
import { Button, Input, NumberStepper, Textarea } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { EDIT_LANGUAGES, MANAGE_FIXES, fixEditBody, fixForm, languageWords, type FixForm, type FixItem } from './fixesModel'
import shared from '../_shared/insights.module.css'

const LANGUAGE_OPTIONS = EDIT_LANGUAGES.map((code) => ({ value: code, label: languageWords(code) }))

export function FixEditModal({ fix, canManage, onClose }: { fix: FixItem; canManage: boolean; onClose: () => void }) {
  const { toast } = useToast()
  const id = useId()
  const [form, setForm] = useState<FixForm>(() => fixForm(fix))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (next: Partial<FixForm>) => setForm((f) => ({ ...f, ...next }))
  const checked = fixEditBody(fix, form)
  const held = !canManage ? MANAGE_FIXES : saving ? 'Saving…' : checked.error ?? (checked.body ? null : 'Nothing changed yet.')

  const save = async () => {
    if (!checked.body) return
    setSaving(true)
    setError(null)
    const res = await reviewsSend<unknown>('PATCH', `/reviews/action-items/${encodeURIComponent(fix.id)}`, checked.body)
    setSaving(false)
    if (res.error) return setError(res.error)
    emitInvalidation({ type: 'review.fix.changed', id: fix.id })
    toast(`Proposal saved: “${form.title.trim()}”. Send it for approval when it reads right.`, 'success')
    onClose()
  }

  const english = ((fix.kind === 'BULLETS' || fix.kind === 'APLUS') && form.language !== 'en') || (fix.kind === 'SIZE_GUIDE' && fix.proposal.language !== 'en')
  return (
    <Modal
      open
      onClose={onClose}
      title="Edit the proposal"
      subtitle={`${fix.kindWords} · ${fix.product?.name ?? 'no product'}`}
      size="lg"
      busy={saving}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" heldReason={held} onClick={() => void save()}>{saving ? 'Saving…' : 'Save proposal'}</Button>
        </>
      )}
    >
      <div className={shared.cardBody}>
        {error && <Banner tone="danger" title="Not saved">{error}</Banner>}
        <Field label="Title" htmlFor={`${id}-title`} required>
          <Input id={`${id}-title`} value={form.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        {fix.kind === 'BULLETS' && (
          <Field label="Bullet points" htmlFor={`${id}-bullets`} hint="One per line, 10 at most, 500 characters each." required>
            <Textarea id={`${id}-bullets`} rows={6} value={form.bullets} onChange={(e) => set({ bullets: e.target.value })} />
          </Field>
        )}
        {fix.kind === 'APLUS' && (
          <>
            <Field label="Headline" htmlFor={`${id}-headline`} required>
              <Input id={`${id}-headline`} value={form.headline} maxLength={150} onChange={(e) => set({ headline: e.target.value })} />
            </Field>
            <Field label="Text" htmlFor={`${id}-body`} required>
              <Textarea id={`${id}-body`} rows={6} limit={2000} value={form.body} onChange={(e) => set({ body: e.target.value })} />
            </Field>
          </>
        )}
        {fix.kind === 'SIZE_GUIDE' && (
          <Field
            label={`Sizing bullet point (${languageWords(fix.proposal.language)})`}
            htmlFor={`${id}-line`}
            hint={`Added as the product’s last bullet point, in ${languageWords(fix.proposal.language)}: the language its text is kept in. 500 characters at most.`}
            required
          >
            <Textarea id={`${id}-line`} rows={3} limit={500} value={form.line} onChange={(e) => set({ line: e.target.value })} />
          </Field>
        )}
        {(fix.kind === 'BULLETS' || fix.kind === 'APLUS') && (
          <Field label="Language of the text" hint="When it differs from the market’s language, Nexus translates it when it is sent; the translation shows in the change plan.">
            <Listbox ariaLabel="Language of the text" options={LANGUAGE_OPTIONS} value={form.language} onChange={(v) => set({ language: v })} />
          </Field>
        )}
        {english && (
          <Field label="What it says in English" htmlFor={`${id}-english`} hint="The person who approves reads this." required>
            <Textarea id={`${id}-english`} rows={fix.kind === 'BULLETS' ? 5 : fix.kind === 'SIZE_GUIDE' ? 3 : 4} value={form.english} onChange={(e) => set({ english: e.target.value })} />
          </Field>
        )}
        {fix.kind === 'RECALL_FLAG' && (
          <Field label="Hold the units for" htmlFor={`${id}-days`} hint="In your own warehouses only — Amazon FBA stock is never held from here.">
            <NumberStepper id={`${id}-days`} value={form.days} min={1} max={90} suffix="days" onChange={(n) => set({ days: n })} />
          </Field>
        )}
        <p className={shared.muted}>Saving changes only this proposal in Nexus. Nothing reaches a channel until a person approves the change plan.</p>
      </div>
    </Modal>
  )
}
