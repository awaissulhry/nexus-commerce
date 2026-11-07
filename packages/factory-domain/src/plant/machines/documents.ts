/**
 * A machine's documents (B-W2b-136; QHS-165; D.Lgs. 81/2008 art. 71 c.4: the manuals at hand; design plant.machines ›
 * Machine › "Documents & CE"): its EU declaration of conformity (CE), its manuals, its photos, and the rest (diagrams,
 * wiring, settings sheets — said in the file's name). Each is a StoredFile of the Machine (recordType `Machine`) with the
 * category MACHINE_CE or MANUAL, a PHOTO, or OTHER. "No CE declaration on file" = no AVAILABLE MACHINE_CE file of the
 * machine. A file shared with the site's tablets (visibility FLOOR) is marked "on the tablets" (art. 71: at hand where
 * the machine works). Paper today: the register says what is missing, nothing refuses a machine without it.
 */

export const DOCUMENT_GROUPS = ['MACHINE_CE', 'MANUAL', 'PHOTO', 'OTHER'] as const
export type DocumentGroup = (typeof DOCUMENT_GROUPS)[number]

/** The file kinds each group takes (platform/files kinds; PDF or image as their rules say). */
export const GROUP_KINDS: Readonly<Record<DocumentGroup, readonly ('DOCUMENT' | 'CERTIFICATE' | 'PHOTO')[]>> = Object.freeze({
  MACHINE_CE: ['DOCUMENT', 'CERTIFICATE'],
  MANUAL: ['DOCUMENT'],
  PHOTO: ['PHOTO'],
  OTHER: ['DOCUMENT', 'PHOTO'],
})

/** The stored category of a group (a photo carries none: its kind says it). */
export const categoryOf = (group: DocumentGroup): 'MACHINE_CE' | 'MANUAL' | 'OTHER' | null => (group === 'PHOTO' ? null : group)

/** The group a stored file of a machine shows in. */
export function groupOf(file: { readonly category: string | null; readonly kind: string }): DocumentGroup {
  if (file.category === 'MACHINE_CE') return 'MACHINE_CE'
  if (file.category === 'MANUAL') return 'MANUAL'
  if (file.kind === 'PHOTO' && file.category === null) return 'PHOTO'
  return 'OTHER'
}

/** May this kind go in this group? */
export const kindFits = (group: DocumentGroup, kind: string): boolean => (GROUP_KINDS[group] as readonly string[]).includes(kind)

/** Is the CE declaration on file (an available MACHINE_CE file)? */
export const ceOnFile = (files: readonly { readonly category: string | null; readonly status: string }[]): boolean => files.some((file) => file.category === 'MACHINE_CE' && file.status === 'AVAILABLE')

/** The record type of a machine's files. */
export const MACHINE_RECORD = 'Machine'
