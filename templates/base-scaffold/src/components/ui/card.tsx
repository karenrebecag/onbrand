import type { ReactNode } from 'react';
import './ui.css';

export interface CardProps {
  title: string;
  body?: string;
  media?: ReactNode;
  action?: ReactNode;
}

export function Card({ title, body, media, action }: CardProps) {
  return (
    <article className="ui-card">
      {media ? <div className="ui-card__media">{media}</div> : null}
      <h3 className="ui-card__title">{title}</h3>
      {body ? <p className="ui-card__body">{body}</p> : null}
      {action ? <div className="ui-card__action">{action}</div> : null}
    </article>
  );
}
