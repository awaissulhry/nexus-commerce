/**
 * The portal's addresses the API hands out (B-W2b-167; design portal.frame "/p/<party code>/… — every portal page sits in this
 * frame", "Each row is a link to the record and tab", the e-mail footer's "Manage e-mails"). The web's portal frame
 * (B-W2b-173) serves them: `open/<type>/<id>` sends the person to the record's page of their kind (or Home when the record
 * has no page yet), the anchor selects the tab or row (`task:<id>`); `?dialog=email-settings` opens the E-mail settings. A
 * person who is not signed in signs in first and lands here (B-W2b-159: the deep link is the web's).
 */

const base = (webOrigin: string, partyCode: string): string => `${webOrigin.replace(/\/+$/, '')}/p/${encodeURIComponent(partyCode)}`

export const portalHomeUrl = (webOrigin: string, partyCode: string): string => base(webOrigin, partyCode)

export const portalRecordUrl = (webOrigin: string, partyCode: string, recordType: string, recordId: string, anchor: string | null = null): string =>
  `${base(webOrigin, partyCode)}/open/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`

export const portalEmailSettingsUrl = (webOrigin: string, partyCode: string): string => `${base(webOrigin, partyCode)}?dialog=email-settings`

/** The same record address without the origin, for the API's answers (the web is on the same origin as the portal). */
export const portalRecordPath = (partyCode: string, recordType: string, recordId: string, anchor: string | null = null): string =>
  portalRecordUrl('', partyCode, recordType, recordId, anchor)
