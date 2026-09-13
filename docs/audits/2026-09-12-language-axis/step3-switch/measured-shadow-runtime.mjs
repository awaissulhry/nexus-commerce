// apps/api/src/services/pim/master-field-gate.ts
var ALLOWED_MASTER_FIELDS = /* @__PURE__ */ new Set([
  "sku",
  // editable from master-data tab; uniqueness validated below
  "name",
  "description",
  // D.5: ZIP upload + grid editing
  "basePrice",
  "costPrice",
  "minMargin",
  "minPrice",
  "maxPrice",
  "totalStock",
  "lowStockThreshold",
  "brand",
  "manufacturer",
  "upc",
  "ean",
  "weightValue",
  // D.3j: weight/dim units + dim values
  "weightUnit",
  "dimLength",
  "dimWidth",
  "dimHeight",
  "dimUnit",
  // D.3k: master-level GTIN
  "gtin",
  "status",
  "fulfillmentChannel",
  // CC.1 — master Amazon productType. Drives the schema-driven
  // attribute set; per-listing override stays in
  // platformAttributes.productType (Q.5).
  "productType",
  // W1.4 — master long-form content + keyword tags. bulletPoints
  // and keywords are string[] columns on Product; the validator
  // below accepts both an array of strings and a JSON-string
  // payload (the bulk-ops grid pastes it as JSON, the master
  // editor sends it as an array).
  "bulletPoints",
  "keywords",
  // W1.4 — Italian fiscal / customs fields. hsCode is the
  // tariff classification (digit string) used by customs
  // declarations; countryOfOrigin is the ISO-2 alpha code used
  // on commercial invoices and Amazon attributes. Both flow
  // through PATCH /api/products/bulk so the master editor and
  // bulk-ops paste workflows share the same validator.
  "hsCode",
  "countryOfOrigin",
  // W7.1 — EU compliance: PPE directive category + ADR/IATA hazmat
  "ppeCategory",
  "hazmatClass",
  "hazmatUnNumber",
  // C4 — structured CE/PPE protective-gear data
  "garmentClass",
  "notifiedBodyNumber",
  "notifiedBodyName",
  "declarationOfConformityUrl",
  "impactProtectors",
  // GTIN.3 / Step 4 variant flow — the list-wizard's "promote to
  // parent" action PATCHes isParent=true and "link variant to
  // parent" PATCHes parentId. Both write into Product directly;
  // the wizard owned this surface but hit "Field not editable"
  // because the bulk allowlist didn't include them.
  "isParent",
  "parentId"
]);

// apps/api/src/services/pim/content-locale.ts
import { createHash } from "node:crypto";

// apps/api/src/services/pim/content-language.ts
import { normalizeLanguage, languageEntry } from "@nexus/shared/content-language";

// apps/api/src/services/pim/variant-attribute-keys.ts
function canonicalVariantAxis(value) {
  const key = value.toLowerCase().replace(/[\s_-]/g, "");
  return {
    colore: "color",
    colour: "color",
    farbe: "color",
    couleur: "color",
    taglia: "size",
    taille: "size",
    talla: "size",
    gr\u00F6\u00DFe: "size",
    groesse: "size",
    stylename: "style"
  }[key] ?? key;
}

// apps/api/src/services/pim/content-resolver.ts
var contentResolverEnabled = () => (process.env.NEXUS_CONTENT_RESOLVER ?? "v2") === "v2";
var translationMissing = (content, requested) => content.language !== normalizeLanguage(requested);
var contentField = (field2) => field2 === "name" ? "title" : field2;
var present = (value) => value !== void 0 && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
var workspace = (row) => row.workspaceId ?? null;
var label = (language) => new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
var primary = () => normalizeLanguage(PRIMARY_CONTENT_LOCALE);
function sourceValue(product, parent, field2) {
  const column4 = CONTENT_COLUMNS[field2];
  for (const owner of [product, parent]) {
    if (!owner) continue;
    if (!column4 && Object.prototype.hasOwnProperty.call(owner.categoryAttributes ?? {}, field2) && owner.categoryAttributes?.[field2] !== void 0) return { value: owner.categoryAttributes[field2], owner };
    let value = column4 ? owner[column4] : owner.categoryAttributes?.[field2];
    if (!column4 && !present(value)) {
      const variations = owner.categoryAttributes?.variations;
      const bag = { ...owner.variantAttributes ?? {}, ...variations && typeof variations === "object" && !Array.isArray(variations) ? variations : {} };
      value = bag[field2];
      if (value === void 0 && ["color", "size", "style"].includes(field2)) {
        const aliases = Object.entries(bag).filter(([key, value2]) => canonicalVariantAxis(key) === field2 && value2 !== void 0);
        if (new Set(aliases.map(([, value2]) => JSON.stringify(value2))).size > 1) throw new Error(`Conflicting source variant attributes for ${field2}`);
        value = aliases[0]?.[1];
      }
      if (value !== void 0) return { value, owner };
    }
    if (present(value)) return { value, owner };
  }
  return null;
}
function contentSourceHash(product, parent, localizableKeys = []) {
  const fields = [.../* @__PURE__ */ new Set([...Object.keys(CONTENT_COLUMNS), ...localizableKeys.map(contentField)])].sort();
  return contentHash(Object.fromEntries(fields.map((field2) => [field2, sourceValue(product, parent, field2)?.value ?? null])));
}
function translationIndex(rows = []) {
  const index = /* @__PURE__ */ new Map();
  const groups4 = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const language = normalizeLanguage(row.language);
    groups4.set(language, [...groups4.get(language) ?? [], row]);
  }
  for (const [language, group] of groups4) {
    const canonical = group.filter((row) => row.language === language);
    const candidates = canonical.length ? canonical : group;
    if (candidates.length !== 1) throw new Error(`Ambiguous content translations for ${language}`);
    index.set(language, candidates[0]);
  }
  return index;
}
function coordinateMatches(a, b) {
  return a.channel === b.channel && a.market === b.market && (a.accountId ?? null) === (b.accountId ?? null) && (a.aliasId ?? null) === (b.aliasId ?? null);
}
function translationValue(row, field2) {
  if (!row) return void 0;
  const column4 = CONTENT_COLUMNS[field2];
  return column4 ? row[column4] : row.attributes?.[field2];
}
function legacyPin(listing, field2) {
  const columns = {
    title: ["titleOverride", "title", "followMasterTitle"],
    description: ["descriptionOverride", "description", "followMasterDescription"],
    bulletPoints: ["bulletPointsOverride", null, "followMasterBulletPoints"]
  };
  const spec2 = columns[field2];
  if (!spec2) return void 0;
  if (listing[spec2[2]] !== true && present(listing[spec2[0]])) return listing[spec2[0]];
  return spec2[1] ? listing[spec2[1]] : void 0;
}
function resolver(input) {
  if (!contentResolverEnabled()) throw new Error("Content resolver v2 is disabled.");
  const { product, parent, listing, localizableKeys = [] } = input;
  if (parent && (product.parentId !== parent.id || workspace(parent) !== workspace(product))) throw new Error("Content parent does not belong to this product/workspace.");
  if (listing && (listing.productId !== product.id || workspace(listing) !== workspace(product))) throw new Error("Content listing does not belong to this product/workspace.");
  const owners = [product, parent].filter((owner) => !!owner);
  const translations = owners.map((owner) => translationIndex((owner.translations ?? []).filter((row) => workspace(row) === workspace(owner) && (!row.productId || row.productId === owner.id))));
  const pins = translationIndex((listing?.translations ?? []).filter((row) => workspace(row) === workspace(product) && (!row.channelListingId || row.channelListingId === listing?.id)));
  const sourceLanguage = primary();
  const hashes = /* @__PURE__ */ new Map();
  const allowed = /* @__PURE__ */ new Set([...Object.keys(CONTENT_COLUMNS), ...localizableKeys.map(contentField)]);
  return (fieldInput, address, computed) => {
    const field2 = contentField(fieldInput), requested = normalizeLanguage(address.requested);
    if (!allowed.has(field2)) throw new Error(`Field ${field2} is not declared localizable.`);
    const result = (value, tier, language, member, from) => ({ value, tier, language, requested, provenance: { member, from } });
    const translated = (row, value, tier, owner) => {
      const source2 = String(row.source ?? "manual").startsWith("ai") ? "ai" : row.source ?? "manual";
      const reviewedAt = row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null;
      if (row.sourceHash && !hashes.has(owner.id)) hashes.set(owner.id, contentSourceHash(owner, owner === product ? parent : null, localizableKeys));
      const outdated = !!row.sourceHash && row.sourceHash !== hashes.get(owner.id);
      const machine = source2 === "ai" || source2 === "translated";
      const member = outdated ? machine && !reviewedAt ? "aiStale" : "outdated" : machine && !reviewedAt ? "ai" : tier === "pin" ? "pinned" : address.coordinate || owner !== product ? "inherited" : "own";
      return { ...result(value, tier, requested, member, tier === "pin" ? listing.id : `${label(requested)} \xB7 shared`), ownerId: owner.id, translation: { source: source2, reviewedAt, outdated } };
    };
    if (address.coordinate && listing) {
      if (!coordinateMatches(listing.coordinate, address.coordinate)) throw new Error("Content listing coordinate does not match the requested address.");
      if (!listing.languages.length) throw new Error("Content listing needs its market languages.");
      const pin = pins.get(requested), value = translationValue(pin, field2);
      if (present(value)) return translated(pin, value, "pin", product);
      if (requested === normalizeLanguage(listing.languages[0])) {
        const legacy = legacyPin(listing, field2);
        if (present(legacy)) {
          const flag = { title: "followMasterTitle", description: "followMasterDescription", bulletPoints: "followMasterBulletPoints" }[field2];
          const follows = flag ? listing[flag] !== false : false;
          return { ...result(legacy, "pin", requested, follows ? "inherited" : "pinned", listing.id), follows, drift: follows, ownerId: product.id };
        }
      }
    }
    if (requested !== sourceLanguage) for (const [i, owner] of owners.entries()) {
      const row = translations[i].get(requested), value = translationValue(row, field2);
      if (present(value)) return translated(row, value, "language", owner);
    }
    const source = sourceValue(product, parent, field2);
    if (source) return { ...result(source.value, "source", sourceLanguage, address.coordinate || requested !== sourceLanguage || source.owner !== product ? "inherited" : "own", `${label(sourceLanguage)} \xB7 source`), ownerId: source.owner.id };
    if (computed && present(computed.value)) return { ...result(computed.value, "computed", normalizeLanguage(computed.language), computed.provenance.member, computed.provenance.from) };
    return result(null, "computed", sourceLanguage, "inherited", null);
  };
}
function resolveContent(input) {
  return resolver(input)(input.field, input.address, input.computed);
}
function contentPathAddress(path, requested, localizableKeys = []) {
  const parts = path.replace(/\{locale\}/g, requested).split(".");
  let language = requested;
  if (parts[0] === "localizedContent") {
    parts.shift();
    language = parts.shift() ?? "";
  } else if (["categoryAttributes", "variantAttributes"].includes(parts[0])) parts.shift();
  const field2 = contentField(parts.shift() ?? "");
  if (![...Object.keys(CONTENT_COLUMNS), ...localizableKeys].includes(field2)) return null;
  return { field: field2, requested: normalizeLanguage(language), tail: parts };
}
function resolveContentPath(input) {
  const path = contentPathAddress(input.path, input.address.requested, input.localizableKeys);
  if (!path) return null;
  const resolved = resolveContent({ ...input, field: path.field, address: { ...input.address, requested: path.requested } });
  let value = resolved.value;
  for (const key of path.tail) value = value && typeof value === "object" ? value[key] ?? null : null;
  return { ...resolved, value };
}
function resolveContentBatch(input) {
  return input.members.flatMap((member) => {
    const resolve = resolver(member);
    return input.addresses.map((address) => ({ productId: member.product.id, address: { ...address, requested: normalizeLanguage(address.requested) }, fields: Object.fromEntries(input.fields.map((field2) => [field2, resolve(field2, address)])) }));
  });
}

