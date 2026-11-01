'use client'

import { CheckCircle2, ShieldCheck } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { checkKey } from '../model'
import { useWords } from '../shared/parts'
import { expectedPhrase, releasable, releaseHeldKey, whyNot, type ReleaseActions, type ReleaseDialogModel } from './model'

/**
 * Release N lots (design warehouse.lots lt-grid selection, page.h "Release…" selection-aware; the review of the DS
 * ReviewChangesModal composed: it speaks English): every lot chosen with its release check in our words — which go and
 * which cannot (released already, rejected, blocked: unblock it in Tests & substances, checks still open: named) —, the
 * decision note, the typed phrase (one lot: its code, the single release's legal weight; several: "RELEASE 3"), then each
 * lot's outcome. The release itself is Compliance's (quality.lots.release), sent lot by lot at the version read.
 */
export function ReleaseDialog({ model, actions }: { model: ReleaseDialogModel; actions?: ReleaseActions }) {
  const t = useWords()
  const going = model.lines.filter(releasable)
  const expected = expectedPhrase(model.lines, (count) => t('lt.rel.phraseWord', { count }))
  const heldKey = releaseHeldKey(model, expected)
  const close = () => actions?.onClose?.()
  const released = model.lines.filter((line) => line.result?.ok).length
  return (
    <Modal
      open
      onClose={close}
      size="lg"
      title={t('lt.rel.title', { count: model.lines.length })}
      subtitle={model.done ? undefined : t('lt.rel.subtitle', { going: going.length, count: model.lines.length })}
      footer={
        model.done ? (
          <Button size="sm" variant="primary" onClick={close}>
            {t('rec.close')}
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={close}>
              {t('stock:common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={heldKey ? t(heldKey, { phrase: expected }) : null} onClick={() => actions?.onRelease?.()}>
              {model.busy ? <Spinner size={12} /> : <ShieldCheck size={13} aria-hidden />} {t('lt.rel.go', { count: going.length })}
            </Button>
          </>
        )
      }
    >
      <div className="fw-wl-stack tight">
        {model.done && <Banner tone={released === going.length ? 'success' : released > 0 ? 'warning' : 'danger'} title={t('lt.rel.summary', { released, count: going.length })} />}
        <SummaryTable
          label={t('lt.rel.tableLabel')}
          columns={[t('lt.col.lot'), t('lt.rel.col.state'), t('lt.rel.col.why')]}
          widths={['24%', '20%', '56%']}
          align={[undefined, undefined, 'left']}
          stackOnPhone
          rows={model.lines.map((line) => {
            const why = whyNot(line)
            const open = line.check.state === 'ready' ? line.check.open : []
            return {
              id: line.id,
              cells: [
                <span key="c" className="fw-wl-code">
                  {line.code}
                </span>,
                line.result ? (
                  <Pill key="s" tone={line.result.ok ? 'success' : 'danger'}>
                    {line.result.ok ? t('lt.rel.released') : t('lt.rel.refused')}
                  </Pill>
                ) : line.check.state === 'loading' ? (
                  <Spinner key="s" size={12} />
                ) : (
                  <Pill key="s" tone={why ? 'neutral' : 'success'}>
                    {why ? t('lt.rel.cannot') : t('lt.rel.can')}
                  </Pill>
                ),
                <span key="w">
                  {line.result && !line.result.ok
                    ? t(line.result.key)
                    : line.result?.ok
                      ? t('lt.rel.nowUsable')
                      : why
                        ? // The open checks name what is missing only while the lot waits; a released, rejected or blocked lot's state says it all.
                          `${t(why.key, why.params)}${why.key === 'lt.rel.why.open' && open.length > 0 ? `: ${open.map((check) => t(checkKey(check, line.status))).join('; ')}` : ''}`
                        : t('lt.rel.ready')}
                </span>,
              ],
            }
          })}
        />
        {!model.done && going.length > 0 && (
          <>
            <p className="fw-wl-text">
              <CheckCircle2 size={14} aria-hidden /> {t('lt.rel.reach', { count: going.length })}
            </p>
            <p className="fw-wl-hint">{t('lt.rel.reversal')}</p>
            <Field label={t('lt.rel.note')} hint={t('lt.rel.noteHint')}>
              <Textarea value={model.note} onChange={(event) => actions?.onNote?.(event.target.value)} limit={500} rows={2} />
            </Field>
            <Field label={t('lt.rel.phrase', { phrase: expected })} required>
              <Input value={model.phrase} onChange={(event) => actions?.onPhrase?.(event.target.value)} autoComplete="off" spellCheck={false} aria-label={t('lt.rel.phrase', { phrase: expected })} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
