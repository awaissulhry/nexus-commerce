import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, PHOTO_SRC, RECORD, RECORD_OFF, REV2, REV3, TODAY, uid, type RoleCase } from '../demo/fixtures'
import { designScreen as recordScreen } from '../record/fixtures'
import type { ProfileRecordModel } from '../record/view-model'
import { ProfileRecordView } from '../record/view/ProfileRecordView'
import type { PhotosView, PhotoView } from './api'
import type { OfficePhotosModel, PhotoDialog } from './use-photos'

/**
 * SCR-036-photos — the office's and the fittings' photos on the rider profile (B-W2b-371, XF2:01; design rider.photos "Upload ·
 * Open in Lightbox · Delete (reason, logged)") with made-up data only (no real person, photo or measure): the photos taken in the
 * office per revision and at a fitting, each with its delete date in words; Add a photo (the view, the photo, the delete date; held
 * until a photo is picked); Change the delete date (a later day, today = within the hour); a photo opened; made-to-measure off for
 * the template (Add held, said with where it starts); the production manager (dates its fittings' photos, adds none to a revision);
 * none yet; reading; the read failed; offline; the Fittings tab with a fitting's photos.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: ProfileRecordModel
}

const at = (month: number, day: number, hour = 10, minute = 0) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
const photo = (n: number, over: Partial<PhotoView> = {}): PhotoView => ({
  id: uid('7101', n),
  category: 'MTM_PHOTO',
  view: 'FRONT',
  status: 'AVAILABLE',
  sizeBytes: 812_000 + n * 1_000,
  deleteAfter: null,
  createdAt: at(11, 12, 10, n),
  by: { id: uid('3333', 7), name: 'Demo Pattern Maker' },
  version: 1,
  ...over,
})
// The demo fitting result of the record's Fittings tab (B-W2b-362's RESULT_ALTER).
const RESULT_ID = uid('6901', 1)
export const PHOTOS: PhotosView = {
  profileId: RECORD.id,
  partyId: RECORD.partyId,
  riderName: RECORD.riderName,
  garmentType: 'JACKET',
  started: true,
  revisions: [
    { id: REV3.id, revision: 3, review: 'WAITING', notice: { ref: 'Demo notice v2', at: at(11, 12, 9) }, photos: [photo(1), photo(2, { view: 'SIDE', deleteAfter: at(12, 31, 23) }), photo(3, { view: 'BACK', status: 'PENDING_UPLOAD' })] },
    { id: REV2.id, revision: 2, review: 'NEED_MORE', notice: { ref: 'Demo notice v1', at: at(10, 2, 9) }, photos: [photo(4, { view: 'DETAIL', deleteAfter: `${TODAY}T08:00:00.000Z` })] },
  ],
  fittings: [{ resultId: RESULT_ID, fittedAt: at(11, 4, 15, 40), verdict: 'ALTER', revision: 2, photos: [photo(5, { category: 'FITTING_PHOTO', view: 'SIDE', by: { id: uid('3333', 8), name: 'Demo Fitter' } })] }],
  may: { upload: true, uploadFitting: true, date: true, dateFitting: true },
}
const OFF: PhotosView = { ...PHOTOS, started: false, may: { ...PHOTOS.may, upload: false, uploadFitting: false } }
const EMPTY: PhotosView = { ...PHOTOS, revisions: [], fittings: [] }

const base = (recordScreen.cases.find((one) => one.id === 'photos') ?? recordScreen.cases[0]!).model as DesignModel
const photosModel = (over: Partial<OfficePhotosModel> = {}, role: RoleCase = 'owner'): OfficePhotosModel => ({ photos: PHOTOS, problem: null, dialog: null, notice: null, today: TODAY, can: canFor(role), offline: false, ...over })
const shown = (over: Partial<OfficePhotosModel> = {}, record: Partial<ProfileRecordModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: { ...base.model, can: canFor(role), tab: 'photos', photos: photosModel(over, role), ...record },
})
const demoFile = (): File | null => (typeof File === 'undefined' ? null : new File([new Uint8Array(48_000)], 'demo.jpg', { type: 'image/jpeg' }))

function PhotosDesign({ model: design }: { model: DesignModel }) {
  const [model, setModel] = useState(design.model)
  useEffect(() => setModel(design.model), [design])
  const photos = model.photos ?? photosModel()
  const setDialog = (dialog: PhotoDialog | null) => setModel((now) => ({ ...now, photos: { ...photos, dialog } }))
  return inShell(
    `/sales/made-to-measure/${RECORD.id}`,
    createElement(ProfileRecordView, {
      model,
      actions: {
        photos: {
          onUpload: (target) => setDialog({ kind: 'upload', target, view: 'FRONT', file: null, deleteOn: '', busy: false, notice: null }),
          onDate: (target, picked) => setDialog({ kind: 'date', target, photo: picked, day: TODAY, reason: '', busy: false, notice: null }),
          onOpen: (picked) => setDialog({ kind: 'open', photo: picked, src: PHOTO_SRC, problem: null }),
          onDraft: (patch) => setModel((now) => (now.photos?.dialog ? { ...now, photos: { ...now.photos, dialog: { ...now.photos.dialog, ...patch } as PhotoDialog } } : now)),
          onClose: () => setDialog(null),
          onSave: () => setModel((now) => ({ ...now, photos: { ...photos, dialog: null, notice: { key: 'photo.upload.done', tone: 'success' } } })),
          onDismiss: () => setModel((now) => ({ ...now, photos: { ...photos, notice: null } })),
        },
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-036-photos',
  title: 'Rider profile › Photos taken in the office and at fittings (made-to-measure)',
  view: PhotosDesign,
  cases: [
    { id: 'office', label: 'Photos: by link (revision 2), in the office (revisions 3 and 2) and at a fitting, each with its delete date', model: shown(), note: 'Revision 3: front (deleted 90 days after shipping), side (a day), back not arrived yet. Revision 2: a detail deleted within the hour.' },
    { id: 'upload', label: 'Add a photo: held until a photo is picked', model: shown({ dialog: { kind: 'upload', target: { kind: 'profile', id: REV3.id }, view: 'FRONT', file: null, deleteOn: '', busy: false, notice: null } }) },
    { id: 'upload-picked', label: 'Add a photo: the side, a photo picked, deleted on a day given', model: shown({ dialog: { kind: 'upload', target: { kind: 'profile', id: REV3.id }, view: 'SIDE', file: demoFile(), deleteOn: '2027-02-15', busy: false, notice: null } }) },
    { id: 'upload-refused', label: 'Add a photo: refused in words (twelve photos already)', model: shown({ dialog: { kind: 'upload', target: { kind: 'profile', id: REV3.id }, view: 'BACK', file: demoFile(), deleteOn: '', busy: false, notice: { key: 'photo.upload.full', tone: 'danger' } } }) },
    { id: 'date', label: 'Change the delete date: a later day, with why', model: shown({ dialog: { kind: 'date', target: { kind: 'profile', id: REV3.id }, photo: PHOTOS.revisions[0]!.photos[1]!, day: '2027-01-31', reason: 'The rider asked to keep it until the remake (demo).', busy: false, notice: null } }) },
    { id: 'date-today', label: 'Change the delete date: today (deleted within the hour), held until why is typed', model: shown({ dialog: { kind: 'date', target: { kind: 'profile', id: REV3.id }, photo: PHOTOS.revisions[0]!.photos[0]!, day: TODAY, reason: '', busy: false, notice: null } }) },
    { id: 'open', label: 'A photo opened (its stripped copy, the opening recorded)', model: shown({ dialog: { kind: 'open', photo: PHOTOS.revisions[0]!.photos[0]!, src: PHOTO_SRC, problem: null } }) },
    { id: 'added', label: 'A photo added (the receipt)', model: shown({ notice: { key: 'photo.upload.done', tone: 'success' } }) },
    { id: 'off', label: 'Made-to-measure off for JACKET (as built): Add held, said with where it starts', model: shown({ photos: OFF }, { loaded: { status: 'ready', record: RECORD_OFF } }) },
    { id: 'production', label: 'Production manager: adds no photo to a revision (held why), dates fitting photos', model: shown({ photos: { ...PHOTOS, may: { upload: false, uploadFitting: true, date: false, dateFitting: true } } }, {}, 'production') },
    { id: 'empty', label: 'No photo taken in the office yet', model: shown({ photos: EMPTY }) },
    { id: 'reading', label: 'Reading the photos', model: shown({ photos: null }) },
    { id: 'failed', label: 'The read failed (Try again)', model: shown({ photos: null, problem: 'problem.unavailable' }) },
    { id: 'offline', label: 'Offline: Add and Delete date held', model: shown({ offline: true }, { live: 'offline' }) },
    { id: 'fittings', label: 'Fittings tab: a fitting’s photos on its card, Add a photo of the fitting', model: shown({}, { tab: 'fittings' }) },
  ],
})
