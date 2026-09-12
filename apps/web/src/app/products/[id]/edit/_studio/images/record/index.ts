/**
 * PES.7 — the per-record image read, for PES.4's drawer (audit 4.12).
 *
 * The only image surface this lane exposes to another. Everything that WRITES an image stays in
 * the Images tab; this is a read.
 */
export { useRecordImages, type RecordImagesState } from './useRecordImages'
export { resolveRecordImages, pickFaceImage, type RecordImage, type RecordImages, type ProductImageRow } from './recordImages'
