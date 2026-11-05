import type { ReactNode } from 'react';
import './ui.css';

export interface HeadingProps {
  level: 1 | 2 | 3 | 4;
  children: ReactNode;
}

export function Heading({ level, children }: HeadingProps) {
  const Tag = `h${level}` as const;
  return <Tag className={`ui-heading ui-heading--${level}`}>{children}</Tag>;
}
