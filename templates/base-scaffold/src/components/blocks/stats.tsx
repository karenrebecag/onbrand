import { Grid, Section, Stack, Text } from '../layout/layout';
import './blocks.css';
import type { SectionAnchor } from './types';

export interface StatsProps extends SectionAnchor { items: { value: string; label: string }[] }

export function Stats({ id, slug, items }: StatsProps) {
  return (
    <Section id={id} slug={slug} role="stats" surface="muted" padding="md">
      <Grid cols={{ base: 2, lg: Math.min(items.length, 4) }}>
        {items.map((it) => (
          <Stack key={it.label} gap="xs" align="center">
            <span className="b-stat__value">{it.value}</span>
            <Text role="caption" align="center">{it.label}</Text>
          </Stack>
        ))}
      </Grid>
    </Section>
  );
}
