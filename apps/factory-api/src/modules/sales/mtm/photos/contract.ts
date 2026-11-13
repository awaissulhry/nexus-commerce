import { defineContract, id, input } from '@nexus/factory-domain/core/contracts'
import { announcedView, completedView, datedView, deleteOnBody, openedView, photoBody, photosView } from '@nexus/factory-domain/sales/mtm-photos/contracts'

/** Made-to-measure office photos' contracts (B-W2b-371): the bodies and answers are factory-domain's sales/mtm-photos/contracts. */

const profile = input({ profileId: id() })
const profileFile = input({ profileId: id(), fileId: id() })
const result = input({ resultId: id() })
const resultFile = input({ resultId: id(), fileId: id() })

export const listPhotosContract = defineContract({ params: profile, response: { 200: photosView } })
export const announceProfilePhotoContract = defineContract({ params: profile, body: photoBody, response: { 201: announcedView } })
export const completeProfilePhotoContract = defineContract({ params: profileFile, response: { 200: completedView } })
export const announceFittingPhotoContract = defineContract({ params: result, body: photoBody, response: { 201: announcedView } })
export const completeFittingPhotoContract = defineContract({ params: resultFile, response: { 200: completedView } })
export const openPhotoContract = defineContract({ params: input({ fileId: id() }), response: { 200: openedView } })
export const dateProfilePhotoContract = defineContract({ params: profileFile, body: deleteOnBody, response: { 200: datedView } })
export const dateFittingPhotoContract = defineContract({ params: resultFile, body: deleteOnBody, response: { 200: datedView } })
