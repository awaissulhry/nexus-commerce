interface StatCardProps {
  title: string
  value: string | number
  icon: string
  color: 'blue' | 'green' | 'red' | 'purple' | 'yellow'
}

const colorClasses = {
  blue: 'bg-blue-50 border-blue-200',
  green: 'bg-green-50 border-green-200',
  red: 'bg-red-50 border-red-200',
  purple: 'bg-purple-50 border-purple-200',
  yellow: 'bg-yellow-50 border-yellow-200',
}

const textColorClasses = {
  blue: 'text-blue-600',
  green: 'text-green-600',
  red: 'text-red-600',
  purple: 'text-purple-600',
  yellow: 'text-yellow-600',
}

export default function StatCard({ title, value, icon, color }: StatCardProps) {
  const displayValue = typeof value === 'number' ? value.toLocaleString() : value

  return (
    <div className={`${colorClasses[color]} border rounded-lg p-6 shadow-sm`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-gray-600 text-sm font-medium">{title}</p>
          <p className={`${textColorClasses[color]} text-4xl font-bold mt-2`}>
            {displayValue}
          </p>
        </div>
        <div className="text-5xl">{icon}</div>
      </div>
    </div>
  )
}
