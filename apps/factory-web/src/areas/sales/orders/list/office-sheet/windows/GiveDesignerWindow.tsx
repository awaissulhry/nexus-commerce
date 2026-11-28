'use client'

import { useEffect, useState } from 'react'
import { Button } from '@nexus/ui/primitives'
import { Banner, Modal } from '@nexus/ui/components'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { useT } from '../../../../../../lib/i18n/provider'
import { listAssignees } from '../../../../../../record-panels/tasks/api'
import type { Assignable } from '../../../../../../record-panels/tasks/model'
import { PeoplePicture } from '../../../../../../lib/people-picture/view/PeoplePicture'
import { DESIGNER_ORDERS_MAX, giveToDesigner, type SheetRowRead } from '../api'
import { NS } from '../map'
import { refusalWordsOf } from '../use-office-sheet'

/**
 * owb-of4 extra step — "Give to the designer" over the selected orders: pick ONE office person (today's people a task may be given
 * to, `GET /tasks/assignees`), then `POST /sales/orders/designer` puts that person on each order (the server's people writer). What
 * was skipped (not confirmed yet, with the designer already) is said with its count; at most 100 orders at once.
 */
export function GiveDesignerWindow({ rows, skipped, onClose, onDone }: { rows: readonly SheetRowRead[]; skipped: number; onClose: () => void; onDone: (words: string | null) => void }) {
  const api = useOfficeApi()
  const t = useT(NS)
  const [people, setPeople] = useState<readonly Assignable[] | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const tooMany = rows.length > DESIGNER_ORDERS_MAX

  useEffect(() => {
    const control = new AbortController()
    listAssignees(api, null, control.signal)
      .then((found) => !control.signal.aborted && setPeople(found))
      .catch((error: unknown) => {
        if (!control.signal.aborted) {
          setPeople([])
          setProblem(refusalWordsOf(error, t))
        }
      })
    return () => control.abort()
  }, [api, t])

  const give = async () => {
    if (!picked || tooMany || rows.length === 0) return
    setBusy(true)
    setProblem(null)
    try {
      const answer = await giveToDesigner(api, { orderIds: rows.map((row) => row.id), userId: picked })
      const name = people?.find((person) => person.id === picked)?.name ?? ''
      const words = [t('office.designer.done', { count: answer.added, name }), ...(skipped > 0 ? [t('office.designer.skipped', { count: skipped })] : [])].join(' · ')
      onDone(words)
    } catch (error) {
      setProblem(refusalWordsOf(error, t))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('office.designer.title', { count: rows.length })}
      subtitle={skipped > 0 ? t('office.designer.skippedBefore', { count: skipped }) : t('office.designer.subtitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('office.cancel')}</Button>
          <Button variant="primary" disabled={!picked || busy || tooMany || rows.length === 0} onClick={() => void give()}>
            {t('office.designer.go', { count: rows.length })}
          </Button>
        </>
      }
    >
      {problem && <Banner tone="danger" title={problem} />}
      {tooMany && <Banner tone="warning" title={t('office.designer.tooMany', { max: DESIGNER_ORDERS_MAX })} />}
      {rows.length === 0 && <Banner tone="warning" title={t('office.designer.none')} />}
      {people === null ? (
        <p className="fw-osp-muted">{t('office.reading')}</p>
      ) : (
        <ul className="fw-osp-pick" role="radiogroup" aria-label={t('office.designer.who')}>
          {people.map((person) => (
            <li key={person.id}>
              <button type="button" role="radio" aria-checked={picked === person.id} className={picked === person.id ? 'fw-osp-pick-row is-picked' : 'fw-osp-pick-row'} onClick={() => setPicked(person.id)}>
                <span className="fw-osp-pick-who">
                  <PeoplePicture source={{ name: person.name }} size="sm" nameBeside />
                  <span className="fw-osp-strong">{person.name}</span>
                </span>
                {person.me && <span className="fw-osp-muted">{t('office.designer.me')}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
