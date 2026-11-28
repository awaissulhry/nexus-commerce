import { PeopleRoute } from '../../../../../portal/customer/people/PeopleRoute'

/**
 * `/p/<party code>/people` — People › Your people (owb-po4.3; order workflow plan § 5 "Customer portal"): the customer's own people,
 * their roles and what each does, and the factory's people for the brand. The frame (the layout) comes with it.
 */
export default function PortalPeoplePage() {
  return <PeopleRoute />
}