// apps/api/src/services/pim/content-read.ts
function contentLanguages(product, parent) {
  return [.../* @__PURE__ */ new Set([PRIMARY_CONTENT_LOCALE, ...[product, parent].flatMap((owner) => (owner?.translations ?? []).map((row) => normalizeLanguage(row.language)))])];
}
function contentKeys(product, parent, declared = []) {
  return [.../* @__PURE__ */ new Set([...Object.keys(CONTENT_COLUMNS), ...declared, ...[product, parent].flatMap((owner) => (owner?.translations ?? []).flatMap((row) => Object.keys(row.attributes ?? {})))])];
}
function contentListing(product, listing, coordinate, languages) {
  if (!listing) return null;
  const address = coordinate ?? listing.coordinate ?? (listing.channel && (listing.marketplace || listing.region) ? {
    channel: listing.channel,
    market: !listing.marketplace || listing.marketplace === "DEFAULT" ? listing.region : listing.marketplace,
    ...listing.channelConnectionId ? { accountId: listing.channelConnectionId } : {},
    ...listing.aliasId || listing.aliasKey ? { aliasId: listing.aliasId ?? listing.aliasKey } : {}
  } : void 0);
  const ordered = languages ?? listing.languages;
  if (!address || !ordered?.length) throw new Error("Content listing reads require a coordinate and hydrated Marketplace.languages.");
  return {
    id: listing.id,
    productId: listing.productId ?? product.id,
    workspaceId: listing.workspaceId,
    coordinate: address,
    languages: ordered,
    translations: listing.translations,
    title: listing.title,
    description: listing.description,
    titleOverride: listing.titleOverride,
    descriptionOverride: listing.descriptionOverride,
    bulletPointsOverride: listing.bulletPointsOverride,
    followMasterTitle: listing.followMasterTitle,
    followMasterDescription: listing.followMasterDescription,
    followMasterBulletPoints: listing.followMasterBulletPoints
  };
}
function contentAttribute(content, productId, parentId) {
  const source = content.tier === "pin" ? content.follows ? "channelSnapshot" : "channelExplicit" : content.tier === "language" ? parentId ? "variantLocale" : "masterLocale" : content.tier === "source" ? "masterColumn" : "default";
  const translationState = translationMissing(content, content.requested) ? "fallback" : content.translation?.outdated ? "outdated" : content.translation?.reviewedAt ? "reviewed" : content.translation && content.translation.source !== "manual" ? "draft" : "current";
  return {
    value: content.value,
    source,
    inheritedFrom: content.tier === "pin" ? content.provenance.from : content.ownerId ?? productId,
    requestedLocale: content.requested,
    effectiveLocale: content.language,
    language: content.language,
    requested: content.requested,
    translationState,
    tier: content.tier,
    follows: content.follows,
    drift: content.drift,
    contentProvenance: content.provenance
  };
}
function resolveContentAttributes(input) {
  const listing = contentListing(input.product, input.listing, input.coordinate, input.languages);
  const fields = contentKeys(input.product, input.parent, input.localizableKeys);
  const resolved = resolveContentBatch({ members: [{
    product: input.product,
    parent: input.parent,
    listing,
    localizableKeys: fields
  }], fields, addresses: [{ requested: input.requested, ...listing ? { coordinate: listing.coordinate } : input.coordinate ? { coordinate: input.coordinate } : {} }] })[0].fields;
  return Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, contentAttribute(value, input.product.id, input.product.parentId)]));
}
function contentWireValue(value, shape) {
  return shape === "list" && value == null ? [] : value;
}
function listingContentState(listing, requested, field2, localizableKeys = []) {
  if (!listing.product) throw new Error("Listing content requires its hydrated product and translations.");
  const owner = listing.product;
  const hydrated = contentListing(owner, listing);
  return resolveContent({
    product: owner,
    parent: owner.parent,
    listing: hydrated,
    localizableKeys,
    field: field2,
    address: { requested: normalizeLanguage(requested), coordinate: hydrated.coordinate }
  });
}

// apps/api/src/services/pim/content-locale.ts
var PRIMARY_CONTENT_LOCALE = normalizeLanguage(process.env.NEXUS_PRIMARY_LANGUAGE ?? "it");
var CONTENT_COLUMNS = { title: "name", description: "description", bulletPoints: "bulletPoints", keywords: "keywords" };
var contentHash = (value) => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
function sourceContent(product, key, locale = PRIMARY_CONTENT_LOCALE) {
  return resolveContent({ product, parent: product.parent, field: key, localizableKeys: [key], address: { requested: normalizeLanguage(locale) } }).value;
}

