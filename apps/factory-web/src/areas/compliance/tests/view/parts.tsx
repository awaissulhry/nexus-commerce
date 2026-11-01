'use client'

import { Fragment, useRef, type ReactNode } from 'react'
import { Paperclip } from 'lucide-react'
import { Button, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { Modal, StepUpModal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { StepUpState } from '../../../quality/_shared/hooks'
import { LOT_TONE, type Lot } from '../../../quality/_shared/lots'
import { QualityMessages } from '../../../quality/_shared/parts'
import { CR_VI_WORD_TONE, crViWord, LEGAL_LIMIT, mgKg } from '../model'
import '../lab.css'

/**
 * The parts both Tests & substances screens draw (the lots list SCR-054 and the lot record): the lab's words with the
 * shared quality words, the lot's state and Cr VI marks (a word with every colour, never colour alone), a file chooser
 * in this app's words, the keys dialog and the step-up dialog in the lab's words (the shared StepUpDialog reads its
 * sentence from the `quality` catalogue; a lab sentence needs its own). Nothing here fetches.
 */

export function LabMessages({ children }: { children?: ReactNode }) {
  return <QualityMessages namespaces={['lab']}>{children}</QualityMessages>
}

export function LotStatusPill({ status }: { status: Lot['qualityStatus'] }) {
  const t = useT('lab')
  return (
    <Pill tone={LOT_TONE[status]} dot>
      {t(`status.${status}`)}
    </Pill>
  )
}

/** The lot's Cr VI state in a word, and the value against the limit when there is one ("1.2 / 3 mg/kg"). */
export function CrViMark({ lot, withValue = true }: { lot: Pick<Lot, 'crVi'>; withValue?: boolean }) {
  const t = useT('lab')
  const locale = useLocale()
  const word = crViWord(lot)
  const value = lot.crVi.valueMgKg !== null ? t('crVi.value', { value: mgKg(lot.crVi.valueMgKg, locale), limit: mgKg(lot.crVi.limitMgKg ?? LEGAL_LIMIT, locale) }) : null
  return (
    <span className="fw-q-cell-row">
      <Tag tone={CR_VI_WORD_TONE[word]}>{t(`crVi.${word}`)}</Tag>
      {withValue && value && <span className="fw-q-num fw-q-hint">{value}</span>}
    </span>
  )
}

/** A file chooser in this app's words: a button, the chosen name, what may be chosen. The bytes go to the container. */
export function FileChooser({ name, onFile, accept = '.pdf,.jpg,.jpeg,.png', error, label, hint }: { name: string | null; onFile: (file: File) => void; accept?: string; error?: string | null; label: string; hint: string }) {
  const t = useT('lab')
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="fw-lab-file">
      <span className="fw-lab-file-label">{label}</span>
      <span className="fw-q-cell-row">
        <Button size="sm" onClick={() => input.current?.click()}>
          <Paperclip size={14} aria-hidden /> {name ? t('file.change') : t('file.choose')}
        </Button>
        <span className={name ? 'fw-q-code' : 'fw-q-hint'}>{name ?? t('file.none')}</span>
      </span>
      <span className="fw-q-hint">{hint}</span>
      {error && (
        <span className="fw-lab-error" role="alert">
          {error}
        </span>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onFile(file)
          event.target.value = ''
        }}
      />
    </div>
  )
}

/** The keys of the page, in a dialog (`?` and the keys panel's "All shortcuts"). */
export function ShortcutsDialog({ open, keys, onClose }: { open: boolean; keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose?: () => void }) {
  const t = useT('lab')
  const q = useT('quality')
  return (
    <Modal open={open} onClose={() => onClose?.()} title={t('keys.title')} size="sm" footer={<Button onClick={() => onClose?.()}>{q('common.close')}</Button>}>
      <dl className="fw-lab-keymap">
        {keys.map((entry) => (
          <Fragment key={entry.does}>
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does}</dd>
          </Fragment>
        ))}
      </dl>
    </Modal>
  )
}

/** The DS step-up dialog with a lab sentence (what the code allows) and the shared quality words for the rest. */
export function LabStepUp({ state, onSubmit, onCancel }: { state: StepUpState | undefined; onSubmit?: (code: string) => void; onCancel?: () => void }) {
  const t = useT('lab')
  const q = useT('quality')
  if (!state) return null
  return (
    <StepUpModal
      open={state.open}
      title={q('stepUp.title')}
      sentence={state.sentence ? t(state.sentence) : ''}
      busy={state.busy}
      error={state.problem ? q(state.problem) : null}
      onSubmit={(code) => onSubmit?.(code)}
      onClose={() => onCancel?.()}
      confirmLabel={t('rule.saveLoosen')}
    />
  )
}

/** A key's words: a `lists` message key (the frame's keys), else the screen's own words. */
export function useListWords() {
  const t = useT('lists')
  return (does: string) => {
    const text = t(does)
    return text === does ? does : text
  }
}
