'use client'

/**
 * Reviews › Settings › Reply templates & brand voice — used by the reply box in the Inbox (its Templates menu) and by
 * the AI drafts. A person always sends.
 *
 * Templates (GET /api/reviews/reply-templates): name, channel, languages, how often a person picked one; New template /
 * Edit open TemplateModal, Delete asks first. They save at once. The brand voice — tone (Warm / Neutral / Formal), the
 * languages replies are written in, the sign-off and words to avoid — is part of the page's draft, saved with the
 * EditModeBar (⌘S).
 */
import { useCallback, useMemo, useState } from 'react'
import { Card, EmptyState, Field, Modal, useToast } from '@/design-system/components'
import { NexusGrid, numericColumn, type ColDef, type ICellRendererParams } from '@/design-system/grid'
import { Button, Checkbox, Input, SegmentedControl, Skeleton, TagInput } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { ReadFailed } from './ReadFailed'
import { LANGUAGE_OPTIONS, SIGN_OFF_MAX, TONE_HINT, TONE_OPTIONS, type ReplyLanguage, type Tone, type VoiceForm } from './settingsForm'
import { templateChannelWords, templateLanguagesWords, type ReplyTemplateRow } from './settingsModel'
import { TemplateModal } from './TemplateModal'
import type { SettingsRead } from './useSettingsRead'
import s from './settings.module.css'

interface Ctx {
  manageHeld: string | null
  onEdit: (row: ReplyTemplateRow) => void
  onDelete: (row: ReplyTemplateRow) => void
}

function NameCell({ data }: ICellRendererParams<ReplyTemplateRow>) {
  return data ? <span className={s.cellStrong}>{data.name}</span> : null
}

function ChannelCell({ data }: ICellRendererParams<ReplyTemplateRow>) {
  return data ? <span>{templateChannelWords(data.channel)}</span> : null
}

function LanguagesCell({ data }: ICellRendererParams<ReplyTemplateRow>) {
  return data ? <span className={s.cellSub}>{templateLanguagesWords(data.languages)}</span> : null
}

function ActionsCell({ data, context }: ICellRendererParams<ReplyTemplateRow, unknown, Ctx>) {
  if (!data) return null
  return (
    <span className={s.cellActions}>
      <Button size="sm" variant="quiet" onClick={() => context.onEdit(data)} aria-label={`Edit the template ${data.name}`}>Edit</Button>
      <Button size="sm" variant="quiet" heldReason={context.manageHeld} onClick={() => context.onDelete(data)} aria-label={`Delete the template ${data.name}`}>Delete</Button>
    </span>
  )
}

const COLUMNS: ColDef<ReplyTemplateRow>[] = [
  { colId: 'name', headerName: 'Template', flex: 2, minWidth: 220, cellRenderer: NameCell },
  { colId: 'channel', headerName: 'Channel', width: 140, minWidth: 120, cellRenderer: ChannelCell },
  { colId: 'languages', headerName: 'Languages', width: 180, minWidth: 150, cellRenderer: LanguagesCell },
  { colId: 'used', headerName: 'Used', field: 'usedCount', width: 90, minWidth: 80, ...numericColumn },
  { colId: 'actions', headerName: '', width: 160, minWidth: 150, cellRenderer: ActionsCell, sortable: false },
]

const getRowId = (p: { data: ReplyTemplateRow }) => p.data.id

export interface TemplatesSectionProps {
  templates: SettingsRead<{ items: ReplyTemplateRow[] }>
  /** The draft voice (null while Settings is read). */
  voice: VoiceForm | null
  voiceError: string | null
  onRetryVoice: () => void
  /** Why template changes are held for this person; null = allowed. */
  manageHeld: string | null
  onTone: (tone: Tone) => void
  onLanguage: (language: ReplyLanguage, on: boolean) => void
  onSignOff: (value: string) => void
  onAvoidWords: (words: string[]) => void
}