// apps/api/src/services/pim/attribute-resolver.ts
var SSOT_FIELDS = [
  { key: "title", followFlag: "followMasterTitle", overrideCol: "titleOverride", directCol: "title" },
  { key: "description", followFlag: "followMasterDescription", overrideCol: "descriptionOverride", directCol: "description" },
  { key: "price", followFlag: "followMasterPrice", overrideCol: "priceOverride", directCol: "price" },
  { key: "quantity", followFlag: "followMasterQuantity", overrideCol: "quantityOverride", directCol: "quantity" },
  { key: "bulletPoints", followFlag: "followMasterBulletPoints", overrideCol: "bulletPointsOverride", directCol: null }
];
var SYNTHESIS_MAP = [
  { resolverKey: "brand", column: "brand" },
  { resolverKey: "manufacturer", column: "manufacturer" },
  { resolverKey: "basePrice", column: "basePrice" }
];
function applyLayer(acc, layer, source, inheritedFrom, locale) {
  if (!layer || typeof layer !== "object") return;
  for (const [key, value] of Object.entries(layer)) {
    if (value === void 0) continue;
    if (locale && key.startsWith("_")) continue;
    acc[key] = { value, source, inheritedFrom, ...locale ? { requestedLocale: locale, effectiveLocale: locale, translationState: "current" } : {} };
  }
}
function applyVariantLayer(acc, product) {
  const variations = product.categoryAttributes?.variations;
  const bag = {
    ...product.variantAttributes && typeof product.variantAttributes === "object" ? product.variantAttributes : {},
    ...variations && typeof variations === "object" && !Array.isArray(variations) ? variations : {}
  };
  applyLayer(acc, bag, "variant", product.id);
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return;
  for (const axis of ["color", "size", "style"]) {
    if (Object.prototype.hasOwnProperty.call(bag, axis) && bag[axis] !== void 0) continue;
    const matches = Object.entries(bag).filter(([key, value]) => canonicalVariantAxis(key) === axis && value !== void 0);
    if (!matches.length) continue;
    const conflict = new Set(matches.map(([, value]) => JSON.stringify(value))).size > 1;
    acc[axis] = {
      value: conflict ? null : matches[0][1],
      source: "variant",
      inheritedFrom: product.id,
      ...conflict ? { warnings: [`Conflicting variant attributes supply ${axis}: ${matches.map(([key]) => key).join(", ")}. Set the canonical ${axis} attribute to resolve the conflict.`] } : {}
    };
  }
}
function applySynthesisLayer(acc, source, locale) {
  for (const { resolverKey, column: column4 } of SYNTHESIS_MAP) {
    const value = source[column4];
    if (value === void 0 || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    acc[resolverKey] = {
      value,
      source: "masterColumn",
      inheritedFrom: `${source.id}:${column4}`,
      ...["title", "description", "bulletPoints", "keywords"].includes(resolverKey) ? { requestedLocale: locale, effectiveLocale: PRIMARY_CONTENT_LOCALE, translationState: locale === PRIMARY_CONTENT_LOCALE ? "current" : "fallback" } : {}
    };
  }
}
function applyCanonicalFacts(acc, product) {
  for (const key of ALLOWED_MASTER_FIELDS) {
    if (["description", "bulletPoints", "keywords"].includes(key)) continue;
    let value = product[key];
    if (value === void 0 || value === null || value === "" || Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && typeof value.toNumber === "function") value = value.toNumber();
    acc[key] = { value, source: "masterColumn", inheritedFrom: product.id };
  }
}
function resolveAttributes(input) {
  const { product, parent, channelListing, synthesize = true } = input;
  const locale = normalizeLanguage(input.locale ?? PRIMARY_CONTENT_LOCALE);
  const acc = {};
  for (const owner of [parent, product]) {
    if (!owner) continue;
    if (synthesize) applySynthesisLayer(acc, owner, locale);
    if (owner === product) applyVariantLayer(acc, product);
    applyLayer(acc, owner.categoryAttributes, owner === product && parent ? "variant" : "master", owner.id);
    if (synthesize) applyCanonicalFacts(acc, owner);
    if (owner.countryOfOrigin) applyLayer(acc, { countryOfOrigin: owner.countryOfOrigin, country_of_origin: owner.countryOfOrigin }, "masterColumn", owner.id);
  }
  if (synthesize) {
    const origin = acc.countryOfOrigin ?? acc.country_of_origin;
    if (origin) {
      acc.countryOfOrigin = origin;
      acc.country_of_origin = origin;
    }
  }
  if (channelListing) {
    applyLayer(acc, channelListing.overrideData, "channelOverride", channelListing.id);
    for (const ssot of SSOT_FIELDS.filter((field2) => ["price", "quantity"].includes(field2.key))) {
      if (channelListing[ssot.followFlag] !== false) continue;
      const value = channelListing[ssot.overrideCol] ?? (ssot.directCol ? channelListing[ssot.directCol] : void 0);
      if (value !== void 0) acc[ssot.key] = { value, source: "channelExplicit", inheritedFrom: channelListing.id };
    }
  }
  Object.assign(acc, resolveContentAttributes({
    product,
    parent,
    listing: channelListing,
    coordinate: input.coordinate,
    languages: input.marketLanguages,
    requested: locale,
    localizableKeys: input.localizableKeys
  }));
  return acc;
}

// readonly:refuse-db
var refuse_db_default = new Proxy({}, { get() {
  throw new Error("Application DB access forbidden in shadow");
} });

// apps/api/src/services/pim/market-languages.ts
var marketCode = (code) => code.toUpperCase() === "GB" ? "UK" : code.toUpperCase();
function marketLanguages(channel, code, rows) {
  const coordinate = { channel: channel.toUpperCase(), code: marketCode(code) };
  const read = (row) => {
    const values = row?.languages?.length ? [...row.languages] : row?.language ? [normalizeLanguage(row.language)] : [];
    if (!values.length) throw new Error(`No content languages configured for ${coordinate.channel}/${coordinate.code}.`);
    return [...new Set(values.map(normalizeLanguage))];
  };
  if (rows) return read(rows.find((row) => row.channel === coordinate.channel && row.code === coordinate.code));
  return refuse_db_default.marketplace.findFirst({ where: coordinate, select: { languages: true, language: true } }).then(read);
}

// apps/api/src/services/etsy/information-content.ts
var ETSY_CONTENT_FIELDS = /* @__PURE__ */ new Set(["title", "description", "tags"]);
function etsyContentState(listing, locale, field2) {
  if (!listing || !ETSY_CONTENT_FIELDS.has(field2)) return null;
  const resolved = listingContentState(listing, locale, field2 === "tags" ? "keywords" : field2);
  return { ...contentAttribute(resolved, listing.productId), needsTranslation: translationMissing(resolved, locale) };
}

// apps/api/src/services/shopify/listing-information-plan.ts
import { emptyShopifyLinkedDraft, validateShopifyField, shopifyDefinitionApplicability } from "@nexus/shared/shopify-linked-products";
import { nativeFieldKeys, nativeFieldValueError } from "@nexus/shared/shopify-information";

// apps/api/src/services/pim/channel-specs/store.ts
import { informationRegistry, nativeTranslationKeys, shopifyMappingFieldKey } from "@nexus/shared/shopify-information";

// apps/api/src/services/pim/channel-specs/etsy-listing-schema.ts
var etsyListingSchema = {
  source: "https://www.etsy.com/openapi/generated/oas/3.0.0.json",
  verifiedAt: "2026-09-10",
  listing: { type: "object", properties: {
    "listing_id": { "type": "integer", "minimum": 1 },
    "user_id": { "type": "integer", "minimum": 1 },
    "shop_id": { "type": "integer", "minimum": 1 },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "rich_description": { "type": "string", "nullable": true },
    "state": { "type": "string", "enum": ["active", "inactive", "sold_out", "draft", "expired"] },
    "creation_timestamp": { "type": "integer", "minimum": 946684800 },
    "created_timestamp": { "type": "integer", "minimum": 946684800 },
    "ending_timestamp": { "type": "integer", "minimum": 946684800 },
    "original_creation_timestamp": { "type": "integer", "minimum": 946684800 },
    "last_modified_timestamp": { "type": "integer", "minimum": 946684800 },
    "updated_timestamp": { "type": "integer", "minimum": 946684800 },
    "state_timestamp": { "type": "integer", "nullable": true, "minimum": 946684800 },
    "quantity": { "type": "integer", "minimum": 0 },
    "shop_section_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "featured_rank": { "type": "integer" },
    "url": { "type": "string" },
    "num_favorers": { "type": "integer", "minimum": 0 },
    "non_taxable": { "type": "boolean" },
    "is_taxable": { "type": "boolean" },
    "is_customizable": { "type": "boolean" },
    "is_personalizable": { "type": "boolean" },
    "listing_type": { "type": "string", "enum": ["physical", "download", "both"] },
    "tags": { "type": "array", "items": { "type": "string" } },
    "materials": { "type": "array", "items": { "type": "string" } },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "processing_min": { "type": "integer", "nullable": true, "minimum": 0 },
    "processing_max": { "type": "integer", "nullable": true, "minimum": 0 },
    "who_made": { "type": "string", "nullable": true, "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "nullable": true, "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "is_supply": { "type": "boolean", "nullable": true },
    "item_weight": { "type": "number", "nullable": true },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["oz", "lb", "g", "kg"] },
    "item_length": { "type": "number", "nullable": true },
    "item_width": { "type": "number", "nullable": true },
    "item_height": { "type": "number", "nullable": true },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "is_private": { "type": "boolean" },
    "style": { "type": "array", "items": { "type": "string" } },
    "file_data": { "type": "string", "nullable": true },
    "has_variations": { "type": "boolean" },
    "should_auto_renew": { "type": "boolean" },
    "language": { "type": "string", "nullable": true },
    "price": { "type": "money" },
    "converted_price": { "type": "money" },
    "taxonomy_id": { "type": "integer", "nullable": true },
    "readiness_state_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "suggested_title": { "type": "string", "nullable": true }
  } },
  create: { type: "object", required: ["quantity", "title", "description", "price", "who_made", "when_made", "taxonomy_id"], properties: {
    "quantity": { "type": "integer" },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "price": { "type": "number" },
    "who_made": { "type": "string", "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "taxonomy_id": { "type": "integer", "minimum": 1 },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "materials": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "shop_section_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "processing_min": { "type": "integer", "nullable": true },
    "processing_max": { "type": "integer", "nullable": true },
    "readiness_state_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "tags": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "styles": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "item_weight": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_length": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_width": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_height": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["oz", "lb", "g", "kg"] },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "production_partner_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "image_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "is_supply": { "type": "boolean" },
    "is_customizable": { "type": "boolean" },
    "should_auto_renew": { "type": "boolean" },
    "is_taxable": { "type": "boolean" },
    "type": { "type": "string", "enum": ["physical", "download", "both"] }
  } },
  update: { type: "object", properties: {
    "image_ids": { "type": "array", "items": { "type": "integer", "minimum": 1 } },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "materials": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "should_auto_renew": { "type": "boolean" },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "shop_section_id": { "type": "integer", "nullable": true },
    "item_weight": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_length": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_width": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_height": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["", "oz", "lb", "g", "kg"] },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["", "in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "is_taxable": { "type": "boolean" },
    "taxonomy_id": { "type": "integer", "minimum": 1 },
    "tags": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "who_made": { "type": "string", "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "featured_rank": { "type": "integer", "nullable": true },
    "state": { "type": "string", "enum": ["active", "inactive"] },
    "is_supply": { "type": "boolean" },
    "production_partner_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "type": { "type": "string", "nullable": true, "enum": ["physical", "download", "both"] }
  } }
};

// apps/api/src/services/pim/channel-specs/etsy.ts
var groups = ["Content", "Classification", "Search", "Offer", "Shipping", "Policies", "Listing status", "Category attributes"].map((label3, order) => ({ key: label3.toLowerCase().replace(/ /g, "_"), label: label3, channelLabel: null, order }));
var column = (column4, followFlag) => ({ kind: "listingColumn", column: column4, followFlag });
var titleStore = column("title", "followMasterTitle");
var descriptionStore = column("description", "followMasterDescription");
var native = etsyListingSchema.listing.properties;
var create = etsyListingSchema.create.properties;
var update = etsyListingSchema.update.properties;

// apps/api/src/services/pim/channel-specs/store.ts
var groups2 = ["Content", "Classification", "Search", "Offer", "Shipping", "Policies"].map((label3, order) => ({ key: label3.toLowerCase(), label: label3, channelLabel: null, order }));
var pa = (...path) => ({ kind: "platformAttributes", path });
var column2 = (column4, followFlag) => ({ kind: "listingColumn", column: column4, followFlag });
function field(key, label3, group, extra = {}) {
  return {
    key,
    attribute: key,
    path: [],
    label: label3,
    englishLabel: label3,
    kind: "text",
    shape: "scalar",
    cardinality: { min: 0, max: 1 },
    requirement: "optional",
    requiredInParent: false,
    editable: true,
    hidden: false,
    variantEligible: false,
    group: groups2.find((g) => g.key === group),
    channelStore: pa(key),
    ...extra
  };
}
var titleStore2 = column2("title", "followMasterTitle");
var descriptionStore2 = column2("description", "followMasterDescription");
function shopifyProductSpec(schema = null, accountId, locale) {
  if (schema && !accountId) throw new Error("A Shopify definition requires its connected store identity.");
  if (locale) locale = normalizeLanguage(locale);
  const primaryTag = schema?.locales.find((l) => l.primary)?.locale;
  const primaryLocale = primaryTag ? normalizeLanguage(primaryTag) : void 0;
  const translationLocale = locale && locale !== "und" && primaryLocale && locale !== primaryLocale ? locale : null;
  if (translationLocale && !schema?.locales.some((l) => normalizeLanguage(l.locale) === translationLocale)) throw new Error("This language is not enabled in the selected Shopify store.");
  const native3 = {
    title: { masterKey: "name", requirement: "required", channelStore: titleStore2 },
    descriptionHtml: { masterKey: "description", channelStore: descriptionStore2 },
    vendor: { masterKey: "brand", channelStore: { kind: "platformAttributes", path: ["vendor"], legacyPaths: [["shopifyVendor"]] } },
    productType: { masterKey: "shopify_product_type", channelStore: { kind: "platformAttributes", path: ["productType"], legacyPaths: [["shopifyProductType"]] } },
    price: { masterKey: "basePrice", channelStore: column2("price", "followMasterPrice"), validation: { minimum: 0 } },
    cost: { masterKey: "costPrice", validation: { minimum: 0 } },
    sku: { defaultRule: { source: "sku" } },
    countryCodeOfOrigin: { masterKey: "countryOfOrigin", validation: { pattern: "^[A-Z]{2}$" } },
    harmonizedSystemCode: { masterKey: "hsCode" },
    weight: {
      shape: "measure",
      kind: "number",
      unitOptions: ["g", "kg", "oz", "lb"],
      defaultRule: { source: "weightValue", transforms: [{ type: "expr", expr: 'measure($weightValue, $weightUnit, "g|kg|oz|lb")' }] }
    },
    compareAtPrice: { validation: { minimum: 0 }, channelStore: { kind: "platformAttributes", path: ["compareAtPrice"], legacyPaths: [["shopifyCompareAtPrice"]] } },
    inventoryPolicy: { kind: "select", mode: "strict", options: schema?.native?.enums.inventoryPolicy?.map((choice) => choice.name) ?? [] },
    category: { validation: { pattern: "^gid://shopify/TaxonomyCategory/[a-zA-Z0-9-]+$" } },
    handle: { validation: { pattern: "^[a-zA-Z0-9-]+$" } },
    tags: { validation: { uniqueItems: true }, maxLength: 255 }
  };
  const fields = informationRegistry(schema).flatMap((info) => {
    const key = shopifyMappingFieldKey(info, accountId ?? "");
    const baseType = info.type.replace(/^list\./, "");
    const kind = ["number_integer", "number_decimal", "money"].includes(baseType) ? "number" : baseType === "boolean" ? "boolean" : ["date", "date_time"].includes(baseType) ? "date" : ["multi_line_text_field", "rich_text_field", "json"].includes(baseType) ? "longtext" : "text";
    const group = {
      key: info.group.toLowerCase().replace(/ /g, "_"),
      label: info.group,
      channelLabel: null,
      order: ["General", "Publishing", "Pricing", "Inventory", "Shipping", "SEO", "Metafields", "Category Metafields"].indexOf(info.group)
    };
    const entry = field(key, info.label, "content", {
      attribute: info.id,
      kind,
      group,
      shopifyField: info,
      shape: info.cardinality,
      cardinality: { min: 0, max: info.cardinality === "list" ? null : 1 },
      variantEligible: info.owner === "PRODUCTVARIANT",
      channelStore: info.definition ? pa("metafields", info.owner, info.definition.namespace, info.definition.key, info.type) : pa(...info.id.split(".")),
      helpText: info.definition ? `${info.owner === "PRODUCT" ? "Product" : "Variant"} \xB7 ${info.source}. ${info.definition.description ?? ""}`.trim() : [info.channelLabel !== info.label ? `Shopify: ${info.channelLabel}.` : "", info.reason].filter(Boolean).join(" ") || void 0,
      // Media and stock require a published Shopify resource; their native workspace
      // owns exact file and stocking-location identities after publication.
      readOnlyReason: info.reason ?? (info.id === "media" ? "Use the media workspace to manage product media." : void 0),
      editable: !info.reason,
      ...native3[info.id] ?? {}
    });
    if (translationLocale) {
      const translatable = info.definition ? ["single_line_text_field", "multi_line_text_field", "rich_text_field", "json", "url", "link", "list.single_line_text_field", "list.url", "list.link"].includes(info.type) : !!nativeTranslationKeys[info.id];
      const reason = info.reason ?? (!translatable ? "Shopify shares this field across languages. Select the store\u2019s primary language to edit its base value." : !schema?.native?.scopes.includes("write_translations") ? "This Shopify connection needs write_translations permission." : void 0);
      entry.channelStore = pa("_shopifyInformationLocales", translationLocale, info.id);
      entry.readOnlyReason = reason;
      entry.editable = !reason;
      entry.shopifyField = { ...info, reason };
      entry.helpText = `${translationLocale} translation. Clearing restores the primary-language value. Shopify translatability is verified against the created resource before synchronization.`;
    }
    return info.id === "inventory" ? [{ key: "availableQuantity", label: "Available quantity" }, { key: "onHandQuantity", label: "On hand quantity" }].map((quantity) => ({
      ...entry,
      ...quantity,
      englishLabel: quantity.label,
      attribute: quantity.key,
      kind: "number",
      channelStore: pa(quantity.key),
      editable: false,
      readOnlyReason: "This draft has no Shopify inventory item or stocking locations. Publish it, then edit inventory by location in Shopify Information."
    })) : [entry];
  });
  const result = spec("SHOPIFY", fields);
  result.groups = [...new Map(fields.map((f) => [f.group.key, f.group])).values()];
  result.schemaVersion = schema?.revision ?? "shopify-native-mapping-2026-09-10";
  result.validationSchema = void 0;
  return result;
}
function spec(channel, fields) {
  const properties = Object.fromEntries(fields.map((f) => {
    const scalar = {
      type: f.kind === "number" ? "number" : f.kind === "boolean" ? "boolean" : "string",
      ...f.options ? { enum: f.options } : {},
      ...f.maxLength ? { maxLength: f.maxLength } : {},
      ...Object.fromEntries(Object.entries(f.validation ?? {}).filter(([key]) => key !== "uniqueItems"))
    };
    return [f.attribute, f.shape === "list" ? {
      type: "array",
      items: scalar,
      ...f.cardinality.max !== null ? { maxItems: f.cardinality.max } : {},
      ...f.validation?.uniqueItems ? { uniqueItems: true } : {}
    } : scalar];
  }));
  return {
    channel,
    marketplace: "GLOBAL",
    category: "*",
    fields,
    validationSchema: { type: "object", properties, required: fields.filter((f) => f.requirement === "required").map((f) => f.attribute) },
    groups: groups2.filter((g) => fields.some((f) => f.group?.key === g.key)),
    fetchedAt: null,
    schemaVersion: "product-information-2026-09-08",
    coverage: Object.fromEntries(fields.map((f) => [f.attribute, [f.key]])),
    unrecognised: [],
    absent: false
  };
}

// apps/api/src/services/pim/sheet-values.ts
function isBlankValue(v) {
  if (v === null || v === void 0) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.every(isBlankValue);
  if (typeof v === "object") {
    const m = v;
    if ("value" in m || "unit" in m) return isBlankValue(m.value);
    return Object.keys(v).length === 0;
  }
  return false;
}
function readListValue(raw) {
  if (raw === null || raw === void 0) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") return null;
    if (t.startsWith("[")) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
      } catch {
      }
    }
    return [raw];
  }
  return [raw];
}
function readMeasureValue(raw) {
  if (raw === null || raw === void 0 || raw === "") return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const m = raw;
    const value = m.value === null || m.value === void 0 || m.value === "" ? null : Number(m.value);
    const unit = typeof m.unit === "string" && m.unit ? m.unit : null;
    if (value === null && unit === null) return null;
    return { value: value !== null && Number.isFinite(value) ? value : null, unit };
  }
  const n = Number(raw);
  return Number.isFinite(n) ? { value: n, unit: null } : null;
}
function projectCellValue(col, base) {
  if (col.slot) {
    const list = readListValue(base);
    if (!list) return null;
    const item = list[col.slot.index - 1];
    return item === void 0 || item === null || item === "" ? null : item;
  }
  if (col.shape === "list") {
    const list = readListValue(base);
    if (!list) return null;
    const kept = list.filter((v) => !isBlankValue(v));
    return kept;
  }
  if (col.shape === "measure") return readMeasureValue(base);
  return base === void 0 ? null : base;
}
function readPath(bag, path) {
  let cur = bag;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return void 0;
    cur = cur[p];
  }
  return cur;
}

