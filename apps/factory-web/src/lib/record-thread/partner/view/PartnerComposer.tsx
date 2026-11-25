'use client'

import { useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react'
import { AtSign, Check, Lock, Paperclip, Plus, X } from 'lucide-react'
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { Textarea, Tooltip } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../i18n/provider'
import { ComposerHeld, ComposerRow, composerKeys, LinkBar, ReplyLine, useBoxGrow } from '../../composer/view/ComposerRow'
import { dayOf, shortDateOf } from '../../parts/time'
import type { SenderTone } from '../../parts/tones'
import '../../helpers/helpers.css'

/** What a reply answers, as its bar says it: who (the author rule), one line, their colour, when. */
export interface PartnerReplyBar {
  readonly who: string
  readonly line: string
  readonly tone: SenderTone
  readonly at: string
}

/** "Ask <name>, factory designer" (F-CP-156): a checkbox drawn as a chip; held: a lock and its reason (focusable, never disabled). */
export interface PartnerDesigner {
  /** Its words ("Ask Dora Campione, factory designer"): the host's catalogue. */
  readonly ask: string
  readonly on: boolean
  /** The rule, in the chip's tooltip and for a screen reader. */
  readonly hint: string
  /** Why it cannot be ticked now, in words; null: it can. */
  readonly held: string | null
  /** An "@" being typed that matches the name: the chip completes it ("@Dora Campione ") and ticks. */
  readonly completes: boolean
}

/** The link kind's "+": the record's files shared with the guest that may go with the message (A10: no quote there). */
export interface PartnerAttach {
  readonly files: readonly { readonly id: string; readonly name: string }[]
  readonly attached: readonly string[]
}

export interface PartnerComposerModel {
  readonly value: string
  readonly busy: boolean
  /** Writing is held (no right, closed, a preview): ONE line in place of the box, in the host's words. */
  readonly held: string | null
  readonly reply?: PartnerReplyBar | null | undefined
  /** What the last post said in the ONE bar ("We asked Dora Campione."), or null. */
  readonly said?: string | null | undefined
  readonly designer?: PartnerDesigner | null | undefined
  readonly attach?: PartnerAttach | null | undefined
  /** "Now" for the reply bar's date (ISO); absent: the clock. */
  readonly now?: string | undefined
}

export interface PartnerComposerActions {
  readonly onChange?: ((value: string) => void) | undefined
  readonly onSend?: (() => void) | undefined
  readonly onDropReply?: (() => void) | undefined
  readonly onAskDesigner?: ((on: boolean) => void) | undefined
  readonly onDesignerChip?: (() => void) | undefined
  readonly onAttach?: ((ids: string[]) => void) | undefined
  /** Esc with no reply bar: the focus goes back to the list. */
  readonly onEscape?: (() => void) | undefined
}

/**
 * pt-w2 W2.2 (lane pt-, S7, S8; 10-design §1 row 5, §5): the partner's composer on the office's ONE row (ComposerRow): the ONE bar
 * (the reply — colour edge, name, one line, × — or what the last post said), the chips row (the designer chip; the link's attached
 * files), the box (a DS Textarea, a textbox named "Your message"; one line growing to about 8), Send (named "Send", held with why while
 * empty or sending), the counter only near the limit, Enter sends and Shift+Enter makes a new line, Esc drops the reply. Held (no right,
 * closed, a preview): ONE line in place of the box. The "+" only on the link kind (its shared files). Draws its model only.
 */
export function PartnerComposer({ model, actions }: { model: PartnerComposerModel; actions?: PartnerComposerActions | undefined }): ReactNode {
  const words = useT('record-thread-partner')
  const box = useT('record-thread-composer')
  const locale = useLocale()
  const boxRef = useRef<HTMLDivElement>(null)
  const [announce, setAnnounce] = useState('')
  const hintId = useId()
  useBoxGrow(boxRef, { body: model.value })

  if (model.held !== null) {
    return (
      <ComposerHeld icon={<Lock size={16} aria-hidden />}>
        <span>{model.held}</span>
      </ComposerHeld>
    )
  }

  // Send is held while there is nothing to send, or while it is sending (the portal box's words).
  const attached = model.attach?.attached.length ?? 0
  const sendHeld = model.busy ? words('sending') : model.value.trim() === '' && attached === 0 ? words('emptyHeld') : null
  const send = () => {
    if (sendHeld) {
      setAnnounce(sendHeld)
      return
    }
    actions?.onSend?.()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) =>
    composerKeys(event, { enterSends: true, body: model.value }, {
      send,
      escape: () => {
        if (model.reply) actions?.onDropReply?.()
        else actions?.onEscape?.()
      },
    })

  const reply = model.reply ?? null
  const bar = reply ? (
    <LinkBar tone={reply.tone} label={box('link.replying', { who: reply.who, when: shortDateOf(reply.at, locale, dayOf(model.now ?? new Date().toISOString())) })} drop={{ label: box('link.dropReply'), onDrop: () => actions?.onDropReply?.() }}>
      <ReplyLine who={reply.who} line={reply.line} />
    </LinkBar>
  ) : model.said ? (
    <div className="fw-rt-cx-bar fw-rt-cx-notes" role="status">
      <p className="fw-rt-cx-line">{model.said}</p>
    </div>
  ) : null

  const designer = model.designer ?? null
  const attach = model.attach ?? null
  const shownFiles = attach ? attach.files.filter((file) => attach.attached.includes(file.id)) : []
  const chips =
    designer || shownFiles.length > 0 ? (
      <div className="fw-rt-cx-chips">
        {designer && <DesignerChip designer={designer} hintId={hintId} actions={actions} />}
        {shownFiles.map((file) => (
          <span key={file.id} className="fw-rt-cx-chip fw-rtp-file">
            <Paperclip size={13} aria-hidden />
            <span>{file.name}</span>
            <button type="button" className="fw-rt-cx-chip-x" aria-label={words('attach.drop', { name: file.name })} onClick={() => actions?.onAttach?.(attach!.attached.filter((id) => id !== file.id))}>
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
      </div>
    ) : null

  // The link kind's "+": the record's shared files, ticked to go with the message ("Only files already shared with you…" as its hint).
  const plus =
    attach && attach.files.length > 0 ? (
      <Menu
        className="fw-rt-clip-menu"
        label={<Plus size={16} aria-hidden />}
        items={[
          { id: 'attach-heading', heading: true, label: words('attach.label') },
          ...attach.files.map((file) => ({
            id: `attach-${file.id}`,
            label: file.name,
            checked: attach.attached.includes(file.id),
            onSelect: () => actions?.onAttach?.(attach.attached.includes(file.id) ? attach.attached.filter((id) => id !== file.id) : attach.files.map((one) => one.id).filter((id) => id === file.id || attach.attached.includes(id))),
          })),
        ] satisfies MenuItemDef[]}
        triggerProps={{ 'aria-label': words('attach.label'), 'aria-description': words('attach.hint'), className: 'nds-btn quiet sm icon' }}
      />
    ) : null

  return (
    <ComposerRow
      bar={bar}
      chips={chips}
      plus={plus}
      box={{
        input: (
          <div className="fw-rtm">
            <Textarea
              className="fw-rt-cx-text"
              rows={1}
              value={model.value}
              aria-label={words('box')}
              placeholder={box('placeholder')}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => actions?.onChange?.(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
        ),
        ref: boxRef,
      }}
      send={{ label: words('send'), held: sendHeld, onSend: send }}
      length={[...model.value].length}
      lines={
        attached > 0 ? (
          <p className="fw-rt-cx-line" role="status">
            {words('attach.attached', { count: attached })}
          </p>
        ) : null
      }
      announce={announce}
    />
  )
}

/** The designer chip: a checkbox (Space toggles it), the rule in its tooltip; held: a lock, `aria-disabled`, why in the tooltip. */
function DesignerChip({ designer, hintId, actions }: { designer: PartnerDesigner; hintId: string; actions?: PartnerComposerActions | undefined }): ReactNode {
  const held = designer.held
  const on = designer.on && held === null
  // Its name is its words only ("Ask Dora Campione, factory designer"); the rule (or why it is held) describes it.
  return (
    <>
      <Tooltip label={held ?? designer.hint} portal>
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          aria-disabled={held !== null ? true : undefined}
          aria-describedby={hintId}
          className={`fw-rt-cx-chip fw-rtm-followup fw-rtp-designer${on ? ' is-on' : ''}${held !== null ? ' is-held' : ''}`}
          onClick={() => {
            if (held !== null) return
            if (designer.completes && !on) actions?.onDesignerChip?.()
            else actions?.onAskDesigner?.(!on)
          }}
        >
          {held !== null ? <Lock size={13} aria-hidden /> : on ? <Check size={13} aria-hidden /> : <AtSign size={13} aria-hidden />}
          {designer.ask}
        </button>
      </Tooltip>
      <span id={hintId} className="nds-vh">
        {held ?? designer.hint}
      </span>
    </>
  )
}
