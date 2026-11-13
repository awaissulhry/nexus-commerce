'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import type { ApiClient } from '../../../../lib/api/client'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { grainsOf } from '../../../sales/quotes/model'
import { checkCombination, readStyleConfigurator, type BenchCheck, type StyleConfigurator } from '../../../sales/quotes/record/configurator/api'
import { setPick, togglePick, type DraftPick } from '../../../sales/quotes/record/configurator/model'
import { ConfiguratorView, type ConfiguratorModel } from '../../../sales/quotes/record/configurator/view/ConfiguratorView'
import { ConfiguratorMessages, useConfiguratorWords } from '../../../sales/quotes/record/configurator/words'
import { listStyles } from '../../styles/api'
import { benchModelOf } from './model'

const CHECK_DELAY_MS = 400

export interface TestCombinationProps {
  api: ApiClient
  /** The Style studio's link (`?style=`): that style first. */
  styleId: string | null
  permissions: readonly string[]
}

/**
 * Products › Options & rules: "Test a combination" (B-W2b-340; SAL-249; design products.options pop "Configurator preview"):
 * for the people who keep the options up to date — a style, its option groups with their rules and surcharges, the values
 * picked, and B-W2b-229's check of the combination (POST /product/styles/:styleId/options/check: blocks and warnings in the
 * rule's words, the surcharges added up, what changes in the BOM and the routing). A read: nothing is saved.
 */
export function TestCombination(props: TestCombinationProps) {
  const [open, setOpen] = useState(false)
  return (
    <ConfiguratorMessages>
      <Opener {...props} open={open} onOpen={setOpen} />
    </ConfiguratorMessages>
  )
}

function Opener({ open, onOpen, ...props }: TestCombinationProps & { open: boolean; onOpen: (open: boolean) => void }) {
  const { t } = useConfiguratorWords()
  return (
    <>
      <Button size="sm" onClick={() => onOpen(true)}>
        <FlaskConical size={14} aria-hidden /> {t('bench.open')}
      </Button>
      {open && (
        <Modal open onClose={() => onOpen(false)} title={t('bench.title')} size="xl" footer={<Button onClick={() => onOpen(false)}>{t('bench.close')}</Button>}>
          <Bench {...props} />
        </Modal>
      )}
    </>
  )
}

function Bench({ api, styleId: first, permissions }: TestCombinationProps) {
  const [styles, setStyles] = useState<{ value: string; label: string }[]>([])
  const [styleId, setStyleId] = useState(first ?? '')
  const [style, setStyle] = useState<StyleConfigurator | null>(null)
  const [read, setRead] = useState<ConfiguratorModel['read']>({ status: 'ready' })
  const [draft, setDraft] = useState<DraftPick[]>([])
  const [check, setCheck] = useState<{ status: 'idle' | 'checking' | 'ready' | 'error'; value: BenchCheck | null }>({ status: 'idle', value: null })
  const [tries, setTries] = useState(0)
  const grains = useMemo(() => grainsOf(permissions), [permissions])

  useEffect(() => {
    let live = true
    listStyles(api, { limit: 200 })
      .then((page) => live && setStyles(page.styles.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))))
      .catch(() => live && setStyles([]))
    return () => {
      live = false
    }
  }, [api])

  useEffect(() => {
    if (!styleId) return setStyle(null)
    const control = new AbortController()
    setRead({ status: 'loading' })
    readStyleConfigurator(api, styleId, control.signal)
      .then((next) => {
        if (control.signal.aborted) return
        setStyle(next)
        setDraft([])
        setRead({ status: 'ready' })
      })
      .catch(() => !control.signal.aborted && setRead({ status: 'error', problem: { key: 'problem.read' } }))
    return () => control.abort()
  }, [api, styleId, tries])

  const seq = useRef(0)
  const key = JSON.stringify(draft.map((pick) => [pick.valueId, pick.text]))
  useEffect(() => {
    if (!style) return
    const mine = ++seq.current
    setCheck((current) => ({ status: 'checking', value: current.value }))
    const values = new Map(style.groups.flatMap((group) => group.values.map((value) => [value.id, value] as const)))
    const timer = setTimeout(() => {
      checkCombination(api, style.style.id, draft.map((pick) => ({ valueId: pick.valueId, ...(values.get(pick.valueId)?.freeText ? { text: pick.text } : {}) })))
        .then((value) => mine === seq.current && setCheck({ status: 'ready', value }))
        .catch(() => mine === seq.current && setCheck({ status: 'error', value: null }))
    }, CHECK_DELAY_MS)
    return () => clearTimeout(timer)
    // The style and the draft's key name what is checked.
  }, [api, style?.style.id, key])

  const model = benchModelOf({ styles, styleId, style, read, draft, check, grains })
  return (
    <ConfiguratorView
      model={model}
      actions={{
        onStyle: (next) => setStyleId(next),
        onToggle: (group, valueId) => setDraft((current) => togglePick(current, group, valueId)),
        onText: (valueId, text) => setDraft((current) => setPick(current, valueId, { text })),
        onRetry: () => setTries((value) => value + 1),
      }}
    />
  )
}