// apps/api/src/services/pim/channel-inheritance.ts
var CHANNEL_OVERRIDE_COLUMNS = {
  title: "titleOverride",
  description: "descriptionOverride",
  price: "priceOverride",
  quantity: "quantityOverride"
};
function readStoredChannelValue(store, listing, overrideKeys = []) {
  if (!listing || typeof listing !== "object") return void 0;
  const row = listing;
  if (store?.kind === "listingColumn") {
    if (store.followFlag && row[store.followFlag] !== false) return void 0;
    const override = CHANNEL_OVERRIDE_COLUMNS[store.column];
    return override ? row[override] ?? row[store.column] : row[store.column];
  }
  if (store?.kind === "platformAttributes") {
    const value = readPath(row.platformAttributes, store.path);
    if (value !== void 0) return value;
  }
  const bag = row.overrideData;
  if (bag && typeof bag === "object" && !Array.isArray(bag)) {
    for (const key of overrideKeys) if (Object.prototype.hasOwnProperty.call(bag, key)) return bag[key];
  }
  if (store?.kind === "platformAttributes") for (const path of store.legacyPaths ?? []) {
    const value = readPath(row.platformAttributes, path);
    if (value !== void 0) return value;
  }
  return void 0;
}

// apps/api/src/services/pim/channel-value-mutation.ts
function storedChannelState(listing, store, keys) {
  const value = readStoredChannelValue(store, listing, keys);
  if (value === void 0) return { state: "inherited", value: null };
  const unitPath = store?.kind === "platformAttributes" ? store.unitPath : void 0;
  return { state: "stored", value: unitPath && value !== null ? { value, unit: readPath(listing.platformAttributes, unitPath) ?? null } : value };
}

