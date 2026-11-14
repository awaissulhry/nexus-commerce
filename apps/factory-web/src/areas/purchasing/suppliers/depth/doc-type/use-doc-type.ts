'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import type { PickerReason } from '../../../../_shared/reasons/api'
import type { VaultDocument } from '../api'
import { documentTypes, fileVersion, setDocumentType } from './api'
import { docTypeHeld, docTypeProblem, type DocTypeDialog } from './model'

export interface DocTypeModel {
  /** The list's codes (null: being read, or it could not be read — the cells then say the code). */
  readonly types: readonly PickerReason[] | null
  /** files.upload: may say what a document is. */
  readonly mayType: boolean
  readonly offline: boolean
  readonly dialog: DocTypeDialog | null
  readonly done: { readonly name: string } | null
}

export interface DocTypeActions {
  onOpenType?: (doc: Pick<VaultDocument, 'fileId' | 'name' | 'documentTypeCode' | 'version'>) => void
  onChooseType?: (code: string) => void
  onSaveType?: () => void
  onCloseType?: () => void
  onDismissType?: () => void
}

/**
 * The container of the document-type picker (B-W2b-382): reads the SUPPLIER_DOCUMENT_TYPE list once, opens a document's
 * picker with its file's version as the vault answered it (B-W2b-383: no read of the file first), saves the type with ONE
 * Idempotency-Key per dialog; a refusal is said in words and the vault read again when the file moved (`onTyped`), the
 * file's version too. The live `supplier_document.typed` reads the vault too.
 */
export function useDocType(input: { readonly api: ApiClient; readonly partyId: string; readonly mayType: boolean; readonly offline: boolean; readonly onTyped: () => void }): { model: DocTypeModel; actions: DocTypeActions } {
  const { api, partyId, mayType, offline, onTyped } = input
  const [types, setTypes] = useState<readonly PickerReason[] | null>(null)
  const [dialog, setDialog] = useState<DocTypeDialog | null>(null)
  const [done, setDone] = useState<DocTypeModel['done']>(null)
  const key = useRef(newIdempotencyKey())

  useEffect(() => {
    const controller = new AbortController()
    documentTypes(api, controller.signal)
      .then(setTypes)
      .catch(() => undefined)
    return () => controller.abort()
  }, [api])

  const open = useCallback(
    (doc: Pick<VaultDocument, 'fileId' | 'name' | 'documentTypeCode' | 'version'>) => {
      key.current = newIdempotencyKey()
      setDone(null)
      setDialog({ fileId: doc.fileId, name: doc.name, current: doc.documentTypeCode ?? null, chosen: doc.documentTypeCode ?? '', version: doc.version, busy: false, problem: null })
    },
    [],
  )

  const save = useCallback(async () => {
    if (!dialog || docTypeHeld(dialog, { mayType, offline }) || dialog.version === null) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await setDocumentType(api, partyId, dialog.fileId, { version: dialog.version, documentTypeCode: dialog.chosen || null }, key.current)
      key.current = newIdempotencyKey()
      setDialog(null)
      setDone({ name: dialog.name })
      onTyped()
    } catch (error) {
      const said = docTypeProblem(error)
      key.current = newIdempotencyKey()
      // B-W2b-383: a file that moved holds Save ("reading") until its new version is in.
      setDialog({ ...dialog, busy: false, problem: said.key, ...(said.reload ? { version: null } : {}) })
      if (said.reload) {
        onTyped()
        // The file moved: its version is read again, so a second Save writes over what is there now, knowingly.
        fileVersion(api, dialog.fileId)
          .then((version) => setDialog((current) => (current?.fileId === dialog.fileId ? { ...current, version } : current)))
          .catch((cause: unknown) => setDialog((current) => (current?.fileId === dialog.fileId ? { ...current, problem: docTypeProblem(cause).key } : current)))
      }
    }
  }, [api, dialog, mayType, offline, onTyped, partyId])

  return {
    model: { types, mayType, offline, dialog, done },
    actions: {
      onOpenType: open,
      onChooseType: (code) => setDialog((current) => (current ? { ...current, chosen: code, problem: null } : current)),
      onSaveType: () => void save(),
      onCloseType: () => setDialog(null),
      onDismissType: () => setDone(null),
    },
  }
}
