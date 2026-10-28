import { LinkFrameView } from '../../../../shell/links/view/LinkFrameView'

/**
 * `/privacy/<company id>` — the privacy-notice slot (GAP-005, GDPR art. 13/14): one notice per company, linked from
 * every link page and every email footer (factory-domain `privacyNoticeUrl`). The notice's text is a company setting
 * that B-W1-36 fills in; until then the page says it is not published here yet and whom to ask.
 */
export default async function PrivacyNoticePage({ params }: { params: Promise<{ company: string }> }) {
  const { company } = await params
  return <LinkFrameView model={{ sender: { name: '', companyId: decodeURIComponent(company) }, title: null, body: { kind: 'privacy', notice: null } }} />
}