// apps/api/src/services/shopify/listing-information-plan.ts
function informationContentState(listing, spec2, locale) {
  const product = listing.product;
  if (!product) throw new Error("Shopify content requires hydrated product translations.");
  const key = contentField(spec2.masterKey ?? spec2.key);
  if (!contentKeys(product, product.parent).includes(key)) return storedChannelState(listing, spec2.channelStore, [spec2.masterKey ?? spec2.key, spec2.key]);
  const requested = normalizeLanguage(locale ?? listing.languages[0]);
  const resolved = listingContentState(listing, requested, key);
  if (locale && translationMissing(resolved, requested) || resolved.tier === "computed" && resolved.value == null) return { state: "inherited", value: void 0 };
  return { state: "stored", value: resolved.value };
}

// apps/api/src/services/pim/resolve-channel-field.ts
function resolveSourcePath(path, resolved, product, locale) {
  if (!path || typeof path !== "string") return null;
  locale = normalizeLanguage(locale);
  const substituted = path.replace(/\{locale\}/g, locale);
  const field2 = substituted.startsWith("localizedContent.") ? substituted.split(".")[2] : void 0;
  const address = contentPathAddress(path, locale, field2 ? [field2] : []);
  if (address) {
    let value = address.requested === locale && Object.prototype.hasOwnProperty.call(resolved, address.field) ? resolved[address.field] : resolveContentPath({
      product,
      parent: product.parent,
      path,
      listing: product.contentListing,
      localizableKeys: field2 ? [field2] : [],
      address: { requested: locale, ...product.contentListing ? { coordinate: product.contentListing.coordinate } : {} }
    })?.value ?? null;
    if (address.requested === locale && Object.prototype.hasOwnProperty.call(resolved, address.field)) {
      for (const key of address.tail) value = value && typeof value === "object" ? value[key] ?? null : null;
    }
    return value;
  }
  if (!substituted.includes(".")) {
    return resolved[substituted] ?? null;
  }
  const segments = substituted.split(".");
  const root = segments[0];
  const rest = segments.slice(1);
  let cursor;
  switch (root) {
    case "categoryAttributes":
      cursor = Object.prototype.hasOwnProperty.call(resolved, rest[0]) ? { ...product.categoryAttributes ?? {}, [rest[0]]: resolved[rest[0]] } : product.categoryAttributes;
      break;
    case "variantAttributes":
      cursor = Object.prototype.hasOwnProperty.call(resolved, rest[0]) ? { ...product.variantAttributes ?? {}, [rest[0]]: resolved[rest[0]] } : product.variantAttributes;
      break;
    default:
      cursor = resolved[root] ?? null;
  }
  for (const seg of rest) {
    if (cursor === null || cursor === void 0 || typeof cursor !== "object") return null;
    cursor = cursor[seg];
  }
  return cursor ?? null;
}

// apps/api/src/services/pim/global-content.ts
function globalContentLocales(product, parent, configuredLanguages = []) {
  const languages = /* @__PURE__ */ new Set([...contentLanguages(product, parent), ...configuredLanguages.map(normalizeLanguage)]);
  return Object.fromEntries([...languages].sort().map((language) => {
    const resolved = resolveContentAttributes({ product, parent, requested: language });
    return [language, {
      title: resolved.title?.value ?? null,
      description: resolved.description?.value ?? null,
      bulletPoints: resolved.bulletPoints?.value ?? [],
      keywords: resolved.keywords?.value ?? []
    }];
  }));
}

