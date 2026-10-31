'use client'

import { useEffect } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Checkbox, Kbd, Spinner, Textarea } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { CheckList } from '../../_shared/parts'
import type { Hold, HoldDetail } from '../api'
import { firstOpenCheck, needsStatement, kindKey, nounKey, releaseProblems, type ReleaseDraft } from '../model'
import { checkLines } from './HoldDetailModal'

/**
 * Release hold (design quality.holds/pop:qh-release): what must be true, each check in our words with the API's sentence
 * under it (the GateExplainer), the four-eyes and maker lines in words, the signed statement "I made none of the held
 * garments" where the floor's records name stations only, a note; then the office's fresh code (an e-signature) and the
 * release. For several holds (Release N): one line per hold with its first open check; one release each (the API has no
 * bulk route), the code asked once. ⌘Enter releases when allowed.
 */
export function ReleaseHoldDialog({
  open,
  holds,
  draft,
  me,
  busy,
  problem,
  lines,
  onDraft,
  onRelease,
  onClose,
}: {
  open: boolean
  holds: readonly { hold: Hold; detail: HoldDetail | null }[]
  draft: ReleaseDraft
  me: string
  busy: boolean
  problem: string | null
  lines: readonly string[]
  onDraft: (draft: ReleaseDraft) => void
  onRelease: () => void
  onClose: () => void
}) {
  const t = useT('holds')
  const q = useT('quality')
  const details = holds.flatMap((entry) => (entry.detail ? [entry.detail] : []))
  const reading = holds.some((entry) => entry.detail === null)
  const blocked = holds.filter((entry) => entry.detail && (!entry.detail.release.mayRelease || firstOpenCheck(entry.detail) !== null))
  const problems = releaseProblems(draft, details)
  const held = busy
    ? q('common.working')
    : reading
      ? t('release.reading')
      : blocked.length > 0
        ? t('release.heldBlocked', { count: blocked.length })
        : problems.length > 0
          ? t(problems[0]!)
          : null
  const statement = details.some(needsStatement)
  const single = holds.length === 1 ? holds[0]! : null
  void me

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        onRelease()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!open) return null
  const label = single ? (single.hold.subjects.length === 1 ? `${t(kindKey(single.hold.subjectType))} ${single.hold.subjects[0]?.label ?? '—'}` : `${single.hold.subjects.length} ${t(nounKey(single.hold.subjectType), { count: single.hold.subjects.length })}`) : null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={single ? t('release.titleOne', { name: label ?? '' }) : t('release.titleMany', { count: holds.length })}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={onClose}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={onRelease}>
            <ShieldCheck size={14} aria-hidden /> {single ? t('release.goOne') : t('release.goMany', { count: holds.length })} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack">
        <p className="fw-q-hint">{t('release.intro')}</p>
        {problem && (
          <Banner tone="danger" title={t(problem)}>
            {lines.length > 0 && (
              <ul className="fw-q-lines">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        {single ? (
          single.detail ? (
            <CheckList checks={checkLines(single.detail, t)} label={t('decision.checks')} />
          ) : (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {t('release.reading')}
            </p>
          )
        ) : (
          <ul className="fw-q-lines" aria-label={t('release.listLabel')}>
            {holds.map((entry) => {
              const open = entry.detail ? firstOpenCheck(entry.detail) : null
              const may = entry.detail ? entry.detail.release.mayRelease : true
              return (
                <li key={entry.hold.id}>
                  <strong>
                    {t(kindKey(entry.hold.subjectType))} {entry.hold.subjects[0]?.label ?? '—'}
                  </strong>{' '}
                  — {entry.detail === null ? t('release.reading') : !may ? t('held.noReleaseHere') : open ? t(`held.check.${open}`) : t('release.ready')}
                </li>
              )
            })}
          </ul>
        )}
        {statement && (
          <Checkbox checked={draft.statement} onChange={(event) => onDraft({ ...draft, statement: event.target.checked })} label={t('release.statement')} />
        )}
        <Field label={t('release.note')} hint={t('release.noteHint')}>
          <Textarea rows={3} value={draft.note} onChange={(event) => onDraft({ ...draft, note: event.target.value })} />
        </Field>
        <p className="fw-q-hint">{t('release.signs')}</p>
      </div>
    </Modal>
  )
}
