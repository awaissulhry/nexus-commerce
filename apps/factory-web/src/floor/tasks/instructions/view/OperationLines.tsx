'use client'

import { BookOpenCheck, Sparkles } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { useT } from '../../../../lib/i18n/provider'
import { TaskLine } from '../../shared/view/TaskParts'
import type { NewerSpec } from '../api'
import { NS, type InstructionFlag } from '../model'
import { NewerBanner } from './InstructionsView'

/**
 * The parts of Spec & instructions on the Operation screen's card (SCR-090's W2b markers, B-W2b-232): "New instruction" (design
 * floor.operation flags "New instruction (W2b, MES-110 opens it first)" — it opens before Start), the Spec changed banner (PRD-195,
 * "on this page and on the operation card") and the Instructions button (design h.more "Instructions (W2b)": a button on the bundle,
 * as Photo or comment, the frame has no menu slot). Data in, events out; their words are floor-instructions'.
 */
export function InstructionLines({ flag, newer }: { flag: InstructionFlag | null | undefined; newer: NewerSpec | null | undefined }) {
  const t = useT(NS)
  return (
    <>
      {flag?.due ? (
        <TaskLine tone="info" icon={<Sparkles />}>
          {t(`op.new.${flag.due}`, { n: flag.versionNumber })}
        </TaskLine>
      ) : null}
      <NewerBanner newer={newer} t={t} />
    </>
  )
}

export function InstructionsButton({ flag, onPress }: { flag: InstructionFlag | null | undefined; onPress: () => void }) {
  const t = useT(NS)
  return (
    <FloorButton size="lg" block variant="secondary" icon={<BookOpenCheck />} onClick={onPress}>
      {flag?.due ? t('op.instructionsNew') : t('op.instructions')}
    </FloorButton>
  )
}