// docs/audits/2026-09-12-language-axis/step3-switch/accepted-reference.mjs
import { createHash as createHash2 } from "node:crypto";
import { informationRegistry as informationRegistry2, nativeTranslationKeys as nativeTranslationKeys2, shopifyMappingFieldKey as shopifyMappingFieldKey2 } from "@nexus/shared/shopify-information";
var PRIMARY_CONTENT_LOCALE2 = (process.env.NEXUS_PRIMARY_LANGUAGE ?? "it").toLowerCase();
var CONTENT_COLUMNS2 = { title: "name", description: "description", bulletPoints: "bulletPoints", keywords: "keywords" };
var contentHash2 = (value) => createHash2("sha256").update(JSON.stringify(value ?? null)).digest("hex");
function canonicalVariantAxis2(value) {
  const key = value.toLowerCase().replace(/[\s_-]/g, "");
  return {
    colore: "color",
    colour: "color",
    farbe: "color",
    couleur: "color",
    taglia: "size",
    taille: "size",
    talla: "size",
    gr\u00F6\u00DFe: "size",
    groesse: "size",
    stylename: "style"
  }[key] ?? key;
}
function normalizeLanguage2(tag) {
  if (typeof tag !== "string") throw new Error("Content language must be a language tag.");
  const language = tag.toLowerCase().split(/[-_]/, 1)[0];
  if (!/^[a-z]{2,3}$/.test(language)) throw new Error(`Invalid content language: ${tag}`);
  return language;
}
var contentField3 = (field2) => field2 === "name" ? "title" : field2;
var present2 = (value) => value !== void 0 && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
var workspace2 = (row) => row.workspaceId ?? null;
var label2 = (language) => new Intl.DisplayNames(["en"], { type: "language" }).of(language) ?? language;
var primary2 = () => normalizeLanguage2(PRIMARY_CONTENT_LOCALE2);
function sourceValue2(product, parent, field2) {
  const column32 = CONTENT_COLUMNS2[field2];
  for (const owner of [product, parent]) {
    if (!owner) continue;
    if (!column32 && Object.prototype.hasOwnProperty.call(owner.categoryAttributes ?? {}, field2) && owner.categoryAttributes?.[field2] !== void 0) return { value: owner.categoryAttributes[field2], owner };
    let value = column32 ? owner[column32] : owner.categoryAttributes?.[field2];
    if (!column32 && !present2(value)) {
      const variations = owner.categoryAttributes?.variations;
      const bag = { ...owner.variantAttributes ?? {}, ...variations && typeof variations === "object" && !Array.isArray(variations) ? variations : {} };
      value = bag[field2];
      if (value === void 0 && ["color", "size", "style"].includes(field2)) {
        const aliases = Object.entries(bag).filter(([key, value2]) => canonicalVariantAxis2(key) === field2 && value2 !== void 0);
        if (new Set(aliases.map(([, value2]) => JSON.stringify(value2))).size > 1) throw new Error(`Conflicting source variant attributes for ${field2}`);
        value = aliases[0]?.[1];
      }
      if (value !== void 0) return { value, owner };
    }
    if (present2(value)) return { value, owner };
  }
  return null;
}
function contentSourceHash2(product, parent, localizableKeys = []) {
  const fields = [.../* @__PURE__ */ new Set([...Object.keys(CONTENT_COLUMNS2), ...localizableKeys.map(contentField3)])].sort();
  return contentHash2(Object.fromEntries(fields.map((field2) => [field2, sourceValue2(product, parent, field2)?.value ?? null])));
}
function translationIndex2(rows = []) {
  const index = /* @__PURE__ */ new Map();
  const groups32 = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const language = normalizeLanguage2(row.language);
    groups32.set(language, [...groups32.get(language) ?? [], row]);
  }
  for (const [language, group] of groups32) {
    const canonical = group.filter((row) => row.language === language);
    const candidates = canonical.length ? canonical : group;
    if (candidates.length !== 1) throw new Error(`Ambiguous content translations for ${language}`);
    index.set(language, candidates[0]);
  }
  return index;
}
function coordinateMatches2(a, b) {
  return a.channel === b.channel && a.market === b.market && (a.accountId ?? null) === (b.accountId ?? null) && (a.aliasId ?? null) === (b.aliasId ?? null);
}
function translationValue2(row, field2) {
  if (!row) return void 0;
  const column32 = CONTENT_COLUMNS2[field2];
  return column32 ? row[column32] : row.attributes?.[field2];
}
function legacyPin2(listing, field2) {
  const columns = {
    title: ["titleOverride", "title", "followMasterTitle"],
    description: ["descriptionOverride", "description", "followMasterDescription"],
    bulletPoints: ["bulletPointsOverride", null, "followMasterBulletPoints"]
  };
  const spec2 = columns[field2];
  if (!spec2) return void 0;
  if (listing[spec2[2]] !== true && present2(listing[spec2[0]])) return listing[spec2[0]];
  return spec2[1] ? listing[spec2[1]] : void 0;
}
function resolver2(input) {
  const { product, parent, listing, localizableKeys = [] } = input;
  if (parent && (product.parentId !== parent.id || workspace2(parent) !== workspace2(product))) throw new Error("Content parent does not belong to this product/workspace.");
  if (listing && (listing.productId !== product.id || workspace2(listing) !== workspace2(product))) throw new Error("Content listing does not belong to this product/workspace.");
  const owners = [product, parent].filter((owner) => !!owner);
  const translations = owners.map((owner) => translationIndex2((owner.translations ?? []).filter((row) => workspace2(row) === workspace2(owner) && (!row.productId || row.productId === owner.id))));
  const pins = translationIndex2((listing?.translations ?? []).filter((row) => workspace2(row) === workspace2(product) && (!row.channelListingId || row.channelListingId === listing?.id)));
  const sourceLanguage = primary2();
  const hashes = /* @__PURE__ */ new Map();
  const allowed = /* @__PURE__ */ new Set([...Object.keys(CONTENT_COLUMNS2), ...localizableKeys.map(contentField3)]);
  return (fieldInput, address, computed) => {
    const field2 = contentField3(fieldInput), requested = normalizeLanguage2(address.requested);
    if (!allowed.has(field2)) throw new Error(`Field ${field2} is not declared localizable.`);
    const result = (value, tier, language, member, from) => ({ value, tier, language, requested, provenance: { member, from } });
    const translated = (row, value, tier, owner) => {
      const source2 = row.source ?? "manual";
      const reviewedAt = row.reviewedAt ? new Date(row.reviewedAt).toISOString() : null;
      if (row.sourceHash && !hashes.has(owner.id)) hashes.set(owner.id, contentSourceHash2(owner, owner === product ? parent : null, localizableKeys));
      const outdated = !!row.sourceHash && row.sourceHash !== hashes.get(owner.id);
      const machine = source2 === "ai" || source2 === "translated";
      const member = outdated ? machine && !reviewedAt ? "aiStale" : "outdated" : machine && !reviewedAt ? "ai" : tier === "pin" ? "pinned" : address.coordinate || owner !== product ? "inherited" : "own";
      return { ...result(value, tier, requested, member, tier === "pin" ? listing.id : `${label2(requested)} \xB7 shared`), translation: { source: source2, reviewedAt, outdated } };
    };
    if (address.coordinate && listing) {
      if (!coordinateMatches2(listing.coordinate, address.coordinate)) throw new Error("Content listing coordinate does not match the requested address.");
      if (!listing.languages.length) throw new Error("Content listing needs its market languages.");
      const pin = pins.get(requested), value = translationValue2(pin, field2);
      if (present2(value)) return translated(pin, value, "pin", product);
      if (requested === normalizeLanguage2(listing.languages[0])) {
        const legacy = legacyPin2(listing, field2);
        if (present2(legacy)) return result(legacy, "pin", requested, "pinned", listing.id);
      }
    }
    if (requested !== sourceLanguage) for (const [i, owner] of owners.entries()) {
      const row = translations[i].get(requested), value = translationValue2(row, field2);
      if (present2(value)) return translated(row, value, "language", owner);
    }
    const source = sourceValue2(product, parent, field2);
    if (source) return result(source.value, "source", sourceLanguage, address.coordinate || requested !== sourceLanguage || source.owner !== product ? "inherited" : "own", `${label2(sourceLanguage)} \xB7 source`);
    if (computed && present2(computed.value)) return { ...result(computed.value, "computed", normalizeLanguage2(computed.language), computed.provenance.member, computed.provenance.from) };
    return result(null, "computed", sourceLanguage, "inherited", null);
  };
}
function resolveContent2(input) {
  return resolver2(input)(input.field, input.address, input.computed);
}
function contentPathAddress2(path, requested, localizableKeys = []) {
  const parts = path.replace(/\{locale\}/g, requested).split(".");
  let language = requested;
  if (parts[0] === "localizedContent") {
    parts.shift();
    language = parts.shift() ?? "";
  } else if (["categoryAttributes", "variantAttributes"].includes(parts[0])) parts.shift();
  const field2 = contentField3(parts.shift() ?? "");
  if (![...Object.keys(CONTENT_COLUMNS2), ...localizableKeys].includes(field2)) return null;
  return { field: field2, requested: normalizeLanguage2(language), tail: parts };
}
function resolveContentPath2(input) {
  const path = contentPathAddress2(input.path, input.address.requested, input.localizableKeys);
  if (!path) return null;
  const resolved = resolveContent2({ ...input, field: path.field, address: { ...input.address, requested: path.requested } });
  let value = resolved.value;
  for (const key of path.tail) value = value && typeof value === "object" ? value[key] ?? null : null;
  return { ...resolved, value };
}
function resolveContentBatch2(input) {
  return input.members.flatMap((member) => {
    const resolve = resolver2(member);
    return input.addresses.map((address) => ({ productId: member.product.id, address: { ...address, requested: normalizeLanguage2(address.requested) }, fields: Object.fromEntries(input.fields.map((field2) => [field2, resolve(field2, address)])) }));
  });
}
var no_runtime_database_default = new Proxy({}, { get() {
  throw new Error("Shadow comparison attempted an application database access");
} });
var etsyListingSchema2 = {
  source: "https://www.etsy.com/openapi/generated/oas/3.0.0.json",
  verifiedAt: "2026-09-10",
  listing: { type: "object", properties: {
    "listing_id": { "type": "integer", "minimum": 1 },
    "user_id": { "type": "integer", "minimum": 1 },
    "shop_id": { "type": "integer", "minimum": 1 },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "rich_description": { "type": "string", "nullable": true },
    "state": { "type": "string", "enum": ["active", "inactive", "sold_out", "draft", "expired"] },
    "creation_timestamp": { "type": "integer", "minimum": 946684800 },
    "created_timestamp": { "type": "integer", "minimum": 946684800 },
    "ending_timestamp": { "type": "integer", "minimum": 946684800 },
    "original_creation_timestamp": { "type": "integer", "minimum": 946684800 },
    "last_modified_timestamp": { "type": "integer", "minimum": 946684800 },
    "updated_timestamp": { "type": "integer", "minimum": 946684800 },
    "state_timestamp": { "type": "integer", "nullable": true, "minimum": 946684800 },
    "quantity": { "type": "integer", "minimum": 0 },
    "shop_section_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "featured_rank": { "type": "integer" },
    "url": { "type": "string" },
    "num_favorers": { "type": "integer", "minimum": 0 },
    "non_taxable": { "type": "boolean" },
    "is_taxable": { "type": "boolean" },
    "is_customizable": { "type": "boolean" },
    "is_personalizable": { "type": "boolean" },
    "listing_type": { "type": "string", "enum": ["physical", "download", "both"] },
    "tags": { "type": "array", "items": { "type": "string" } },
    "materials": { "type": "array", "items": { "type": "string" } },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "processing_min": { "type": "integer", "nullable": true, "minimum": 0 },
    "processing_max": { "type": "integer", "nullable": true, "minimum": 0 },
    "who_made": { "type": "string", "nullable": true, "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "nullable": true, "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "is_supply": { "type": "boolean", "nullable": true },
    "item_weight": { "type": "number", "nullable": true },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["oz", "lb", "g", "kg"] },
    "item_length": { "type": "number", "nullable": true },
    "item_width": { "type": "number", "nullable": true },
    "item_height": { "type": "number", "nullable": true },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "is_private": { "type": "boolean" },
    "style": { "type": "array", "items": { "type": "string" } },
    "file_data": { "type": "string", "nullable": true },
    "has_variations": { "type": "boolean" },
    "should_auto_renew": { "type": "boolean" },
    "language": { "type": "string", "nullable": true },
    "price": { "type": "money" },
    "converted_price": { "type": "money" },
    "taxonomy_id": { "type": "integer", "nullable": true },
    "readiness_state_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "suggested_title": { "type": "string", "nullable": true }
  } },
  create: { type: "object", required: ["quantity", "title", "description", "price", "who_made", "when_made", "taxonomy_id"], properties: {
    "quantity": { "type": "integer" },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "price": { "type": "number" },
    "who_made": { "type": "string", "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "taxonomy_id": { "type": "integer", "minimum": 1 },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "materials": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "shop_section_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "processing_min": { "type": "integer", "nullable": true },
    "processing_max": { "type": "integer", "nullable": true },
    "readiness_state_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "tags": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "styles": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "item_weight": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_length": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_width": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_height": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["oz", "lb", "g", "kg"] },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "production_partner_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "image_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "is_supply": { "type": "boolean" },
    "is_customizable": { "type": "boolean" },
    "should_auto_renew": { "type": "boolean" },
    "is_taxable": { "type": "boolean" },
    "type": { "type": "string", "enum": ["physical", "download", "both"] }
  } },
  update: { type: "object", properties: {
    "image_ids": { "type": "array", "items": { "type": "integer", "minimum": 1 } },
    "title": { "type": "string" },
    "description": { "type": "string" },
    "materials": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "should_auto_renew": { "type": "boolean" },
    "shipping_profile_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "return_policy_id": { "type": "integer", "nullable": true, "minimum": 1 },
    "shop_section_id": { "type": "integer", "nullable": true },
    "item_weight": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_length": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_width": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_height": { "type": "number", "nullable": true, "minimum": 0, "maximum": 179769313486e297 },
    "item_weight_unit": { "type": "string", "nullable": true, "enum": ["", "oz", "lb", "g", "kg"] },
    "item_dimensions_unit": { "type": "string", "nullable": true, "enum": ["", "in", "ft", "mm", "cm", "m", "yd", "inches"] },
    "is_taxable": { "type": "boolean" },
    "taxonomy_id": { "type": "integer", "minimum": 1 },
    "tags": { "type": "array", "nullable": true, "items": { "type": "string" } },
    "who_made": { "type": "string", "enum": ["i_did", "someone_else", "collective"] },
    "when_made": { "type": "string", "enum": ["made_to_order", "2020_2026", "2010_2019", "2007_2009", "before_2007", "2000_2006", "1990s", "1980s", "1970s", "1960s", "1950s", "1940s", "1930s", "1920s", "1910s", "1900s", "1800s", "1700s", "before_1700"] },
    "featured_rank": { "type": "integer", "nullable": true },
    "state": { "type": "string", "enum": ["active", "inactive"] },
    "is_supply": { "type": "boolean" },
    "production_partner_ids": { "type": "array", "nullable": true, "items": { "type": "integer", "minimum": 1 } },
    "type": { "type": "string", "nullable": true, "enum": ["physical", "download", "both"] }
  } }
};
var groups3 = ["Content", "Classification", "Search", "Offer", "Shipping", "Policies", "Listing status", "Category attributes"].map((label22, order) => ({ key: label22.toLowerCase().replace(/ /g, "_"), label: label22, channelLabel: null, order }));
var column3 = (column32, followFlag) => ({ kind: "listingColumn", column: column32, followFlag });
var titleStore3 = column3("title", "followMasterTitle");
var descriptionStore3 = column3("description", "followMasterDescription");
var native2 = etsyListingSchema2.listing.properties;
var create2 = etsyListingSchema2.create.properties;
var update2 = etsyListingSchema2.update.properties;
var groups22 = ["Content", "Classification", "Search", "Offer", "Shipping", "Policies"].map((label22, order) => ({ key: label22.toLowerCase(), label: label22, channelLabel: null, order }));
var column22 = (column32, followFlag) => ({ kind: "listingColumn", column: column32, followFlag });
var titleStore22 = column22("title", "followMasterTitle");
var descriptionStore22 = column22("description", "followMasterDescription");

