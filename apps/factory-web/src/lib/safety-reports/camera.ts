import type { CameraScanner } from '@nexus/ui/floor'

/**
 * The camera that reads a garment's label for its serial (design links.claim "serial: scan the label (camera) or type"; Owner
 * answer 11-10: the camera of a phone or tablet, no device spend): a `CameraScanner` over `@zxing/browser` (a dependency of
 * this app), the same few lines as the claim link's and the floor's copies, which the Portal and Office views may not import
 * (check-view-boundaries rule 3): one copy here serves the three safety-report doors. ZXing loads only when the camera
 * opens. The rear camera on a phone.
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
