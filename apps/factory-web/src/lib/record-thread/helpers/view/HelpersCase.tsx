'use client'

import { useRef, useState } from 'react'
import { Lock, Send } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { DockedStage } from '../../parts/DockedStage'
import type { LocalDraft, MentionPerson, SavedRepliesModel } from '../model'
import { HELPERS_NS, MentionButton, MentionInput, type MentionInputHandle } from './MentionInput'
import { DraftLine, SavedReplies } from './SavedReplies'

/**
 * A design-review case of SCR-006-helpers: the helpers in a stand-in composer (the composer itself is TH-1b's) at the foot of the
 * docked thread (B-TH-300's follow-up: 519 px at 1440, 711 px at 1920 beside the record's body; the whole width below 1280 px) —
 * type "@" to see the suggestions, pick a saved reply to fill the box.
 */
export interface HelpersCaseModel {
  readonly mode: 'note' | 'reply'
  readonly text: string
  readonly people: readonly MentionPerson[]
  readonly replies: SavedRepliesModel
  /** What the API's fill gives back per reply (made up). */
  readonly filled: Readonly<Record<string, string>>
  readonly draft: LocalDraft | null
}

export function HelpersCase({ model }: { model: HelpersCaseModel }) {
  return (
    <WithMessages namespaces={[HELPERS_NS]}>
      <DockedStage foot>
        <Composer model={model} />
      </DockedStage>
    </WithMessages>
  )
}

function Composer({ model }: { model: HelpersCaseModel }) {
  const t = useT(HELPERS_NS)
  const [text, setText] = useState(model.text)
  const box = useRef<MentionInputHandle>(null)
  return (
    <div className={`fw-rtm-composer is-docked${model.mode === 'reply' ? ' is-reply' : ''}`}>
      <p className="fw-rtm-label">
        {model.mode === 'note' && <Lock size={12} aria-hidden />} {t(model.mode === 'note' ? 'design.noteMark' : 'design.replyMark')}
      </p>
      <MentionInput ref={box} value={text} onChange={setText} people={model.people} mode={model.mode} label={t(model.mode === 'note' ? 'design.noteLabel' : 'design.replyLabel')} rows={3} honourRows placeholder={t(model.mode === 'note' ? 'design.notePlaceholder' : 'design.replyPlaceholder')} />
      <div className="fw-rtm-foot">
        {model.mode === 'note' && <MentionButton onClick={() => box.current?.startMention()} />}
        <SavedReplies model={model.replies} onPick={(id) => setText(model.filled[id] ?? text)} />
        <DraftLine draft={model.draft} />
        <span className="fw-rtm-grow" />
        <Button size="sm" variant="primary">
          <Send size={14} aria-hidden /> {t(model.mode === 'note' ? 'design.addNote' : 'design.send')}
        </Button>
      </div>
    </div>
  )
}
