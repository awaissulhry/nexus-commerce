'use client'

import { useState } from 'react'
import { Banner } from '@nexus/ui/components'
import { PhotoCapture, type CameraProblem, type CapturedPhoto, type KeyDraft, type PhotoGuide, type PhotoMark, type PhotoTool } from '@nexus/ui/components/PhotoCapture/index'
import { densityAttrs, type DensityName } from '@nexus/ui/tokens/density'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { PHOTO_KIT_NAMESPACE, usePhotoWords } from '../../../../lib/ds-words/photo-capture'
import '../photo-capture-lab.css'

/** A made-up photo: the app's own photo (a size and an address), standing in for what the files API would give. */
export interface LabPhoto {
  src: string
  width: number
  height: number
}

/** The ONE view model of the photo capture lab: where the part starts and the screen's own state. It fetches nothing. */
export interface PhotoCaptureLabModel {
  /** Which screen uses the part here (its name). */
  label: 'defect' | 'machine' | 'dock' | 'measure'
  /** A photo to mark from the start; none = the camera step. */
  photo?: LabPhoto
  marks?: readonly PhotoMark[]
  tool?: PhotoTool
  keyDraft?: KeyDraft
  /** The camera as the browser would answer (a design case). */
  camera?: CameraProblem
  markup?: boolean
  guide?: PhotoGuide
  facesHint?: boolean
  /** The screen's rule: Use photo waits for a mark. */
  required?: boolean
  /** This person may only look (no permission). */
  readOnly?: boolean
  /** The tablet is offline: the screen queues the photo (the part is not held). */
  offline?: boolean
  density?: DensityName
  /** Drawn in a phone-wide column. */
  phone?: boolean
}

const LABEL_KEY = { defect: 'lab.labelDefect', machine: 'lab.labelMachine', dock: 'lab.labelDock', measure: 'lab.labelMeasure' } as const

/**
 * SCR-247 — photo capture with markup, DS part D21 (B-W2a-24; NEW id: the design gives the DS part no screen of its own;
 * its screens are every photo step — the floor's dock, DDT, machine, defect, return and final-inspection steps, the
 * office's "Report a problem" on Machine requests, the claim and measure link pages). Made-up photos only; Use photo
 * prints what the screen would upload (nothing is sent). Every word from `photo-kit` in Italian and English.
 */
export function PhotoCaptureLabView({ model }: { model: PhotoCaptureLabModel }) {
  return (
    <WithMessages namespaces={[PHOTO_KIT_NAMESPACE]}>
      <Lab model={model} />
    </WithMessages>
  )
}

function Lab({ model }: { model: PhotoCaptureLabModel }) {
  const t = useT(PHOTO_KIT_NAMESPACE)
  const words = usePhotoWords()
  const [result, setResult] = useState<string | null>(null)

  const onCapture = (photo: CapturedPhoto) => {
    const marks = t('lab.marks', { count: photo.marks.length })
    setResult(t(model.offline ? 'lab.queued' : 'lab.got', { width: photo.width, height: photo.height, marks }))
  }

  return (
    <div className="fw-photolab" {...densityAttrs(model.density ?? 'standard')}>
      {model.offline ? <Banner tone="warning">{t('lab.offline')}</Banner> : null}
      <div className={model.phone ? 'fw-photolab-part is-phone' : 'fw-photolab-part'}>
        <PhotoCapture
          label={t(LABEL_KEY[model.label])}
          onCapture={onCapture}
          onCancel={() => setResult(t('lab.cancelled'))}
          markup={model.markup ?? true}
          guide={model.guide ?? 'frame'}
          facesHint={model.facesHint ?? true}
          defaultPhoto={model.photo}
          defaultMarks={model.marks}
          defaultTool={model.tool}
          defaultKeyDraft={model.keyDraft}
          defaultCamera={model.camera}
          heldReason={model.readOnly ? t('lab.readOnly') : null}
          useHeldReason={model.required ? (marks) => (marks.length ? null : t('lab.required')) : null}
          words={words}
        />
      </div>
      <p className="fw-photolab-result" role="status">
        {result ?? t('lab.waiting')}
      </p>
    </div>
  )
}