export function TemplatesSection({ templates, voice, voiceError, onRetryVoice, manageHeld, onTone, onLanguage, onSignOff, onAvoidWords }: TemplatesSectionProps) {
  const { toast } = useToast()
  const [editing, setEditing] = useState<{ row: ReplyTemplateRow | null } | null>(null)
  const [deleting, setDeleting] = useState<ReplyTemplateRow | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => templates.data?.items ?? [], [templates.data])
  const names = useMemo(() => rows.map((r) => r.name), [rows])

  const onEdit = useCallback((row: ReplyTemplateRow) => setEditing({ row }), [])
  const onDelete = useCallback((row: ReplyTemplateRow) => setDeleting(row), [])
  const context = useMemo<Ctx>(() => ({ manageHeld, onEdit, onDelete }), [manageHeld, onEdit, onDelete])
  const columnDefs = useMemo(() => COLUMNS, [])

  const saved = useCallback(async (row: ReplyTemplateRow, created: boolean) => {
    setEditing(null)
    await templates.reload()
    toast(created ? `Template “${row.name}” created.` : `Template “${row.name}” saved.`, 'success')
  }, [templates, toast])

  const remove = useCallback(async () => {
    if (!deleting) return
    setBusy(true)
    const res = await reviewsSend<{ name: string }>('DELETE', `/reviews/reply-templates/${encodeURIComponent(deleting.id)}`)
    setBusy(false)
    if (res.error) {
      toast(res.error, 'danger')
      return
    }
    setDeleting(null)
    await templates.reload()
    emitInvalidation({ type: 'review.settings.changed' })
    toast(`Template “${res.data?.name ?? deleting.name}” deleted.`, 'success')
  }, [deleting, templates, toast])

  return (
    <div className={s.section}>
      <p className={s.lead}>Used by the reply box in the Inbox and by AI drafts. A person always sends: Nexus never posts a reply on its own.</p>

      <Card
        header="Reply templates"
        headingLevel={3}
        headerAction={<Button size="sm" variant="primary" heldReason={manageHeld} onClick={() => setEditing({ row: null })}>New template</Button>}
        padded={false}
      >
        {templates.error && !templates.data ? (
          <div className={s.pad}><ReadFailed error={templates.error} onRetry={() => void templates.reload()} busy={templates.loading} /></div>
        ) : !templates.data ? (
          <div className={s.skeletonRows} aria-hidden>{[0, 1, 2].map((i) => <Skeleton key={i} height={36} />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No templates yet" description="Save the replies your team writes often — size advice, a late delivery, how to return. The Inbox offers them in its Templates menu." />
        ) : (
          <div className={s.tableScroll}>
            {/* Keyed by the permission: the cells read it from the grid's context, which AG does not re-render on. */}
            <NexusGrid<ReplyTemplateRow> key={manageHeld ? 'held' : 'free'} plain density="compact" rowData={rows} columnDefs={columnDefs} getRowId={getRowId} context={context} />
          </div>
        )}
      </Card>

      <Card header="Brand voice" headingLevel={3} description="How every reply sounds. Saved with the page’s Save changes.">
        {voiceError && !voice ? (
          <ReadFailed error={voiceError} onRetry={onRetryVoice} />
        ) : !voice ? (
          <Skeleton height={140} />
        ) : (
          <div className={s.voice}>
            <Field label="Tone" hint={TONE_HINT[voice.tone]}>
              <SegmentedControl ariaLabel="Tone" options={[...TONE_OPTIONS]} value={voice.tone} onChange={(v) => onTone(v as Tone)} />
            </Field>
            <Field label="Reply in" hint="With “Buyer’s language” ticked, Nexus replies in the buyer’s language; otherwise in the first language ticked that the buyer reads, else the first one ticked.">
              <div className={s.choices} role="group" aria-label="Reply in">
                {LANGUAGE_OPTIONS.map((o) => (
                  <Checkbox key={o.value} label={o.label} checked={voice.languages.includes(o.value)} onChange={(e) => onLanguage(o.value, e.target.checked)} />
                ))}
              </div>
            </Field>
            <Field label="Sign off as" hint={`Ends every reply, when the channel’s limit leaves room. ${voice.signOff.trim().length}/${SIGN_OFF_MAX} characters.`}>
              <Input value={voice.signOff} onChange={(e) => onSignOff(e.target.value)} placeholder="The care team" />
            </Field>
            <Field label="Words to avoid" hint="Press Enter after each word. AI drafts never use them.">
              <TagInput value={voice.avoidWords} onChange={onAvoidWords} placeholder="Add a word" aria-label="Words to avoid" />
            </Field>
          </div>
        )}
      </Card>

      <TemplateModal
        open={editing != null}
        template={editing?.row ?? null}
        names={names}
        manageHeld={manageHeld}
        onClose={() => setEditing(null)}
        onSaved={(row, created) => void saved(row, created)}
      />

      <Modal
        open={deleting != null}
        onClose={() => setDeleting(null)}
        size="sm"
        title={`Delete “${deleting?.name ?? ''}”?`}
        footer={(
          <>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => void remove()} heldReason={busy ? 'Deleting…' : null}>Delete template</Button>
          </>
        )}
      >
        <p className={s.hint}>The Inbox no longer offers it. Replies already sent with it stay as they are.</p>
      </Modal>
    </div>
  )
}
