'use client'

/**
 * PES.7 — generate a lifestyle scene for this product.
 *
 * The result is a normal master image (`type: 'LIFESTYLE'`) stored on Cloudinary like any other,
 * so everything downstream — the gallery, the channel matrices, publish — treats it identically.
 * What makes it different is only its provenance, and the surface says so rather than letting a
 * generated scene pass as photography.
 *
 * Every bound the route enforces is enforced here first: prompt length (10–2000) and the five
 * aspect ratios Imagen accepts. A 400 should never be how an operator learns a rule the client
 * already knows. What is NOT pre-empted is the generation itself — if Imagen refuses (its key
 * needs a paid plan), the server's own sentence is shown verbatim, because that one is actionable
 * and only the server knows it.
 */
import { useCallback, useMemo, useState } from 'react'

import { Modal } from '@/design-system/components'
import { Button, SegmentedControl, Textarea } from '@/design-system/primitives'

import { apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import {
  LIFESTYLE_ASPECT_RATIOS, LIFESTYLE_PROMPT_MAX, LIFESTYLE_PROMPT_MIN,
  type GenerateLifestyleResponse, type LifestyleAspectRatio, type MasterAsset,
} from '../types'
import styles from './ai.module.css'

export interface LifestyleGeneratorProps {
  open: boolean
  productId: string
  /** Seeds the prompt, so the operator starts from what this product IS. */
  productName: string | null
  onClose(): void
  onGenerated(created: MasterAsset): void
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

/**
 * Openers, not finished prompts — each one still needs the product and the scene from the
 * operator, which is why they end mid-sentence rather than pretending to be complete.
 */
const OPENERS = [
  'Worn by a rider on a coastal road at golden hour, ',
  'On a plain studio backdrop with soft directional light, ',
  'Laid flat on weathered wood beside a helmet and gloves, ',
]

export function LifestyleGenerator({
  open, productId, productName, onClose, onGenerated, write,
}: LifestyleGeneratorProps) {
  const [prompt, setPrompt] = useState('')
  const [aspect, setAspect] = useState<LifestyleAspectRatio>('1:1')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

  const trimmed = prompt.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < LIFESTYLE_PROMPT_MIN
  const tooLong = trimmed.length > LIFESTYLE_PROMPT_MAX
  const canGenerate = trimmed.length >= LIFESTYLE_PROMPT_MIN && !tooLong && !busy

  const counter = useMemo(() => {
    if (tooLong) return `${trimmed.length} — ${trimmed.length - LIFESTYLE_PROMPT_MAX} over the limit`
    if (tooShort) return `${trimmed.length} of at least ${LIFESTYLE_PROMPT_MIN}`
    return `${trimmed.length} / ${LIFESTYLE_PROMPT_MAX}`
  }, [tooLong, tooShort, trimmed.length])

  const close = useCallback(() => {
    setPrompt(''); setAspect('1:1'); setRefusal(null); onClose()
  }, [onClose])

  const generate = useCallback(async () => {
    setBusy(true)
    setRefusal(null)
    const res = await write(writeSubject.upload(`ai:${trimmed.slice(0, 80)}`), () => apiSend<GenerateLifestyleResponse>(
      routes.generateLifestyle(productId), 'POST',
      // `alt` records the provenance on the row itself, so a generated scene is identifiable
      // later from the data and not only from the surface that made it.
      { prompt: trimmed, aspectRatio: aspect, alt: `AI-generated scene · ${trimmed.slice(0, 80)}` },
    ))
    setBusy(false)
    if (!res.ok) { setRefusal(res.message); return }
    const created = res.data?.image
    if (!created?.id) {
      setRefusal('The image was generated but the response could not be read — reload to see it.')
      return
    }
    onGenerated(created)
    close()
  }, [aspect, close, onGenerated, productId, trimmed, write])

  if (!open) return null

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title="Generate a lifestyle scene"
      subtitle={productName ?? undefined}
      footer={
        <>
          <Button size="sm" variant="ghost" disabled={busy} onClick={close}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!canGenerate} onClick={() => void generate()}>
            {busy ? 'Generating…' : 'Generate'}
          </Button>
        </>
      }
    >
      <div className={styles.block}>
        <label className={styles.label} htmlFor="lifestyle-prompt">Scene</label>
        <Textarea
          id="lifestyle-prompt"
          rows={5}
          value={prompt}
          placeholder="Describe the scene and how the product sits in it."
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className={styles.counterRow}>
          <span className={tooShort || tooLong ? styles.counterBad : styles.counter}>{counter}</span>
        </div>
        <div className={styles.openers}>
          {OPENERS.map((o) => (
            <Button key={o} size="sm" variant="ghost" disabled={busy}
              onClick={() => setPrompt((p) => (p ? p : o))}>
              {o.slice(0, 28).trim()}…
            </Button>
          ))}
        </div>
      </div>

      <div className={styles.block}>
        <span className={styles.label}>Shape</span>
        <SegmentedControl
          ariaLabel="Aspect ratio"
          size="sm"
          value={aspect}
          onChange={(v) => setAspect(v as LifestyleAspectRatio)}
          options={LIFESTYLE_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))}
        />
      </div>

      {refusal && <p className={styles.refusal} role="alert">{refusal}</p>}

      <p className={styles.hint}>
        The result is saved as a LIFESTYLE master image and is marked as generated in its alt text.
        It is not photography of this product — check it before putting it on a channel.
      </p>
    </Modal>
  )
}
