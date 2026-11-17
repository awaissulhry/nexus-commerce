'use client'

import { useState } from 'react'
import { ListChecks } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DockedStage } from '../../parts/DockedStage'
import type { CountPopoverModel, ViewerFile } from '../model'
import { CloseThreadConfirm, LeaveConfirm, SendCheckWindow, type SendCheckWindowModel } from './Confirms'
import { CountPopover } from './CountPopover'
import { FileViewer, POPUPS_NS } from './FileViewer'
import { OriginalEmail, type OriginalEmailModel } from './OriginalEmail'

/**
 * A design-review case of SCR-006-popups: one pop-up open over the docked thread it is opened from (B-TH-300's follow-up: the stand-in
 * record frame fills the width), reopened with "Open again" after it closes.
 */
export type PopupsCaseModel =
  | { readonly show: 'viewer'; readonly files: readonly ViewerFile[]; readonly index: number }
  | { readonly show: 'original'; readonly original: OriginalEmailModel }
  | { readonly show: 'send'; readonly send: SendCheckWindowModel }
  | { readonly show: 'leave'; readonly files: number }
  | { readonly show: 'close'; readonly record: string; readonly party: string | null; readonly problem: string | null }
  | { readonly show: 'count'; readonly count: CountPopoverModel }

export function PopupsCase({ model }: { model: PopupsCaseModel }) {
  return (
    <WithMessages namespaces={[POPUPS_NS]}>
      <Case model={model} />
    </WithMessages>
  )
}

function Case({ model }: { model: PopupsCaseModel }) {
  const t = useT(POPUPS_NS)
  const [open, setOpen] = useState(true)
  const [index, setIndex] = useState(model.show === 'viewer' ? model.index : 0)
  const [ticked, setTicked] = useState(model.show === 'send' ? (model.send.outside?.ticked ?? false) : false)
  const close = () => setOpen(false)
  return (
    <DockedStage>
      <div className="fw-rtp-stage">
        {model.show === 'count' ? (
          <CountPopover
            model={model.count}
            trigger={
              <span className="fw-rtp-countchip-in">
                <ListChecks size={14} aria-hidden /> {model.count.count}
              </span>
            }
            triggerLabel={t(`count.title.${model.count.kind}`, { count: model.count.count })}
          />
        ) : (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('design.openAgain')}
          </Button>
        )}
        {open && model.show === 'viewer' && <FileViewer files={model.files} index={index} onIndex={setIndex} onClose={close} onGoToMessage={() => undefined} />}
        {open && model.show === 'original' && <OriginalEmail model={model.original} onClose={close} />}
        {open && model.show === 'send' && (
          <SendCheckWindow model={{ ...model.send, outside: model.send.outside ? { ticked } : null }} onTickOutside={setTicked} onBack={close} onSend={close} />
        )}
        {open && model.show === 'leave' && <LeaveConfirm files={model.files} onStay={close} onDiscard={close} />}
        {open && model.show === 'close' && <CloseThreadConfirm record={model.record} party={model.party} problem={model.problem} onClose={close} onCancel={close} />}
      </div>
    </DockedStage>
  )
}
