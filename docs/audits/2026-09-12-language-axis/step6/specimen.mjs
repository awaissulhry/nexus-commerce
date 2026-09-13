// <stdin>
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// apps/web/src/design-system/grid/renderers/provenanceMark.tsx
import { memo } from "react";
import { History, CornerDownRight, Link2, Pencil, Share2, Sigma, SparkleIcon, Sparkles } from "lucide-react";

// apps/web/src/design-system/grid/renderers/provenance.ts
var MASTER_LAYERS = /* @__PURE__ */ new Set(["master", "default"]);
var MASTER_SOURCES = /* @__PURE__ */ new Set(["master", "masterlocale", "mastercolumn", "default", "schema"]);
var OVERRIDE_SOURCES = /* @__PURE__ */ new Set(["channeloverride", "channelexplicit", "variantoverride", "aliasoverride", "override", "pinned"]);
function classifyProvenance(cell, layer = "master") {
  if (!cell) return "own";
  if (cell.refusedReason != null && cell.refusedReason !== "") return "refused";
  const member = cell.provenance?.member;
  if (member === "refused") return "refused";
  if (cell.aiDrafted) return cell.aiStale ? "aiStale" : "ai";
  if (member === "ai" || member === "aiStale") return member;
  if (cell.translation?.outdated || member === "outdated") return "outdated";
  if (cell.formula || member === "formula") return "formula";
  const derived = cell.mapped?.status === "mapped" && cell.mapped.provenance !== "override";
  if (derived && cell.mappedProductLevel) return "mappedShared";
  if (derived) return "mapped";
  if (member) return member === "pinned" && cell.follows ? "inherited" : member;
  const isInherited = typeof cell.inherited === "boolean" ? cell.inherited : cell.inheritedFrom != null && cell.inheritedFrom !== "";
  if (cell.layer != null && cell.layer !== "") {
    const explicit = cell.layer.toLowerCase();
    if (explicit === "linked" || cell.linkGroupId != null && cell.linkGroupId !== "") return "inherited";
    if (isInherited) return MASTER_LAYERS.has(explicit) ? "inherited" : "inheritedOverride";
    if (cell.pinned) return "pinned";
    if (layer !== "master" && explicit !== "master" && explicit !== "default") return "pinned";
    return "own";
  }
  const source = (cell.source ?? "").toLowerCase();
  if (isInherited) return !source || MASTER_SOURCES.has(source) ? "inherited" : "inheritedOverride";
  if (cell.pinned) return "pinned";
  if (!source) return "own";
  if (OVERRIDE_SOURCES.has(source)) return "pinned";
  if (layer !== "master" && !MASTER_SOURCES.has(source)) return "pinned";
  return "own";
}
function provenanceTooltip(provenance, from) {
  switch (provenance) {
    case "inherited":
      return from ? `Inherited from ${from} \u2014 edit to give this row its own value` : "Inherited from the parent \u2014 edit to give this row its own value";
    case "inheritedOverride":
      return from ? `Inherited from ${from}, which itself overrides the master \u2014 resetting returns it to ${from}, not to the master` : "Inherited from a layer that itself overrides the master \u2014 resetting returns it there, not to the master";
    case "pinned":
      return from ? `Pinned on this row \u2014 it no longer follows ${from}` : "Pinned on this row \u2014 it no longer follows the layer above";
    case "mapped":
      return from ? `Derived by a mapping rule from ${from}` : "Derived by a mapping rule";
    case "mappedShared":
      return from ? `Derived per product from ${from} \u2014 every alias of this product shares this value, so editing one changes all of them` : "Derived per product \u2014 every alias of this product shares this value, so editing one changes all of them";
    case "refused":
      return from ?? "This formula produced no value.";
    case "formula":
      return from ? `Calculated by a formula on this cell \u2014 ${from}. Edit the cell to change the formula` : "Calculated by a formula on this cell \u2014 edit the cell to change the formula";
    case "outdated":
      return `Out of date \u2014 ${from ?? "the source"} changed after this translation was written. Compare with the source; translate again or mark reviewed.`;
    case "ai":
      return "Drafted by AI and not yet approved \u2014 review before it counts as confirmed";
    case "aiStale":
      return from ? `Drafted by AI from an older value \u2014 ${from} has changed since. Approving this overwrites that change.` : "Drafted by AI from an older value \u2014 this cell has changed since. Approving this overwrites that change.";
    default:
      return "";
  }
}
function describeCellSource(cell, options = {}) {
  const member = classifyProvenance({ ...cell, refusedReason: options.refusedReason ?? cell?.refusedReason }, options.layer);
  const from = member === "refused" ? options.refusedReason ?? cell?.refusedReason ?? cell?.provenance?.from ?? null : options.from ?? cell?.provenance?.from ?? null;
  return { member, from, tooltip: provenanceTooltip(member, from) };
}

