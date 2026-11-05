import type { ReactNode } from 'react';
import { Icon } from './icon';
import './ui.css';

export interface AccordionProps {
  items: { title: string; content: ReactNode }[];
}

/** <details>/<summary> nativos: teclado y lector de pantalla sin JS ni Radix. */
export function Accordion({ items }: AccordionProps) {
  return (
    <div className="ui-accordion">
      {items.map((item) => (
        <details className="ui-accordion__item" key={item.title}>
          <summary className="ui-accordion__summary">
            {item.title}
            <span className="ui-accordion__plus"><Icon name="plus" /></span>
            <span className="ui-accordion__minus"><Icon name="minus" /></span>
          </summary>
          <div className="ui-accordion__content">{item.content}</div>
        </details>
      ))}
    </div>
  );
}
