'use client'

import { useState, useTransition } from 'react'
import {
  getHealthStatus,
  getValidationReport,
  runAllRepairs,
  runRepairOperation,
  type HealthStatus,
  type ValidationReport,
  type BatchRepairResult,
} from './actions'

interface AdminDashboardClientProps {
  initialHealth: HealthStatus | null
  initialValidation: ValidationReport | null
}

export default function AdminDashboardClient({
  initialHealth,
  initialValidation,
}: AdminDashboardClientProps) {
  const [health, setHealth] = useState<HealthStatus | null>(initialHealth)
  const [validation, setValidation] = useState<ValidationReport | null>(initialValidation)
  const [repairResult, setRepairResult] = useState<BatchRepairResult | null>(null)
  const [isLoading, startTransition] = useTransition()

  const handleRefreshHealth = () => {
    startTransition(async () => {
      const result = await getHealthStatus()
      if (result) setHealth(result)
    })
  }

  const handleRefreshValidation = () => {
    startTransition(async () => {
      const result = await getValidationReport()
      if (result) setValidation(result)
    })
  }

  const handleRunAllRepairs = () => {
    startTransition(async () => {
      const result = await runAllRepairs()
      if (result) {
        setRepairResult(result)
        // Refresh health and validation after repairs
        setTimeout(async () => {
          const newHealth = await getHealthStatus()
          const newValidation = await getValidationReport()
          if (newHealth) setHealth(newHealth)
          if (newValidation) setValidation(newValidation)
        }, 1000)
      }
    })
  }

  const handleRunSpecificRepair = (operation: string) => {
    startTransition(async () => {
      const result = await runRepairOperation(
        operation as 'orphaned-variations' | 'missing-themes' | 'missing-attributes' | 'product-status' | 'channel-listings'
      )
      if (result) {
        // Refresh health and validation
        setTimeout(async () => {
          const newHealth = await getHealthStatus()
          const newValidation = await getValidationReport()
          if (newHealth) setHealth(newHealth)
          if (newValidation) setValidation(newValidation)
        }, 1000)
      }
    })
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy':
        return 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-900'
      case 'warning':
        return 'bg-yellow-50 border-yellow-200'
      case 'unhealthy':
        return 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900'
      default:
        return 'bg-gray-50 border-gray-200'
    }
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'healthy':
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-green-100 text-green-800 text-sm font-medium">
            <span className="w-2 h-2 bg-green-600 rounded-full"></span>
            Healthy
          </span>
        )
      case 'warning':
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-yellow-100 text-yellow-800 text-sm font-medium">
            <span className="w-2 h-2 bg-yellow-600 rounded-full"></span>
            Warning
          </span>
        )
      case 'unhealthy':
        return (
          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-red-100 dark:bg-red-900/60 text-red-800 text-sm font-medium">
            <span className="w-2 h-2 bg-red-600 dark:bg-red-700 rounded-full"></span>
            Unhealthy
          </span>
        )
      default:
        return null
    }
  }

  const getSeverityColor = (severity: string) => {
    return severity === 'ERROR' ? 'text-red-600 dark:text-red-400' : 'text-yellow-600'
  }

  return (
    <div className="space-y-6">
      {/* Health Status Card */}
      {health && (
        <div className={`border rounded-lg p-6 ${getStatusColor(health.status)}`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">System Health</h2>
            {getStatusBadge(health.status)}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div className="bg-white dark:bg-slate-900 rounded p-3">
              <div className="text-sm text-gray-600">Orphaned Variants</div>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">{health.issues.orphanedVariants}</div>
            </div>
            <div className="bg-white dark:bg-slate-900 rounded p-3">
              <div className="text-sm text-gray-600">Inconsistent Themes</div>
              <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">{health.issues.inconsistentThemes}</div>
            </div>
            <div className="bg-white dark:bg-slate-900 rounded p-3">
              <div className="text-sm text-gray-600">Missing Attributes</div>
              <div className="text-2xl font-bold text-yellow-600">{health.issues.missingAttributes}</div>
            </div>
            <div className="bg-white dark:bg-slate-900 rounded p-3">
              <div className="text-sm text-gray-600">Invalid Listings</div>
              <div className="text-2xl font-bold text-purple-600">{health.issues.invalidChannelListings}</div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              Total Issues: <span className="font-semibold">{health.totalIssues}</span>
            </div>
            <button
              onClick={handleRefreshHealth}
              disabled={isLoading}
              className="px-4 py-2 bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 text-sm font-medium"
            >
              {isLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
      )}

      {/* Validation Report */}
      {validation && (
        <div className="bg-white dark:bg-slate-900 border border-gray-200 rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Validation Report</h2>
            <button
              onClick={handleRefreshValidation}
              disabled={isLoading}
              className="px-4 py-2 bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 text-sm font-medium"
            >
              {isLoading ? 'Validating...' : 'Validate'}
            </button>
          </div>

          {validation.issues.length > 0 ? (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {validation.issues.map((issue, idx) => (
                <div key={idx} className="border border-gray-200 rounded p-3 bg-gray-50">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${getSeverityColor(issue.severity)}`}>
                        {issue.severity}
                      </span>
                      <span className="text-sm font-medium text-gray-700">{issue.type}</span>
                    </div>
                  </div>
                  <p className="text-sm text-gray-600">{issue.message}</p>
                  {issue.affectedIds && issue.affectedIds.length > 0 && (
                    <div className="mt-2 text-xs text-gray-500">
                      Affected: {issue.affectedIds.slice(0, 3).join(', ')}
                      {issue.affectedIds.length > 3 && ` +${issue.affectedIds.length - 3} more`}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <p className="text-lg font-medium">✓ No issues found</p>
              <p className="text-sm">Your product catalog is in good shape!</p>
            </div>
          )}
        </div>
      )}

      {/* Repair Operations */}
      <div className="bg-white dark:bg-slate-900 border border-gray-200 rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Repair Operations</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
          <button
            onClick={handleRunAllRepairs}
            disabled={isLoading}
            className="px-4 py-3 bg-red-600 dark:bg-red-700 text-white rounded hover:bg-red-700 dark:hover:bg-red-600 disabled:opacity-50 font-medium flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" opacity="0.25"></circle>
                  <path
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                Running...
              </>
            ) : (
              '🔧 Run All Repairs'
            )}
          </button>

          <button
            onClick={handleRefreshValidation}
            disabled={isLoading}
            className="px-4 py-3 bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 font-medium"
          >
            {isLoading ? 'Validating...' : '✓ Validate Only'}
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-700 mb-3">Individual Repairs:</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[
              { id: 'orphaned-variations', label: 'Remove Orphaned Variants' },
              { id: 'missing-themes', label: 'Infer Variation Themes' },
              { id: 'missing-attributes', label: 'Populate Attributes' },
              { id: 'product-status', label: 'Fix Product Status' },
              { id: 'channel-listings', label: 'Fix Channel Listings' },
            ].map((repair) => (
              <button
                key={repair.id}
                onClick={() => handleRunSpecificRepair(repair.id)}
                disabled={isLoading}
                className="px-3 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50 text-sm font-medium text-left"
              >
                {repair.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Repair Results */}
      {repairResult && (
        <div className="bg-white dark:bg-slate-900 border border-green-200 dark:border-green-900 rounded-lg p-6 bg-green-50 dark:bg-green-950/40">
          <h2 className="text-xl font-semibold mb-4 text-green-900">Repair Results</h2>

          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white dark:bg-slate-900 rounded p-3">
              <div className="text-sm text-gray-600">Total Affected</div>
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{repairResult.summary.totalAffected}</div>
            </div>
            <div className="bg-white dark:bg-slate-900 rounded p-3">
              <div className="text-sm text-gray-600">Fixed</div>
              <div className="text-2xl font-bold text-green-600 dark:text-green-400">{repairResult.summary.totalFixed}</div>
            </div>
            <div className="bg-white dark:bg-slate-900 rounded p-3">
              <div className="text-sm text-gray-600">Failed</div>
              <div className="text-2xl font-bold text-red-600 dark:text-red-400">{repairResult.summary.totalFailed}</div>
            </div>
          </div>

          <div className="space-y-3">
            {repairResult.operations.map((op, idx) => (
              <div key={idx} className="border border-gray-200 rounded p-3 bg-white dark:bg-slate-900">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-gray-900">{op.name}</h3>
                  <span className="text-xs text-gray-500">{op.duration}ms</span>
                </div>
                <p className="text-sm text-gray-600 mb-2">{op.description}</p>
                <div className="flex items-center gap-4 text-sm">
                  <span className="text-gray-600">
                    Affected: <span className="font-semibold">{op.affectedCount}</span>
                  </span>
                  <span className="text-green-600 dark:text-green-400">
                    Fixed: <span className="font-semibold">{op.fixedCount}</span>
                  </span>
                  {op.failedCount > 0 && (
                    <span className="text-red-600 dark:text-red-400">
                      Failed: <span className="font-semibold">{op.failedCount}</span>
                    </span>
                  )}
                </div>
                {op.errors.length > 0 && (
                  <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 p-2 rounded">
                    {op.errors[0]}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
