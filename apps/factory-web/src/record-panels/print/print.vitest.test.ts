import { describe, expect, it } from 'vitest'
import { designScreen } from '../fixtures'
import { printPanelsModel } from './print-model'

describe('the record panels for paper (B-W2b-05, PLT-171)', () => {
  it('draws every panel read-only: no composer, upload, close, follow or passing state', () => {
    const full = designScreen.cases.find((item) => item.id === 'followers')!.model
    const paper = printPanelsModel(full)
    expect(paper.can).toMatchObject({ post: false, email: false, manage: false, upload: false, share: false, readFiles: full.can.readFiles })
    expect(paper.followers).toBeUndefined()
    expect(paper).toMatchObject({ notice: null, preview: null, uploads: [], sending: false })
    expect(paper.tasks).toMatchObject({ addHeld: null, dialog: null, undo: null })
    expect(paper.messages).toBe(full.messages)
    expect(paper.timeline).toBe(full.timeline)
  })
})
