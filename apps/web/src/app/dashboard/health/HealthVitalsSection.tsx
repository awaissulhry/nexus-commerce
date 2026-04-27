'use client';

import { ChannelHealthScore } from '@/lib/api-client';

interface HealthVitalsSectionProps {
  healthScores: ChannelHealthScore[];
}

function getHealthBgColor(score: number): string {
  if (score > 90) return 'bg-green-50 border-green-200';
  if (score >= 75) return 'bg-yellow-50 border-yellow-200';
  return 'bg-red-50 border-red-200';
}

function getHealthTextColor(score: number): string {
  if (score > 90) return 'text-green-700';
  if (score >= 75) return 'text-yellow-700';
  return 'text-red-700';
}

function getHealthBadgeColor(score: number): string {
  if (score > 90) return 'bg-green-100 text-green-800';
  if (score >= 75) return 'bg-yellow-100 text-yellow-800';
  return 'bg-red-100 text-red-800';
}

export default function HealthVitalsSection({ healthScores }: HealthVitalsSectionProps) {
  // Filter for Amazon and eBay
  const amazonScore = healthScores.find(s => s.channel.toLowerCase() === 'amazon');
  const ebayScore = healthScores.find(s => s.channel.toLowerCase() === 'ebay');

  const scores = [amazonScore, ebayScore].filter(Boolean) as ChannelHealthScore[];

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <h2 className="text-xl font-bold text-gray-900 mb-6">Marketplace Vitals</h2>

      {scores.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500">No health data available</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {scores.map((score) => (
            <div
              key={score.channel}
              className={`${getHealthBgColor(score.healthScore)} border rounded-lg p-6`}
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {score.channel.charAt(0).toUpperCase() + score.channel.slice(1)}
                  </h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Last updated: {new Date(score.lastUpdated).toLocaleString()}
                  </p>
                </div>
                <span
                  className={`${getHealthBadgeColor(score.healthScore)} px-3 py-1 rounded-full text-sm font-semibold`}
                >
                  {score.healthScore > 90 ? '✓ Healthy' : score.healthScore >= 75 ? '⚠ Warning' : '✕ Critical'}
                </span>
              </div>

              {/* Health Score */}
              <div className="mb-6">
                <div className="flex items-end gap-2 mb-2">
                  <span className={`${getHealthTextColor(score.healthScore)} text-5xl font-bold`}>
                    {score.healthScore}
                  </span>
                  <span className="text-gray-600 text-lg mb-1">/100</span>
                </div>
                <div className="w-full bg-gray-300 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      score.healthScore > 90
                        ? 'bg-green-500'
                        : score.healthScore >= 75
                          ? 'bg-yellow-500'
                          : 'bg-red-500'
                    }`}
                    style={{ width: `${score.healthScore}%` }}
                  />
                </div>
              </div>

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-white bg-opacity-50 rounded p-3">
                  <p className="text-xs text-gray-600 font-medium">Success Rate</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    {score.successRate.toFixed(1)}%
                  </p>
                </div>
                <div className="bg-white bg-opacity-50 rounded p-3">
                  <p className="text-xs text-gray-600 font-medium">Total Errors</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">
                    {score.totalErrors}
                  </p>
                </div>
                <div className="bg-white bg-opacity-50 rounded p-3">
                  <p className="text-xs text-gray-600 font-medium">Critical Errors</p>
                  <p className="text-2xl font-bold text-red-600 mt-1">
                    {score.criticalErrors}
                  </p>
                </div>
                <div className="bg-white bg-opacity-50 rounded p-3">
                  <p className="text-xs text-gray-600 font-medium">Unresolved Conflicts</p>
                  <p className="text-2xl font-bold text-orange-600 mt-1">
                    {score.unresolvedConflicts}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
