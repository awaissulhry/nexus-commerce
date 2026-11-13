'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useOnline } from '../../../products/options/online'
import { checkCombination, readStyleConfigurator, type BenchCheck, type PickBody, type StyleConfigurator } from '../../quotes/record/configurator/api'
import { setPick, togglePick, type DraftPick } from '../../quotes/record/configurator/model'
import { draftOfPicks, entryButton, entryHeld, entryKey, picksOfDraft } from './model'
import { OptionsEntryView, type OptionsEntryModel } from './view/OptionsEntryView'
import { FollowupsMessages, useFollowupsWords, type FollowupsSay } from '../../../../lib/options-followups/words'

const CHECK_DELAY_MS = 400

export interface NewLineOptionsProps {
  api: ApiClient
  styleId: string
  colourwayId: string
  /** The line's names in the dialog's title. */
  line: { style: string; colour: string }
  picks: readonly PickBody[]
  onChange: (picks: PickBody[]) => void
}

/**
 * A typed order line's "Options" (B-W2b-374; XF3:02): the button on a new line of a New order or of an amendment, and the
 * dialog (SCR-433) that reads the style's options (B-W2b-340's GET /sales/configurator/styles/:styleId) and checks each
 * change of the draft with B-W2b-229's check (debounced; an older answer dropped). "Use these options" hands the picks to the
 * line, which sends them with the order. Its own container: it reads only while the dialog is open.
 */
export function NewLineOptions(props: NewLineOptionsProps) {
  const [open, setOpen] = useState(false)
  return (
    <FollowupsMessages>
      <Opener {...props} open={open} onOpen={setOpen} />
    </FollowupsMessages>
  )
}

function Opener({ open, onOpen, ...props }: NewLineOptionsProps & { open: boolean; onOpen: (open: boolean) => void }) {
  const { t, say } = useFollowupsWords()
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => onOpen(true)}>
        <SlidersHorizontal size={14} aria-hidden /> {say(entryButton(props.picks))}
      </Button>
      {open && (
        <Modal open onClose={() => onOpen(false)} title={t('entry.title', { style: props.line.style, colour: props.line.colour })} size="xl">
          <Dialog {...props} onDone={() => onOpen(false)} />
        </Modal>
      )}
    </>
  )
}

function Dialog({ api, styleId, colourwayId, line, picks, onChange, onDone }: NewLineOptionsProps & { onDone: () => void }) {
  const online = useOnline()
  const [read, setRead] = useState<OptionsEntryModel['read']>({ status: 'loading' })
  const [style, setStyle] = useState<StyleConfigurator | null>(null)
  const [draft, setDraft] = useState<DraftPick[]>([])
  const [check, setCheck] = useState<OptionsEntryModel['check']>({ status: 'idle', value: null })
  const [tries, setTries] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    const controller = new AbortController()
    setRead({ status: 'loading' })
    readStyleConfigurator(api, styleId, controller.signal, colourwayId)
      .then((value) => {
        setStyle(value)
        setDraft(draftOfPicks(picks, value))
        setRead({ status: 'ready' })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const problem: FollowupsSay = { key: isApiError(error) && (error.kind === 'forbidden' || error.kind === 'not_found') ? 'entry.problem.hidden' : 'entry.problem.load' }
        setRead({ status: 'error', problem })
      })
    return () => controller.abort()
    // The picks are read once, when the dialog opens.
  }, [api, styleId, colourwayId, tries])

  const key = entryKey(draft, style)
  useEffect(() => {
    if (!style || !online) return
    const body = picksOfDraft(draft, style)
    if (body.length === 0) {
      setCheck({ status: 'idle', value: null })
      return
    }
    const mine = ++seq.current
    setCheck((current) => ({ status: 'checking', value: current.value }))
    const timer = setTimeout(() => {
      checkCombination(api, styleId, body)
        .then((value: BenchCheck) => mine === seq.current && setCheck({ status: 'ready', value }))
        .catch(() => mine === seq.current && setCheck({ status: 'error', value: null }))
    }, CHECK_DELAY_MS)
    return () => clearTimeout(timer)
    // The draft's key names what is checked.
  }, [api, styleId, key, online, style])

  const use = useCallback(() => {
    onChange(picksOfDraft(draft, style))
    onDone()
  }, [draft, onChange, onDone, style])

  const empty = picksOfDraft(draft, style).length === 0
  const model: OptionsEntryModel = {
    line,
    read,
    style,
    draft,
    check,
    useHeld: empty ? null : entryHeld({ online, checking: check.status === 'checking', check: check.value, failed: check.status === 'error' }, draft, style),
    offline: !online,
  }
  return (
    <OptionsEntryView
      model={model}
      actions={{
        onToggle: (group, valueId) => setDraft((current) => togglePick(current, group, valueId)),
        onText: (valueId, text) => setDraft((current) => setPick(current, valueId, { text })),
        onColour: (valueId, colourId) => setDraft((current) => setPick(current, valueId, { colourId })),
        onMaterial: (valueId, itemId, itemColourId) => setDraft((current) => setPick(current, valueId, { itemId, itemColourId })),
        onClear: () => setDraft([]),
        onUse: use,
        onCancel: onDone,
        onRetry: () => setTries((value) => value + 1),
      }}
    />
  )
}
