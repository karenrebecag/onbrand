import { Section } from '../layout/layout';
import { Button } from '../ui/button';
import type { Action, NavLink, SectionAnchor } from './types';
import './blocks.css';

export interface NavbarProps extends SectionAnchor { brand: string; links: NavLink[]; action?: Action }

export function Navbar({ id, slug, brand, links, action }: NavbarProps) {
  return (
    <Section id={id} slug={slug} role="navbar" padding="none" width="wide">
      <nav className="b-navbar" aria-label="Principal">
        <a className="b-navbar__brand" href="#">{brand}</a>
        <ul className="b-navbar__links">{links.map((l) => <li key={l.href}><a href={l.href}>{l.label}</a></li>)}</ul>
        {action ? <Button {...action} size="sm" /> : null}
      </nav>
    </Section>
  );
}
