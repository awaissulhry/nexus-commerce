import Link from 'next/link'
import PageHeader from '@/components/layout/PageHeader'

export default function ImportPage() {
  return (
    <div>
      <PageHeader
        title="Upload via Spreadsheet"
        subtitle="Bulk import products from Excel or CSV"
        breadcrumbs={[
          { label: 'Inventory', href: '/inventory' },
          { label: 'Import' },
        ]}
      />

      {/* Back Button */}
      <div className="mb-6">
        <Link
          href="/inventory"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-300 hover:text-white hover:bg-gray-800 rounded-md transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Inventory
        </Link>
      </div>

      {/* Upload Card */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-8">
        <div className="flex flex-col items-center justify-center py-12">
          <div className="text-5xl mb-4">📤</div>
          <h2 className="text-2xl font-bold text-white mb-2">Drag and drop your file here</h2>
          <p className="text-gray-400 mb-6">or click to browse</p>
          <p className="text-sm text-gray-500">Supported formats: Excel (.xlsx), CSV (.csv)</p>
        </div>

        {/* Placeholder Input */}
        <div className="mt-8 border-2 border-dashed border-gray-700 rounded-lg p-8 text-center hover:border-gray-600 transition-colors cursor-pointer">
          <input
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            id="file-upload"
          />
          <label htmlFor="file-upload" className="cursor-pointer block">
            <p className="text-gray-400">Click to select a file or drag and drop</p>
          </label>
        </div>

        {/* Info Section */}
        <div className="mt-8 bg-gray-800/50 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-white mb-4">File Requirements</h3>
          <ul className="space-y-2 text-sm text-gray-400">
            <li className="flex items-start gap-3">
              <span className="text-green-500 mt-1">✓</span>
              <span>First row must contain column headers (SKU, Name, Price, Stock, etc.)</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-green-500 mt-1">✓</span>
              <span>Maximum 1,000 products per file</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-green-500 mt-1">✓</span>
              <span>File size must be under 10MB</span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-green-500 mt-1">✓</span>
              <span>SKU is required for each product</span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}
