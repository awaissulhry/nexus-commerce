#!/usr/bin/env python3
"""PCO-3 through PCO-6 planning/baseline mutations. AUTHOR ONLY until the main session runs it.

Both controls must pass before a source mutation. PCO-0's push, assertion-only
failure and foreign-edit guards are reused unchanged. Backups, reports and logs
remain in a unique /private/tmp directory; stdout is the JSON-lines evidence.
"""

import os
import json
from pathlib import Path
import runpy
import signal
import sys
import tempfile


helpers = runpy.run_path(str(Path(__file__).with_name("mutate-pco0.py")), run_name="pco0_helpers")
ROOT = helpers["ROOT"]
Mutation = helpers["Mutation"]
emit, sha = helpers["emit"], helpers["sha"]
wait_for_push, check_files, run_tests = helpers["wait_for_push"], helpers["check_files"], helpers["run_tests"]
GROUPS = json.loads(r'''{
  "selection": [
    "apps/api/src/services/pim/studio-publication-selection.vitest.test.ts"
  ],
  "plan": [
    "apps/api/src/services/pim/studio-publication-plan.vitest.test.ts"
  ],
  "service": [
    "apps/api/src/services/pim/studio-publication.vitest.test.ts",
    "apps/api/src/services/pim/studio-publication-database.vitest.test.ts"
  ],
  "web": [
    "apps/web/src/app/products/[id]/edit/_studio/publication/model.vitest.test.ts",
    "apps/web/src/app/products/[id]/edit/_studio/publication/PublicationChanges.vitest.test.ts",
    "apps/web/src/design-system/components/ChangeReview.vitest.test.ts"
  ],
  "ebay": [
    "apps/api/src/services/pim/studio-publication-ebay-changes.vitest.test.ts",
    "apps/api/src/services/channel-drift/ebay-content-compare.vitest.test.ts",
    "apps/api/src/services/pim/studio-publication-transports.vitest.test.ts"
  ],
  "amazon": [
    "apps/api/src/services/pim/studio-publication-amazon-changes.vitest.test.ts",
    "apps/api/src/services/amazon/mapping-payload.vitest.test.ts",
    "apps/api/src/services/pim/mapping/schema-requirements.vitest.test.ts",
    "apps/api/src/services/pim/studio-publication-baseline.vitest.test.ts"
  ],
  "baseline-proof": [
    "apps/api/src/services/pim/studio-publication-baseline.vitest.test.ts"
  ]
}''')
MUTATIONS = [(group, Mutation(**value)) for group, value in json.loads(r'''[
  [
    "selection",
    {
      "name": "submit-accepts-stale-token",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "if (sparse && (typeof input.selectionToken !== 'string' || input.selectionToken !== data.selection?.token))",
      "new": "if (false)",
      "test": "refuses submission without the exact stored selection token"
    }
  ],
  [
    "selection",
    {
      "name": "selection-loses-cas",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "changes: { equals: operation.changes! }",
      "new": "",
      "test": "does not overwrite a selection committed by another request during compilation"
    }
  ],
  [
    "selection",
    {
      "name": "submit-loses-selection-cas",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "changes: { equals: originalChanges }",
      "new": "",
      "test": "checks the current selection again when claiming a submission"
    }
  ],
  [
    "selection",
    {
      "name": "selection-loses-actor",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "export async function previewStudioPublicationSelection(productId: string, id: string, body: unknown, userId: string | null): Promise<StudioPublishSelection> {\n  const operation = await prisma.bulkOperation.findFirst({ where: { id, userId } })",
      "new": "export async function previewStudioPublicationSelection(productId: string, id: string, body: unknown, userId: string | null): Promise<StudioPublishSelection> {\n  const operation = await prisma.bulkOperation.findFirst({ where: { id } })",
      "test": "refuses foreign users, products, expired and in-flight selection requests"
    }
  ],
  [
    "selection",
    {
      "name": "selection-ignores-expiry",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "if (!operation.expiresAt || operation.expiresAt.getTime() <= Date.now()) throw new WorkspaceScopeError('This publication review expired. Review the current values again.')",
      "new": "if (false) throw new WorkspaceScopeError('This publication review expired. Review the current values again.')",
      "test": "refuses foreign users, products, expired and in-flight selection requests"
    }
  ],
  [
    "selection",
    {
      "name": "submit-allows-empty",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "if (!compiled.prepared || !compiled.selection.fieldCount || !compiled.selection.products.length)",
      "new": "if (false)",
      "test": "previews an empty selection but refuses a send without selected work"
    }
  ],
  [
    "selection",
    {
      "name": "review-forgets-baseline",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "publicationDigest([facts.revision, changePlan ?? prepared, baselineRevision, mode, overwrite])",
      "new": "publicationDigest([facts.revision, changePlan ?? prepared, mode, overwrite])",
      "test": "refuses changed baseline before sending a previously selected payload"
    }
  ],
  [
    "selection",
    {
      "name": "submit-ignores-compiled-payload",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "if (publicationDigest(compiled) !== data.selectionDigest)",
      "new": "if (false)",
      "test": "refuses changed compiled before sending a previously selected payload"
    }
  ],
  [
    "selection",
    {
      "name": "journal-forgets-intent",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "writes: amazon.fieldWrites?.[products[0].productId] ?? []",
      "new": "writes: []",
      "test": "sends only the selected product and records explicit field intent separately from the exact request"
    }
  ],
  [
    "selection",
    {
      "name": "payload-depends-on-json-key-order",
      "path": "apps/api/src/services/pim/studio-publication-selection.ts",
      "old": "value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value",
      "new": "value",
      "test": "keeps selected JSON payload stable when stored plan object keys are reordered"
    }
  ],
  [
    "plan",
    {
      "name": "closed-products-still-send",
      "path": "apps/api/src/services/pim/studio-publication-plan.ts",
      "old": "const included = selected.filter(p => !closed.has(`${p.id}|${scope.marketplace}`))",
      "new": "const included = selected",
      "test": "skips and names a closed Amazon product before resolving its fields, retaining the open child and parent identity"
    }
  ],
  [
    "plan",
    {
      "name": "existing-content-blocked-by-stock",
      "path": "apps/api/src/services/pim/studio-publication-plan.ts",
      "old": "if (existing && ['AMAZON', 'EBAY'].includes(scope.channel) && ['Pricing', 'Inventory'].includes(cell.sourceOwner?.label ?? '')) continue",
      "new": "if (false) continue",
      "test": "keeps new-listing offer requirements but does not block existing"
    }
  ],
  [
    "selection",
    {
      "name": "shopify-existing-full-write-allowed",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "if (preview.remote || facts.listings.some(listing => listing.externalListingId))",
      "new": "if (false)",
      "test": "blocks existing remote Shopify products even if Nexus has no external listing ID"
    }
  ],
  [
    "web",
    {
      "name": "selection-accepts-another-review",
      "path": "apps/web/src/app/products/[id]/edit/_studio/publication/model.ts",
      "old": "selection.reviewId !== review.id",
      "new": "false",
      "test": "binds a selection response to the exact current review, eligible fields and product set"
    }
  ],
  [
    "web",
    {
      "name": "selection-accepts-wrong-owner",
      "path": "apps/web/src/app/products/[id]/edit/_studio/publication/model.ts",
      "old": "review.changes.filter(c => selectedIds.includes(c.id)).some(c => !selection.products.some(p => p.productId === c.productId && p.sku === c.sku))",
      "new": "false",
      "test": "binds a selection response to the exact current review, eligible fields and product set"
    }
  ],
  [
    "web",
    {
      "name": "unknown-becomes-cleared",
      "path": "apps/web/src/app/products/[id]/edit/_studio/publication/PublicationChanges.tsx",
      "old": "if (value.state === 'unknown') return `Unknown — ${value.reason}`",
      "new": "if (value.state === 'unknown') return 'Cleared / absent'",
      "test": "keeps missing evidence, a deletion, null and empty text distinct"
    }
  ],
  [
    "web",
    {
      "name": "count-ineligible-selections",
      "path": "apps/web/src/app/products/[id]/edit/_studio/publication/PublicationChanges.tsx",
      "old": "changes.filter(c => c.selectable && selectedIds.includes(c.id))",
      "new": "changes.filter(c => selectedIds.includes(c.id))",
      "test": "keeps unchanged evidence available and never counts unknown or refused rows as selected"
    }
  ],
  [
    "web",
    {
      "name": "refused-row-shows-selected",
      "path": "apps/web/src/design-system/components/ChangeReview.tsx",
      "old": "checked={item.selectable && selected.has(item.id)}",
      "new": "checked={selected.has(item.id)}",
      "test": "never shows an ineligible row as selected and locks all choices during submission"
    }
  ],
  [
    "web",
    {
      "name": "refused-row-is-enabled",
      "path": "apps/web/src/design-system/components/ChangeReview.tsx",
      "old": "disabled={disabled || !item.selectable}",
      "new": "disabled={disabled}",
      "test": "associates each named checkbox with its reason and labels all comparison values"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-loses-preserved-aspects",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "const specifics = { ...plan.liveSpecifics }",
      "new": "const specifics = {}",
      "test": "merges a selected aspect with live unselected siblings and records only that intent"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-xml-order-depends-on-storage",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "Object.entries(specifics).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)",
      "new": "Object.entries(specifics)",
      "test": "serializes the same exact XML after JSONB reorders every object while preserving gallery sequence"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-loses-field-intent",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "writes.push({ field: change.field, value: change.current })",
      "new": "void writes",
      "test": "merges a selected aspect with live unselected siblings and records only that intent"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-adopts-unsent-child",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "liveSkus.has(product.sku)",
      "new": "true",
      "test": "does not adopt a locally linked child whose SKU is absent from the live item"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-records-unsent-create-fields",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "input.current.state === 'value' && !input.field.startsWith('content:')",
      "new": "input.current.state === 'value'",
      "test": "does not claim that an unsupported child field was sent by atomic creation"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-unread-values-selectable",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "publication.itemId && !live ? { refusal: readError }",
      "new": "false ? { refusal: readError }",
      "test": "keeps failed live reads unknown and refuses to assemble a blind replacement collection"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-forgets-clear-collection",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "deleted.push('<DeletedField>Item.ItemSpecifics</DeletedField>')",
      "new": "deleted.push('')",
      "test": "deletes one optional aspect without deleting siblings, and uses DeletedField for an empty set"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-invocation-in-wrong-place",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "plan.xml.replace(/(<ReviseFixedPriceItemRequest\\b[^>]*>)/, `$1<InvocationID>${key}</InvocationID>`)",
      "new": "plan.xml.replace('<Item>', `<Item><InvocationID>${key}</InvocationID>`)",
      "test": "puts revise InvocationID at request level and create UUID inside Item, using the same final builder"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-forgets-sku-tracking-mode",
      "path": "apps/api/src/services/channel-drift/ebay-content-compare.ts",
      "old": "const publicationRoots = ['SKU', 'InventoryTrackingMethod', 'Title',",
      "new": "const publicationRoots = ['SKU', 'Title',",
      "test": "retains GetItem tracking mode in the real stable projection used by preparation and compilation"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-content-includes-offers",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "!OUT_OF_SCOPE_ROOTS.has(root) && root !== '$create'",
      "new": "root !== '$create'",
      "test": "one changed child/root produces one PATCH and journals only that explicit intent, excluding price and stock"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-create-loses-language-intent",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "field: amazonContentField(root, plan.publication.marketplaceId, tag), value:",
      "new": "field: root, value:",
      "test": "folds accepted DE-only and EN-only intents independently and keeps the EN baseline after a DE clear"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-replace-drops-unselected-language",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "value: clone([...desired, ...preserved])",
      "new": "value: clone(desired)",
      "test": "preserves another remote language in a root replacement without adopting it into the intent baseline"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-clear-without-language-selector",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "if (!attributeSelectorKeys(spec, root).includes('language_tag'))",
      "new": "if (false)",
      "test": "refuses a language clear when the category selectors cannot isolate that language"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-blank-without-authored-intent",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "cell.provenance === 'override'",
      "new": "cell.provenance !== 'missing'",
      "test": "blank resolver values as authored clears"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-ignores-selected-ids",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "const selected = selectPublicationChanges(plan.changes, selectedIds)",
      "new": "const selected = selectPublicationChanges(plan.changes, plan.changes.filter(change => change.selectable).map(change => change.id))",
      "test": "no accepted baseline shows differences unticked, and no selected IDs submits no messages"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-accepts-wrong-remote-sku",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "typeof raw.sku === 'string' && raw.sku !== product.sku",
      "new": "false",
      "test": "refuses conflicting provider SKU or marketplace identity in the live response"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-revision-ignores-remote-content",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "attributes: readError ? null : contentOnly(object(raw.attributes))",
      "new": "attributes: null",
      "test": "binds revision to live content including preserved language values, but ignores live price/stock"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-exceeds-read-concurrency",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "Math.min(5, prepared.products.length)",
      "new": "Math.min(6, prepared.products.length)",
      "test": "bounds concurrent reads for a 21-SKU family and retains original SKU order"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-delete-uses-default-selectors",
      "path": "apps/api/src/services/amazon/mapping-payload.ts",
      "old": "attributeDeleteValue(spec, root, deleteInstances)",
      "new": "attributeDeleteValue(spec, root)",
      "test": "clears only the explicitly observed selector instances instead of a schema default language"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-creates-over-existing-sku",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "confirmedAbsent = response.sku === product.sku && response.asin === null && response.status === null && response.rawResponse === undefined && response.error === undefined",
      "new": "confirmedAbsent = true",
      "test": "refuses atomic creation when the supposedly new seller SKU already exists on Amazon"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-revision-ignores-creation",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "observations[index] = { sku: product.sku, newListing: true, confirmedAbsent, error: refusal }",
      "new": "observations[index] = { sku: product.sku, newListing: true, confirmedAbsent: true, error: null }",
      "test": "binds confirmed new-SKU absence into the remote revision so later creation invalidates review"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-create-order-depends-on-storage",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "Object.entries(message.attributes ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap<StudioPublishFieldWrite>",
      "new": "Object.entries(message.attributes ?? {}).flatMap<StudioPublishFieldWrite>",
      "test": "compiles identical new-listing intent order after JSONB reverses every object key"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-omission-becomes-deletion",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "authoredClears.has(key)",
      "new": "true",
      "test": "does not infer an aspect deletion from an omitted previously accepted value"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-empty-without-authored-intent",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "cell.provenance === 'override'",
      "new": "true",
      "test": "does not treat an unauthored or invalid empty resolver cell as an aspect clear"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-wrong-store-allows-delete",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "store.path[0] !== 'itemSpecifics'",
      "new": "false",
      "test": "does not use a blank field from another store path to authorize an aspect deletion"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-create-adopts-unsent-deletion",
      "path": "apps/api/src/services/pim/studio-publication-ebay-changes.ts",
      "old": "input.current.state === 'value' && !input.field.startsWith('content:')",
      "new": "input.current.state !== 'unknown' && !input.field.startsWith('content:')",
      "test": "does not record an omitted empty aspect as a deletion sent by atomic creation"
    }
  ],
  [
    "ebay",
    {
      "name": "ebay-receipt-accepts-wrong-item",
      "path": "apps/api/src/services/pim/studio-publication-ebay.ts",
      "old": "if (ebayXmlText(item.ItemID) !== itemId) throw new Error('eBay returned a different or unidentified listing.')",
      "new": "if (false) throw new Error('eBay returned a different or unidentified listing.')",
      "test": "does not accept another eBay item or status markup embedded inside its description"
    }
  ],
  [
    "baseline-proof",
    {
      "name": "baseline-erases-untouched-language",
      "path": "apps/api/src/services/pim/studio-publication-baseline.ts",
      "old": "for (const row of rows) {",
      "new": "for (const row of rows) {\n        values.clear()",
      "test": "folds scoped Amazon language intents independently and never adopts preserved remote companions"
    }
  ],
  [
    "selection",
    {
      "name": "review-hides-variation-warning",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "if (changePlan.kind === 'amazon-changes' && changePlan.changes.some(change => change.field === 'variation_theme' && change.status !== 'SAME'",
      "new": "if (false && changePlan.changes.some(change => change.field === 'variation_theme' && change.status !== 'SAME'",
      "test": "warns when an existing Amazon variation theme would change"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-large-family-starves-later-skus",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "const readBudgetMs = 9_500 * Math.max(1, Math.ceil(prepared.products.length / 21))",
      "new": "const readBudgetMs = 9_500",
      "test": "lets a healthy 50-SKU family finish all reads without starving its later products"
    }
  ],
  [
    "amazon",
    {
      "name": "baseline-drops-accepted-draft",
      "path": "apps/api/src/services/pim/studio-publication-baseline.ts",
      "old": "facts.listings.filter(listing => included.has(listing.productId)\n",
      "new": "facts.listings.filter(listing => included.has(listing.productId) && listing.externalListingId\n",
      "test": "retains accepted field history while a newly created listing awaits its local external ID"
    }
  ],
  [
    "amazon",
    {
      "name": "amazon-recreates-accepted-draft",
      "path": "apps/api/src/services/pim/studio-publication-amazon-changes.ts",
      "old": "?.externalListingId && !previouslyPublished.has(product.productId)",
      "new": "?.externalListingId",
      "test": "uses accepted history for a new listing awaiting local identity instead of sending another full UPDATE"
    }
  ],
  [
    "selection",
    {
      "name": "review-labels-accepted-draft-new",
      "path": "apps/api/src/services/pim/studio-publication.service.ts",
      "old": "if (product.newListing === false) existingProducts.add(product.productId)",
      "new": "if (false) existingProducts.add(product.productId)",
      "test": "labels an accepted Amazon creation as existing while its local ASIN is still pending"
    }
  ]
]''')]

