import FamilyEditorLoader from './FamilyEditorLoader'

export const dynamic = 'force-dynamic'

export default async function FamilyEditorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  // Data loads in FamilyEditorLoader (client-side): the API session cookie
  // lives on the API origin, so server-side fetches can never authenticate —
  // they 401'd and made this page notFound() for everyone in prod.
  return <FamilyEditorLoader familyId={id} />
}
