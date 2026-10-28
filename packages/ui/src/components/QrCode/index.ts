/**
 * The QR code — an entry point of its own, NOT re-exported by the components barrel (the web pulls that barrel into
 * every page's first load). Import this folder (`@/design-system/components/QrCode` in the web,
 * `@nexus/ui/components/QrCode/index` by package path). Only types come from the model here: its encoder (`qrcode`) is
 * loaded by `QrCode` when a code is drawn, never by this entry.
 */
export { QrCode, QR_CODE_LABELS, type QrCodeProps, type QrCodeLabels } from './QrCode'
export type { QrErrorLevel, QrMatrix } from './qrCodeModel'
