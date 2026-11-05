import type { CSSProperties } from 'react';
import './ui.css';

const TONE = { neutral: 'var(--text-secondary)', accent: 'var(--accent-strong)', success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)', info: 'var(--info)' } as const;

export interface BadgeProps {
  label: string;
  tone?: keyof typeof TONE;
}

export function Badge({ label, tone = 'accent' }: BadgeProps) {
  return <span className="ui-badge" style={{ '--ui-tone': TONE[tone] } as CSSProperties}>{label}</span>;
}