// docs/audits/2026-09-12-language-axis/step3-switch/compare.ts
var equalContent = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
var object = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
var workspace3 = (row) => row.workspaceId ?? null;
var id = (row, key = row.id) => JSON.stringify([workspace3(row), key]);
function compareSwitchedReaders(data) {
  const products = data.products.map((product) => ({ ...product, translations: data.translations.filter((row) => id(row, row.productId) === id(product)) }));
  const productMap = new Map(products.map((product) => [id(product), product]));
  const counts = {};
  const diffs = [];
  const receiptKey = (row) => JSON.stringify([row.reader, row.workspaceId, row.productId, row.listingId ?? null, row.coordinate ?? null, row.field, row.language, row.path ?? row.old?.path ?? null]);
  const accepted = new Map((data.acceptedDiffs ?? []).map((row) => [receiptKey(row), row]));
  const checked = /* @__PURE__ */ new Set(), receiptDiffs = [];
  const coveredListings = /* @__PURE__ */ new Set(), coordinates = /* @__PURE__ */ new Set();
  const observe = (reader, product, parent, listing, coordinate, field2, language, old, next) => {
    const key = JSON.stringify([reader, field2, language]);
    const count = counts[key] ??= { compared: 0, valueDiffs: 0, languageDiffs: 0, reviewDiffs: 0, diffs: 0 };
    count.compared++;
    const wireList = ["global-content", "product-content", "sheet-wire"].includes(reader) && ["bulletPoints", "keywords"].includes(field2);
    const expected = wireList && next.value == null ? [] : next.value;
    const valueChanged = !equalContent(old.value, expected);
    const actualLanguage = old.language ?? old.effectiveLocale;
    const languageChanged = actualLanguage !== void 0 && actualLanguage !== next.language;
    const reviewChanged = false;
    const receipt = receiptKey({ reader, productId: product.id, workspaceId: workspace3(product), listingId: listing?.id ?? null, coordinate, field: field2, language, path: old.path });
    const prior = accepted.get(receipt);
    if (prior) {
      checked.add(receipt);
      const value = wireList && prior.next.value == null ? [] : prior.next.value;
      if (!equalContent(old.value, value)) receiptDiffs.push({ reader, productId: product.id, field: field2, language, actual: old.value, acceptedNext: value });
    }
    if (!valueChanged && !languageChanged) return;
    count.valueDiffs += Number(valueChanged);
    count.languageDiffs += Number(languageChanged);
    count.diffs++;
    diffs.push({
      reader,
      productId: product.id,
      sku: product.sku,
      workspaceId: workspace3(product),
      listingId: listing?.id ?? null,
      coordinate,
      field: field2,
      language,
      valueChanged,
      languageChanged,
      actual: old,
      expected: { ...next, value: expected }
    });
  };
  for (const product of products) {
    const parent = product.parentId ? productMap.get(id(product, product.parentId)) : void 0;
    if (product.parentId && !parent) throw new Error(`Missing parent for ${product.id}`);
    const localizableKeys = data.localizableKeysByProduct?.[id(product)] ?? [];
    const fields = [...Object.keys(CONTENT_COLUMNS), ...localizableKeys];
    const markets = data.marketplaces.filter((market) => workspace3(market) === workspace3(product));
    const sharedLanguages = [.../* @__PURE__ */ new Set([normalizeLanguage(PRIMARY_CONTENT_LOCALE), ...markets.flatMap((m) => marketLanguages(m.channel, m.code, markets)), ...[product, parent].filter(Boolean).flatMap((p) => p.translations.map((row) => normalizeLanguage(row.language)))])].sort();
    const global = globalContentLocales(product, parent ?? null, sharedLanguages);
    const scopes = [{ coordinate: null, languages: sharedLanguages }];
    for (const market of markets) {
      const marketListings = data.listings.filter((l) => workspace3(l) === workspace3(product) && l.channel === market.channel && (l.marketplace && l.marketplace !== "DEFAULT" ? l.marketplace : l.region) === market.code);
      const languages = marketLanguages(market.channel, market.code, markets);
      const coordinateOf = (listing) => ({ channel: market.channel, market: market.code, ...listing?.channelConnectionId ? { accountId: listing.channelConnectionId } : {}, ...listing?.aliasId || listing?.aliasKey ? { aliasId: listing.aliasId ?? listing.aliasKey } : {} });
      const marketCoordinates = [...new Map((marketListings.length ? marketListings : [void 0]).map((listing) => {
        const coordinate = coordinateOf(listing);
        return [JSON.stringify(coordinate), coordinate];
      })).values()];
      for (const coordinate of marketCoordinates) {
        const matches = marketListings.filter((l) => id(l, l.productId) === id(product) && JSON.stringify(coordinateOf(l)) === JSON.stringify(coordinate));
        if (matches.length > 1) throw new Error(`Ambiguous listings for ${product.id} at ${JSON.stringify(coordinate)}`);
        const listing = matches[0];
        if (listing) coveredListings.add(id(listing));
        scopes.push({ coordinate, listing, languages });
      }
    }
    for (const scope of scopes) {
      const { coordinate, listing, languages } = scope;
      if (coordinate) coordinates.add(JSON.stringify([workspace3(product), coordinate]));
      const hydratedListing = listing ? { ...listing, id: listing.id, productId: listing.productId, coordinate, languages } : null;
      const batch = resolveContentBatch2({ members: [{ product, parent, listing: hydratedListing, localizableKeys }], fields, addresses: languages.map((requested) => ({ requested, ...coordinate ? { coordinate } : {} })) });
      for (const row of batch) {
        const language = row.address.requested;
        const old = resolveAttributes({ product, parent: parent ?? null, channelListing: listing, marketLanguages: languages, coordinate: coordinate ?? void 0, locale: language, localizableKeys });
        const oldProduct = !coordinate ? data.productResolvedContent?.({ ...product, parent }, language) : void 0;
        for (const field2 of fields) {
          const next = row.fields[field2];
          observe(coordinate ? "attribute-coordinate" : "attribute-shared", product, parent, listing, coordinate, field2, language, old[field2] ?? { value: null }, next);
          observe("sheet-wire", product, parent, listing, coordinate, field2, language, { ...old[field2], value: data.sheetValueForColumn({ key: field2 === "title" ? "name" : field2, kind: "text", storage: field2 === "title" ? "column" : "localizedContent", shape: ["bulletPoints", "keywords"].includes(field2) ? "list" : "scalar" }, product, old) }, next);
          if (!coordinate) observe("sourceContent", product, parent, void 0, null, field2, language, { value: sourceContent({ ...product, parent }, field2, language) }, next);
          if (!coordinate && field2 in CONTENT_COLUMNS) {
            observe("global-content", product, parent, void 0, null, field2, language, { ...old[field2], value: global[language]?.[field2] }, next);
            if (oldProduct) observe("product-content", product, parent, void 0, null, field2, language, oldProduct.fields[CONTENT_COLUMNS[field2]], next);
          }
          if (listing?.channel === "ETSY" && ["title", "description"].includes(field2)) observe("etsyContentState", product, parent, listing, coordinate, field2, language, etsyContentState({ ...listing, product: { ...product, parent }, languages }, language, field2) ?? { value: null }, next);
          if (listing?.channel === "AMAZON" && field2 === "title" && data.extractLocaleTitle) observe("syndication-title", product, parent, listing, coordinate, field2, language, { value: data.extractLocaleTitle({ ...product, parent }, listing, languages, language) }, next);
          if (listing?.channel === "SHOPIFY" && ["title", "description"].includes(field2)) {
            const spec2 = shopifyProductSpec(null, coordinate?.accountId).fields.find((spec3) => spec3.masterKey === (field2 === "title" ? "name" : field2));
            const stored = informationContentState({ ...listing, product: { ...product, parent }, languages }, spec2);
            observe("shopify-information-native", product, parent, listing, coordinate, field2, language, { value: stored.value }, next);
          }
        }
        if (coordinate) {
          const market = markets.find((m) => m.channel === coordinate.channel && m.code === coordinate.market);
          const mapping = object(market.schemaMapping), category = listing?.platformAttributes?.productType ?? product.productType;
          const rules = { ...object(mapping.fields), ...object(mapping.byProductType?.[category]) };
          const paths = [...new Set(Object.values(rules).flatMap((rule) => [rule.source, rule.fallback].filter((path) => typeof path === "string" && !!path)))];
          for (const path of paths) {
            const parsed = contentPathAddress(path, language, localizableKeys);
            if (!parsed) continue;
            const next = resolveContentPath2({ product, parent, listing: hydratedListing, address: { requested: language, coordinate }, localizableKeys, path });
            const flat = Object.fromEntries(Object.entries(old).map(([field2, hit]) => [field2, hit.value]));
            const value = resolveSourcePath(path, flat, { ...product, parent, contentListing: hydratedListing }, language);
            observe("mapping-source", product, parent, listing, coordinate, parsed.field, language, { value, path }, next);
          }
        }
      }
    }
  }
  if (coveredListings.size !== data.listings.length) throw new Error(`Listing coverage mismatch: ${coveredListings.size}/${data.listings.length}`);
  return { counts: Object.entries(counts).map(([key, counts2]) => {
    const [reader, field2, language] = JSON.parse(key);
    return { reader, field: field2, language, ...counts2 };
  }), acceptedReceipt: { expected: accepted.size, checked: checked.size, missing: [...accepted.keys()].filter((key) => !checked.has(key)), diffs: receiptDiffs }, diffs, coveredListings: coveredListings.size, coordinates: coordinates.size };
}

