// IH.2 placeholder — referenced by /insights TopSKUsWidget "See all →"
// link. The route exists so the pre-push link-target check passes; the
// real /insights/products lens lands in a later IH phase.

export default function InsightsProductsStubPage() {
  return (
    <div className="p-8 text-sm text-slate-500 dark:text-slate-400">
      <h1 className="text-base font-semibold text-slate-700 dark:text-slate-200 mb-2">
        Products insight lens
      </h1>
      <p>This view is coming in a later IH phase.</p>
    </div>
  )
}
