'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Plus, RefreshCw } from 'lucide-react';
import PageHeader from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { useTranslations } from '@/lib/i18n/use-translations';
import { apiClient, PricingRule } from '@/lib/api-client';
import PricingRulesTable from './PricingRulesTable';
import CreateRuleModal from './CreateRuleModal';

export default function PricingRulesDashboardPage() {
  const { t } = useTranslations();
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRules = async () => {
    try {
      setError(null);
      const pricingRules = await apiClient.getPricingRules();
      setRules(pricingRules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch pricing rules');
      console.error('Error fetching pricing rules:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchRules();
    setRefreshing(false);
  };

  const handleRuleCreated = async () => {
    setShowCreateModal(false);
    await fetchRules();
  };

  const handleRuleUpdated = async () => {
    await fetchRules();
  };

  const handleRuleDeleted = async () => {
    await fetchRules();
  };

  const countLabel =
    rules.length === 1
      ? t('pricing.rules.activeCount', { n: rules.length })
      : t('pricing.rules.activeCountPlural', { n: rules.length });

  return (
    <div>
      <PageHeader
        title={t('pricing.rules.title')}
        subtitle={t('pricing.rules.subtitle')}
        breadcrumbs={[
          { label: t('pricing.crumb.root'), href: '/pricing' },
          { label: t('pricing.rules.crumb') },
        ]}
      />

      {/* Error Alert */}
      {error && (
        <div className="mb-4 px-3 py-2 bg-rose-50 border border-rose-200 rounded-md inline-flex items-start gap-2 text-base text-rose-700">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">{t('pricing.rules.errorTitle')}</p>
            <p className="text-sm mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {/* Header Actions */}
      <div className="mb-4 flex justify-between items-center">
        <div className="text-base text-slate-600 tabular-nums">{countLabel}</div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="md"
            onClick={handleRefresh}
            disabled={refreshing}
            loading={refreshing}
            icon={refreshing ? null : <RefreshCw size={12} />}
          >
            {refreshing ? t('pricing.rules.refreshing') : t('pricing.rules.refresh')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => setShowCreateModal(true)}
            icon={<Plus size={12} />}
          >
            {t('pricing.rules.createNew')}
          </Button>
        </div>
      </div>

      {/* Loading State */}
      {loading ? (
        <div className="space-y-3">
          <Skeleton variant="block" height={36} />
          <Skeleton variant="block" height={256} />
        </div>
      ) : (
        <PricingRulesTable
          rules={rules}
          onRuleUpdated={handleRuleUpdated}
          onRuleDeleted={handleRuleDeleted}
        />
      )}

      {/* Create Rule Modal */}
      {showCreateModal && (
        <CreateRuleModal
          onClose={() => setShowCreateModal(false)}
          onRuleCreated={handleRuleCreated}
        />
      )}
    </div>
  );
}
