import type { CameraScanner } from '@nexus/ui/floor'

/**
 * The camera that reads a garment's label for its serial ("scan the label (camera) or type", design links.claim
 * sec:item): a `CameraScanner` over `@zxing/browser` (a dependency of this app), the same few lines as the floor's
 * `src/floor/camera.ts`, which the Links view may not import (check-view-boundaries rule 3). ZXing loads only when the
 * camera opens, so a page whose camera stays closed never ships it. The rear camera on a phone.
 */
export const labelCamera: CameraScanner = {
  async start(video, onCode) {
    const { BrowserMultiFormatReader } = await import('@zxing/browser')
    const reader = new BrowserMultiFormatReader()
    const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, video, (result) => {
      if (result) onCode(result.getText())
    })
    return () => controls.stop()
  },
}