def main():
    global GROUPS, MUTATIONS
    if len(sys.argv) > 1:
        if len(sys.argv) != 3 or sys.argv[1] != '--groups':
            raise RuntimeError('Use --groups followed by comma-separated declared group names.')
        selected = set(sys.argv[2].split(','))
        if not selected or selected - GROUPS.keys():
            raise RuntimeError('An unknown mutation group was requested.')
        GROUPS = {key: value for key, value in GROUPS.items() if key in selected}
        MUTATIONS = [(group, mutant) for group, mutant in MUTATIONS if group in selected]
    if os.environ.get("ALLOW_PROD_DB_TESTS") == "1":
        raise RuntimeError("Refusing ALLOW_PROD_DB_TESTS=1; API tests keep their local database guard.")
    run_dir = Path(tempfile.mkdtemp(prefix="nexus-pco3-6-mutations-", dir="/private/tmp"))
    backup_dir = run_dir / "backups"
    paths = sorted({m.path for _, m in MUTATIONS} | {p for tests in GROUPS.values() for p in tests}
                   | {"packages/shared/src/studio-publication.ts", "packages/database/prisma/schema.prisma",
                      "packages/database/prisma/baseline.sql", "docs/publish-changes-only/tools/mutate-pco0.py"})
    originals = {path: (ROOT / path).read_bytes() for path in paths}
    for path, content in originals.items():
        backup = backup_dir / path
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_bytes(content)
        if sha(backup.read_bytes()) != sha(content):
            raise RuntimeError(f"Backup verification failed: {backup}")
    emit("backups", directory=str(backup_dir), sha256={path: sha(value) for path, value in originals.items()})
    for _, mutant in MUTATIONS:
        found = originals[mutant.path].decode().count(mutant.old)
        if found != 1:
            raise RuntimeError(f"{mutant.name}: expected one original anchor, found {found}; no source touched.")
    emit("anchors_validated", count=len(MUTATIONS), mutants=[m.name for _, m in MUTATIONS])
    env = {**os.environ, "NEXUS_DISABLE_BACKGROUND_JOBS": "1", "NO_COLOR": "1"}
    env.pop("FORCE_COLOR", None)
    results, active, error, outcome = [], None, None, "failed"

    def restore():
        nonlocal active
        if active is None:
            return
        path, mutated = active
        emit("prediction", action="restore", path=path, expected_sha256=sha(originals[path]))
        wait_for_push()
        current = (ROOT / path).read_bytes()
        if current not in (mutated, originals[path]):
            raise RuntimeError(f"Concurrent edit to {path}; refusing restoration. Original backup: {backup_dir / path}")
        if current != originals[path]:
            (ROOT / path).write_bytes(originals[path])
        if sha((ROOT / path).read_bytes()) != sha(originals[path]):
            raise RuntimeError(f"SHA-256 restoration failed for {path}; backup: {backup_dir / path}")
        active = None
        emit("restored", path=path, sha256=sha(originals[path]))

    try:
        for group, tests in GROUPS.items():
            check_files(originals, backup_dir)
            emit("prediction", action="green_control", group=group, expected="all tests pass")
            control = run_tests(f"{group}-control", "web" if group == "web" else "api", tests, run_dir, env)
            results.append({"name": f"{group}-control", **control})
            emit("control", group=group, **control)
            if control["exit_code"] != 0 or control["failed"] or not control["success"]:
                raise RuntimeError(f"{group} control is not green; no mutations attempted.")
        emit("all_controls_green", groups=list(GROUPS), next="temporary source mutations")
        for group, mutant in MUTATIONS:
            emit("prediction", action="mutate", mutant=mutant.name, expected_assertion=mutant.test)
            wait_for_push()
            check_files(originals, backup_dir)
            mutated = originals[mutant.path].decode().replace(mutant.old, mutant.new, 1).encode()
            active = (mutant.path, mutated)
            try:
                (ROOT / mutant.path).write_bytes(mutated)
                expected = {**originals, mutant.path: mutated}
                check_files(expected, backup_dir)
                result = run_tests(mutant.name, "web" if group == "web" else "api", GROUPS[group], run_dir, env)
                check_files(expected, backup_dir)
                killed = (result["exit_code"] == 1 and result["failed"] > 0 and not result["success"]
                          and any(mutant.test in name for name in result["failures"]))
                results.append({"name": mutant.name, "killed": killed, **result})
                emit("mutation", name=mutant.name, killed=killed, **result)
                if not killed:
                    raise RuntimeError(f"{mutant.name}: survived or failed outside its named behavioral assertion.")
            finally:
                restore()
        check_files(originals, backup_dir)
        outcome = "passed"
    except (Exception, KeyboardInterrupt) as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        try:
            restore()
        except (Exception, KeyboardInterrupt) as exc:
            error = f"{error or ''}; restoration blocked: {exc}"
            outcome = "failed"
        restored = {path: (ROOT / path).is_file() and sha((ROOT / path).read_bytes()) == sha(content)
                    for path, content in originals.items()}
        if not all(restored.values()):
            outcome = "failed"
        emit("summary", outcome=outcome, error=error, backups=str(backup_dir),
             killed=sum(r.get("killed", False) for r in results), planned=len(MUTATIONS),
             originals_sha256={path: sha(value) for path, value in originals.items()}, restored=restored, results=results)
    return 0 if outcome == "passed" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, helpers["interrupted"])
    try:
        sys.exit(main())
    except Exception as exc:
        emit("fatal", error=f"{type(exc).__name__}: {exc}")
        sys.exit(1)
