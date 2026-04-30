'use client'

export default function PricingError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="p-8 text-center">
      <h2 className="text-xl font-semibold text-red-600 mb-2">Failed to load pricing</h2>
      <p className="text-gray-500 mb-4 text-sm">{error.message}</p>
      <button onClick={reset} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm">
        Retry
      </button>
    </div>
  )
}
