'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { WindowShell } from '../../../../../../lib/window-shell/view/WindowShell'
import { KEEP_REASON_MAX, type Words } from '../model'
import '../cost.css'

/**
 * owb-pd5b step 5.3 (S4; design plan § 5zh "Keep", § 10 R59; S4 settle 9) — "The factory counts with € 190. The cost now is € 185.60."
 * → Keep € 185.60 as the standard cost, with a why. ONE command on the server: where the company lets one person keep a cost, it is
 * kept at once ("version n"); else it goes to Finance for approval (four eyes, the default). The window says which before the press.
 * A refusal is said in words (the same cost kept already, the cost moved meanwhile, parts missing). Centred, a sheet on a phone.
 */

export interface KeepWindowModel {
  /** "The factory counts with …" (the kept standard cost) or the rough standard of its kind. */
  readonly counts: Words
  readonly costNow: string
  readonly reason: string
  /** true: one person may keep a cost (the company's switch); false: Finance approves it. */
  readonly alone: boolean
  readonly held: Words | null
  readonly busy: boolean
  readonly problem: Words | null
}

export function KeepWindow({ model, onReason, onKeep, onClose }: { model: KeepWindowModel; onReason: (text: string) => void; onKeep: () => void; onClose: () => void }) {
  const t = useT('products-cost')
  const say = (words: Words) => t(words.key, words.params)
  return (
    <WindowShell open onClose={onClose} title={t('keep.title')} subtitle={say(model.counts)} act={{ words: t(model.alone ? 'keep.actAlone' : 'keep.actSend', { amount: model.costNow }), onAct: onKeep, held: model.held ? say(model.held) : null, busy: model.busy }}>
      <div className="fw-ct-body">
        <p className="fw-ct-top">{t('keep.body', { amount: model.costNow })}</p>
        <Field label={t('keep.reason')} required hint={t('keep.reasonHint')}>
          <Textarea value={model.reason} rows={2} maxLength={KEEP_REASON_MAX} placeholder={t('keep.reasonPlaceholder')} onChange={(event) => onReason(event.target.value)} />
        </Field>
        <p className="fw-ct-note">{t(model.alone ? 'keep.alone' : 'keep.fourEyes')}</p>
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
      </div>
    </WindowShell>
  )
}
