import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * Templates (apps/factory-api platform/templates; B-W2b-422; PLT-231, PLT-232, COL-016; design admin.documents "Document
 * templates", "E-mail templates", the builder page "Template: …"; the send panel's message template).
 *
 *   documents.templates.manage   write, publish and retire a company's document templates (header, terms, footer, the optional
 *                                columns) and its e-mail templates (subject and body per event), or every company's e-mail
 *                                templates (then over every active company); delete a draft. Checked with can() against the
 *                                company.
 *   email.replies.share          keep the saved replies shared with the office (write, change, delete them). Checked with can()
 *                                against the reply's company (every active company for one of every company).
 *
 * Reading the templates is documents.view (the documents' look, beside the letterhead preview and the branding); a person's
 * own saved replies are email.send (whoever writes mail keeps their own and uses the shared ones).
 */
export const DOCUMENT_TEMPLATES_DEFINITIONS = definePermissions('documents', {
  'templates.manage': {
    risk: 'write',
    description: "Write, publish and retire a company's document templates (header, terms, footer, columns shown) and e-mail templates (subject and body per event and language).",
  },
})

export const SAVED_REPLIES_DEFINITIONS = definePermissions('email', {
  'replies.share': {
    risk: 'write',
    description: 'Keep the saved replies shared with the office: write, change and delete them.',
  },
})

export const DOCUMENT_TEMPLATES_MANAGE = 'documents.templates.manage' satisfies Permission
export const EMAIL_REPLIES_SHARE = 'email.replies.share' satisfies Permission

export const TEMPLATES_PERMISSIONS: readonly Permission[] = Object.freeze([DOCUMENT_TEMPLATES_MANAGE, EMAIL_REPLIES_SHARE])

/**
 * The role templates that get them (owner: every()): the administrator keeps the templates and the shared replies (the
 * design names no other role; a custom role may add the shared replies to sales or the buyer).
 */
export const TEMPLATES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [DOCUMENT_TEMPLATES_MANAGE, EMAIL_REPLIES_SHARE],
})
