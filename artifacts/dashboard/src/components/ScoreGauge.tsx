import React from 'react';
import { cn } from '@/lib/utils';

interface ScoreGaugeProps {
  score: number;
  label: string;
  type?: 'success' | 'warning' | 'danger' | 'info';
  className?: string;
}

export function ScoreGauge({ score, label, type = 'info', className }: ScoreGaugeProps) {
  const normalizedScore = Math.max(0, Math.min(100, score || 0));
  
  let colorClass = 'text-blue-500';
  let bgClass = 'bg-blue-500';
  
  if (type === 'success' || (type === 'info' && normalizedScore >= 70)) {
    colorClass = 'text-emerald-500';
    bgClass = 'bg-emerald-500';
  } else if (type === 'warning' || (type === 'info' && normalizedScore >= 40)) {
    colorClass = 'text-yellow-500';
    bgClass = 'bg-yellow-500';
  } else if (type === 'danger' || (type === 'info' && normalizedScore < 40)) {
    colorClass = 'text-rose-500';
    bgClass = 'bg-rose-500';
  }

  return (
    <div className={cn("flex flex-col items-center justify-center p-4 border rounded-xl bg-card", className)}>
      <div className="relative w-24 h-24 mb-2 flex items-center justify-center">
        <svg className="w-full h-full transform -rotate-90" viewBox="0 0 100 100">
          <circle
            className="text-muted stroke-current"
            strokeWidth="8"
            cx="50"
            cy="50"
            r="40"
            fill="transparent"
          />
          <circle
            className={cn(colorClass, "stroke-current transition-all duration-1000 ease-out")}
            strokeWidth="8"
            strokeLinecap="round"
            cx="50"
            cy="50"
            r="40"
            fill="transparent"
            strokeDasharray={`${(normalizedScore / 100) * 251.2} 251.2`}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center flex-col">
          <span className="text-2xl font-bold font-mono">{normalizedScore}</span>
        </div>
      </div>
      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
    </div>
  );
}
