'use client'

import { useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { Braces } from 'lucide-react'
import { Field, Menu } from '@nexus/ui/components'
import { Builder, DetailHeader, type BuilderSection } from '@nexus/ui/patterns'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { insertAt, placeholderToken, type Said } from '../model'
import '../templates.css'
import { useTplWords } from './words'

/**
 * TemplateEditor — the one-area builder of Admin › Documents (B-W2b-432; design admin.documents pop:template-editor, a
 * "TemplateEditor (new)" that is NOT a DS part): the record's band (‹ back, "Template: Quote (Italiano)", its version and
 * company, its status, at most two actions), then the DS Builder in page mode — the sections on the left (a sticky strip
 * marks the one on screen), the live column on the right from 1200 px (the PDF or the mail as it goes out), and the
 * EditModeBar at the end (⌘S saves the draft). The document and the e-mail editors both draw through it.
 */
export function TemplateEditor({
  back,
  title,
  meta,
  status,
  actions,
  notices,
  sections,
  aside,
  asideLabel,
  footer,
}: {
  back: { href: string; label: string }
  title: ReactNode
  meta?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  /** Above the sections: a receipt, a refusal, "changed by someone else". */
  notices?: ReactNode
  sections: BuilderSection[]
  aside: ReactNode
  asideLabel: string
  footer?: ReactNode
}) {
  const t = useTplWords()
  return (
    <div className="fw-adm fw-tpl-editor">
      <div className="fw-adm-band">
        <DetailHeader backAsChild backLabel={<Link href={back.href}>{back.label}</Link>} title={title} meta={meta} status={status} actions={actions} />
      </div>
      {notices}
      <Builder mode="page" sections={sections} aside={aside} asideLabel={asideLabel} footer={footer} navLabel={t('tpl.editor.sections')} />
    </div>
  )
}

/**
 * One text of a template (a header, the terms, a subject, a body): the DS Textarea with its counter, the problems under it
 * in words, and "Insert placeholder ▾" (the template's own names, put at the caret). Read-only once published.
 */
export function TemplateText({
  label,
  hint,
  value,
  limit,
  rows = 6,
  placeholders,
  problems,
  readOnly,
  onChange,
}: {
  label: string
  hint?: string
  value: string
  limit: number
  rows?: number
  placeholders: readonly string[]
  problems?: readonly Said[]
  readOnly: boolean
  onChange?: (value: string) => void
}) {
  const t = useTplWords()
  const area = useRef<HTMLTextAreaElement | null>(null)
  const insert = (name: string) => {
    const element = area.current
    const at = element ? { start: element.selectionStart, end: element.selectionEnd } : null
    const next = insertAt(value, placeholderToken(name), at)
    onChange?.(next.text)
    requestAnimationFrame(() => {
      if (!area.current) return
      area.current.focus()
      area.current.setSelectionRange(next.caret, next.caret)
    })
  }
  const error = problems && problems.length > 0 ? problems.map((problem) => t(problem.key, problem.params)).join(' · ') : undefined
  return (
    <div className="fw-tpl-text">
      <Field label={label} hint={hint} error={error}>
        <Textarea ref={area} value={value} rows={rows} honourRows limit={limit} readOnly={readOnly} onChange={(event) => onChange?.(event.target.value)} />
      </Field>
      {!readOnly && placeholders.length > 0 && (
        <div className="fw-tpl-insert">
          <Menu
            label={
              <>
                <Braces size={13} aria-hidden /> {t('tpl.editor.insert')}
              </>
            }
            triggerProps={{ 'aria-label': t('tpl.editor.insertInto', { field: label }) }}
            items={placeholders.map((name) => ({ id: name, label: <code className="fw-adm-code">{placeholderToken(name)}</code>, onSelect: () => insert(name) }))}
          />
        </div>
      )}
    </div>
  )
}
