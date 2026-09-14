# GALE Amazon IT import and publication repair

The Modello worksheet imports existing GALE listings into the current product studio. The pilot is limited to the parent and 20 children in Amazon IT. The original workbook SHA-256 is `e7c929ecaaa2db75eadba39b4f54d0dbf1c882a7ec75ec766a162272b9049ac5`.

## Application changes

- Preserve declared ASIN references through native workbook mapping and Amazon attribute serialization.
- Convert Amazon's scalar search terms to the canonical keyword array on write and back to a scalar on read/export. Reimport comparison uses the same representation.
- Route dictionary-defined localized fields through the content writer, matching the studio's language pins.
- Refresh readiness for the edited account and market inside the import transaction; shared edits still refresh the complete family.
- Bind structured apparel sizes to the Size axis. Publication collision checks use resolved channel values rather than legacy shared sizes.
- Recover existing Amazon brand, condition and list price from their saved attribute envelopes. Respect fields Amazon marks immutable on existing listings.
- Keep existing Amazon gallery images during partial content updates unless an explicit gallery selection was saved. A shared library is not a selected channel gallery.
- Recognize safety-image documentation without inventing an attestation. Empty optional lists produce no invalid empty Amazon envelope.
- Read all requested Amazon listing sections using its comma-separated query format and the selected account's region. Listing issues remain visible on successful GET responses.
- Preserve structured Amazon HTTP validation errors; clear attributes using schema selector values instead of deleting by name alone.
- Keep the condition attribute outside the price envelope, serialize saved RRP, and retain the variation relationship type when substituting the selected parent's seller SKU.

## Data repair

The 13 COAT-specific mappings absent from the current category schema were removed through the mapping service with a saved revision. All were empty on this family. The missing-schema guard remains enforced.

Amazon's response for each exact seller SKU confirmed these two workbook identities; the scoped listing links were corrected with version checks and audit records:

| Seller SKU | Previous ASIN | Confirmed ASIN |
| --- | --- | --- |
| GALE-JACKET-BLACK-MEN-XXS | B0DJ4926YX | B0H7W8PH1F |
| GALE-JACKET-YELLOW-MEN-XXS | B0DJ44CDWP | B0H7VXR9XT |

The complete publication-facts resolver then reported zero local issues for all 21 products. This does not establish Amazon acceptance or storefront visibility.

## Verification

Targeted importer, content, schema, variation, readiness and publication regressions pass (401 tests, one existing skip across the selected suites). API TypeScript checking passes. Repository pre-push gates and deployment verification are performed separately.

## Channel evidence requiring follow-up

Amazon's existing listing responses report issue `100230` for safety image PS05 across the family: alleged offensive text, with the image attribute suppressed. The supplied PS05 is a scanned safety booklet; no replacement, safety attestation or responsible-person contact has been invented. The workbook and current Amazon attributes provide no manufacturer/responsible-person contact. [Amazon's media API documentation](https://developer-docs.amazon/sp-api/docs/submit-media) limits programmatic image variants to MAIN, PT01–PT08 and SWCH; safety-image follow-up remains in Seller Central. Channel validation and a processing receipt are required before reporting the family as published.

The workbook's EUR 99 selling prices are managed by the dedicated pricing workflow, not the generic catalog importer. FBA inventory remains under its existing owner.
