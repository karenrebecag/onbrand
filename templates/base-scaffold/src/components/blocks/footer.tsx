import { Grid, Section, Stack, Text } from '../layout/layout';
import type { NavLink, SectionAnchor } from './types';
import './blocks.css';

export interface FooterProps extends SectionAnchor { brand: string; columns: { title: string; links: NavLink[] }[]; legal?: string }

export function Footer({ id, slug, brand, columns, legal }: FooterProps) {
  return (
    <Section id={id} slug={slug} role="footer" surface="muted" padding="md">
      <Stack gap="xl">
        <Grid cols={{ base: 2, md: columns.length + 1 }}>
          <Text role="body"><strong>{brand}</strong></Text>
          {columns.map((c) => (
            <Stack key={c.title} gap="sm">
              <Text role="caption">{c.title}</Text>
              <ul className="b-footer__links">{c.links.map((l) => <li key={l.href + l.label}><a href={l.href}>{l.label}</a></li>)}</ul>
            </Stack>
          ))}
        </Grid>
        {legal ? <Text role="caption">{legal}</Text> : null}
      </Stack>
    </Section>
  );
}
