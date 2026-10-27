'use client'

/**
 * Reviews › Settings › Reply templates — the New / Edit template window (DS Modal): a name, a channel (or every
 * channel) and one text per language, each with the Textarea counter (eBay counts against its 500 characters). Save is
 * held with the first reason that applies (templateForm.ts); a refusal from the API shows in the window in its words.
 * Saves: `POST /api/reviews/reply-templates` or `PATCH …/:id`.
 */
import { useEffect, useMemo, useState } from 'react'
import { Banner, Field, Listbox, Modal } from '@/design-system/components'
import { Button, Input, SegmentedControl, Textarea } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { reviewsSend } from '../../_lib/reviewsFetch'
import type { ReplyTemplateRow } from './settingsModel'
import {
  TEMPLATE_CHANNEL_OPTIONS, TEMPLATE_LOCALES, draftFromTemplate, emptyTemplateDraft, templateChanged, templateHeldReason, templateLimit,
  templatePayload, type TemplateChannel, type TemplateDraft, type TemplateLocale,
} from './templateForm'
import s from './settings.module.css'

export interface TemplateModalProps {
  open: boolean
  /** The template being edited; null = a new one. */
  template: ReplyTemplateRow | null
  /** Every template's name (the edited one's own is left out here). */
  names: readonly string[]
  /** Why saving is held for this person (no "Manage reviews"); null = allowed. */
  manageHeld: string | null
  onClose: () => void
  onSaved: (row: ReplyTemplateRow, created: boolean) => void
}

const CHANNEL_OPTIONS = TEMPLATE_CHANNEL_OPTIONS.map((o) => ({ value: o.value || 'ALL', label: o.label }))

export function TemplateModal({ open, template, names, manageHeld, onClose, onSaved }: TemplateModalProps) {
  const start = useMemo(() => (template ? draftFromTemplate(template) : emptyTemplateDraft()), [template])
  const [draft, setDraft] = useState<TemplateDraft>(start)
  const [locale, setLocale] = useState<TemplateLocale>('it')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(start)
    setError(null)
    // Open on the first language the template has, else Italian.
    setLocale(TEMPLATE_LOCALES.find((l) => start.bodies[l.value].trim())?.value ?? 'it')
  }, [open, start])

  const otherNames = useMemo(() => names.filter((n) => n !== template?.name), [names, template])
  const held = manageHeld ?? (busy ? 'Saving…' : templateHeldReason(draft, otherNames) ?? (template && !templateChanged(start, draft) ? 'Nothing has changed yet.' : null))
  const limit = templateLimit(draft.channel)
  const localeOptions = useMemo(
    () => TEMPLATE_LOCALES.map((l) => ({ value: l.value, label: draft.bodies[l.value].trim() ? `${l.short} ✓` : l.short })),
    [draft.bodies],
  )
  const current = TEMPLATE_LOCALES.find((l) => l.value === locale)!

  const save = async () => {
    setBusy(true)
    setError(null)
    const body = templatePayload(draft)
    const res = template
      ? await reviewsSend<ReplyTemplateRow>('PATCH', `/reviews/reply-templates/${encodeURIComponent(template.id)}`, body)
      : await reviewsSend<ReplyTemplateRow>('POST', '/reviews/reply-templates', body)
    setBusy(false)
    if (res.error || !res.data) {
      setError(res.error ?? 'Nexus could not save the template. Try again in a moment.')
      return
    }
    // Other tabs' reply boxes and Settings read the templates again (audit A8).
    emitInvalidation({ type: 'review.settings.changed' })
    onSaved(res.data, !template)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={template ? `Edit “${template.name}”` : 'New reply template'}
      subtitle="The Inbox reply box offers it in the Templates menu, and AI drafts follow it. A person always sends."
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} heldReason={held}>{template ? 'Save template' : 'Create template'}</Button>
        </>
      )}
    >
      <div className={s.templateForm}>
        {error && <Banner tone="danger">{error}</Banner>}
        <div className={s.templateRow}>
          <Field label="Name" required>
            <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Size advice — runs small" />
          </Field>
          <Field label="Channel" hint={draft.channel === 'EBAY' ? 'eBay takes replies of up to 500 characters.' : 'Shown for reviews on this channel only.'}>
            <Listbox
              ariaLabel="Channel"
              options={CHANNEL_OPTIONS}
              value={draft.channel || 'ALL'}
              onChange={(v) => setDraft((d) => ({ ...d, channel: (v === 'ALL' ? '' : v) as TemplateChannel }))}
            />
          </Field>
        </div>
        <div className={s.languageText}>
          <SegmentedControl ariaLabel="Language of the text" size="sm" options={localeOptions} value={locale} onChange={(v) => setLocale(v as TemplateLocale)} wrap />
          <Field label={`${current.label} text`} hint="Leave a language empty to skip it. The reply box falls back to English, then to the first text the template has.">
            <Textarea
              rows={6}
              value={draft.bodies[locale]}
              limit={limit}
              onChange={(e) => setDraft((d) => ({ ...d, bodies: { ...d.bodies, [locale]: e.target.value } }))}
              placeholder={`The reply in ${current.label}`}
              lang={locale}
            />
          </Field>
        </div>
      </div>
    </Modal>
  )
}
