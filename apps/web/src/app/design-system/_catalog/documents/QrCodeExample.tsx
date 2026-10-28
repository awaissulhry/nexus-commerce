'use client'

import { QrCode } from '@/design-system/components/QrCode'

/*
 * 2026-10-28 — G7 (QR part), the QR code for a device enrolment. Dark modules on a light plate in both themes; the text
 * form under it is what a person types when the camera cannot read the code. Verify, light and dark, 390 and 1440 px:
 * a phone camera reads the codes; Copy says Copied; the long value says it is too long, in words.
 */
export function QrCodeExample() {
  return (
    <section id="qr-code-example">
      <h3>QrCode · a code to scan, with its text form</h3>
      <p>
        SVG from the value (error correction M, a four-module quiet zone), named for a screen reader by <code>label</code>.
        The encoder loads when the first code is drawn. <code>code</code> shows a short code instead of the long address.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 32 }}>
        <QrCode value="https://factory.example.com/enrol?code=7K4Q-29XD" code="7K4Q-29XD" label="Enrolment code for Cutting station 2" size={208} />
        <QrCode value="NXF-ENROL-3M8P" label="Enrolment code for Packing station 1" size={144} />
        <QrCode value={'x'.repeat(8000)} code="(8,000 characters)" label="A value too long for a QR code" size={144} />
      </div>
    </section>
  )
}