// <stdin>
function extractLocaleTitle(product, listing, languages, requested = languages[0]) {
  const hydrated = contentListing(product, listing, void 0, languages);
  const resolved = resolveContent({ product, parent: product.parent, listing: hydrated, field: "title", address: { requested, coordinate: hydrated.coordinate } });
  return typeof resolved.value === "string" && resolved.value.length ? resolved.value : null;
}
function resolvedContent(product, language) {
  language = normalizeLanguage(language);
  const resolved = resolveContentAttributes({ product, parent: product.parent ?? null, requested: language });
  const fields = Object.fromEntries(Object.entries(CONTENT_COLUMNS).map(([key, column4]) => [column4, {
    ...resolved[key],
    value: contentWireValue(resolved[key].value, ["bulletPoints", "keywords"].includes(key) ? "list" : void 0)
  }]));
  return {
    name: String(fields.name?.value ?? ""),
    description: fields.description?.value ?? null,
    bulletPoints: fields.bulletPoints?.value ?? [],
    keywords: fields.keywords?.value ?? [],
    source: Object.values(fields).some((field2) => field2.effectiveLocale === language && ["masterLocale", "variantLocale"].includes(field2.source ?? "")) ? "translation" : "master",
    language,
    fields
  };
}
function sheetValueForColumn(col, product, resolved) {
  const baseKey = contentField(col.slot?.of ?? col.key);
  let base;
  if (resolved[baseKey] && (col.storage === "localizedContent" || ["title", "description", "bulletPoints", "keywords"].includes(baseKey))) base = resolved[baseKey]?.value;
  else if (col.storage === "column") {
    base = normalise(product[baseKey], col.kind);
    if (baseKey === "countryOfOrigin" && isBlankValue(base)) base = resolved.country_of_origin?.value ?? null;
  } else {
    base = resolved[baseKey]?.value;
  }
  if (base === void 0) base = null;
  return contentWireValue(projectCellValue(col, base), col.slot ? void 0 : col.shape);
}
function normalise(v, kind) {
  if (v === null || v === void 0) return null;
  if (v instanceof Date) return v.toISOString();
  if (kind === "number") return decimalToNumber(v);
  if (typeof v === "object" && typeof v.toNumber === "function") return decimalToNumber(v);
  return v;
}
function decimalToNumber(v) {
  if (v === null || v === void 0) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  const maybe = v;
  if (typeof maybe.toNumber === "function") {
    const n = maybe.toNumber();
    return Number.isFinite(n) ? n : null;
  }
  if (typeof maybe.toString === "function") {
    const n = Number(maybe.toString());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
export {
  compareSwitchedReaders,
  decimalToNumber,
  extractLocaleTitle,
  resolvedContent as productResolvedContent,
  resolvedContent,
  sheetValueForColumn
};
