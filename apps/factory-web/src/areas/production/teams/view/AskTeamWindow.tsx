'use client'

import type { ReactElement } from 'react'
import { Banner } from '@nexus/ui/components'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WindowShell } from '../../../../lib/window-shell/view/WindowShell'
import { ASK_WHY_MAX, askHeldOf, ORDER_TEAMS_NS } from '../model'
import '../teams.css'

/**
 * owb-ss7 (7.3; design § 5za "Sales: on an order's Production tab, the team, and Ask for another team"; R43: the one who plans the
 * floor gives the work, nobody gives it to sales) — sales asks the production manager for another team, with why. The answer is a task
 * to the production managers (POST …/team-asks). Draws one model; fetches nothing.
 */

export interface AskWindowModel {
  readonly open: boolean
  readonly why: string
  readonly busy: boolean
  /** The ask's failure (a key of `order-teams`). */
  readonly problem: string | null
}

export function AskTeamWindow({ model, onWhy, onAsk, onClose }: { model: AskWindowModel; onWhy: (text: string) => void; onAsk: () => void; onClose: () => void }): ReactElement {
  const t = useT(ORDER_TEAMS_NS)
  const held = askHeldOf(model.why)
  return (
    <WindowShell open={model.open} onClose={onClose} title={t('ask.title')} act={{ words: t('ask.act'), onAct: onAsk, held: held ? t(held.key, held.params) : null, busy: model.busy }}>
      {model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
      <p className="fw-tm-note">{t('ask.body')}</p>
      <label className="fw-tm-field">
        <span>{t('ask.why')}</span>
        <Textarea rows={3} honourRows value={model.why} limit={ASK_WHY_MAX} placeholder={t('ask.whyHint')} onChange={(event) => onWhy(event.target.value)} />
      </label>
    </WindowShell>
  )
}