// apps/web/src/design-system/grid/renderers/provenanceMark.tsx
import { jsx } from "react/jsx-runtime";
var MARKS = {
  outdated: { Icon: History, label: "Out of date", cls: "nds-cell-prov-outdated" },
  inherited: { Icon: Link2, label: "Inherited", cls: "nds-cell-prov-inherited" },
  // A DIFFERENT glyph, not a differently-coloured one: the two states reset to different places,
  // and colour alone is not identity (ruling #16, reference_tag_identity_is_glyph_not_colour).
  inheritedOverride: { Icon: CornerDownRight, label: "Inherited via an override", cls: "nds-cell-prov-inherited nds-cell-prov-via" },
  pinned: { Icon: Pencil, label: "Pinned", cls: "nds-cell-prov-pinned" },
  // §9.6. Σ for "computed by a rule", and a DIFFERENT glyph for the shared-scope case rather than a
  // tint of the same one — the two differ in what happens when you edit, which is exactly the test
  // ruling #16 set for minting a member at all.
  mapped: { Icon: Sigma, label: "Derived by a mapping rule", cls: "nds-cell-prov-mapped" },
  mappedShared: { Icon: Share2, label: "Derived per product \u2014 shared by every alias", cls: "nds-cell-prov-mapped nds-cell-prov-mapped-shared" },
  ai: { Icon: Sparkles, label: "AI-drafted", cls: "nds-cell-prov-ai" },
  aiStale: { Icon: SparkleIcon, label: "AI-drafted \xB7 out of date", cls: "nds-cell-prov-ai nds-cell-prov-ai-stale" }
};
var ProvenanceMark = memo(function ProvenanceMark2({ provenance, from }) {
  if (provenance === "own") return null;
  if (provenance === "refused") {
    const label2 = "The formula produced no value";
    return /* @__PURE__ */ jsx(
      "span",
      {
        className: "nds-cell-prov nds-cell-prov-refused",
        "aria-hidden": true,
        title: from ?? label2,
        children: "\u26A0"
      }
    );
  }
  if (provenance === "formula") {
    const label2 = "Calculated by a formula";
    return /* @__PURE__ */ jsx(
      "span",
      {
        className: "nds-cell-prov nds-cell-prov-formula nds-formula-glyph",
        "aria-hidden": true,
        title: provenanceTooltip(provenance, from) || label2,
        children: "\u0192"
      }
    );
  }
  const { Icon, label, cls } = MARKS[provenance];
  return /* @__PURE__ */ jsx("span", { className: `nds-cell-prov ${cls}`, "aria-hidden": true, title: provenanceTooltip(provenance, from) || label, children: /* @__PURE__ */ jsx(Icon, { size: 11, strokeWidth: 2.25 }) });
});

// <stdin>
var specimen = renderToStaticMarkup(h(
  "div",
  { className: "nds-ag-wrap", "data-lx6-specimen": "true" },
  h("strong", null, "DS contract specimen \xB7 synthetic states \xB7 no catalogue write"),
  ...["inherited", "pinned", "ai", "aiStale", "outdated", "formula", "mapped", "refused"].map((member) => {
    const from = member === "refused" ? "German title exceeds 200 bytes for Amazon \xB7 DE." : member === "outdated" ? "Italian \xB7 source" : "German \xB7 shared";
    const source = describeCellSource({ provenance: { member, from } });
    return h(
      "div",
      { className: "ag-cell nds-ag-cell nds-cell-value " + (member === "outdated" ? "nds-cell-is-outdated" : ""), title: source.tooltip },
      h(ProvenanceMark, { provenance: source.member, from: source.from }),
      h("span", { className: "nds-cell-value-text" }, member + " \xB7 " + source.tooltip)
    );
  })
));
export {
  specimen
};
