import { Grid, Section, Stack, Text } from '../layout/layout';
import './blocks.css';
import type { SectionAnchor } from './types';

export interface StepsProps extends SectionAnchor { title: string; items: { title: string; body: string }[] }

export function Steps({ id, slug, title, items }: StepsProps) {
  return (
    <Section id={id} slug={slug} role="steps">
      <Stack gap="xl">
        <Text role="title" align="center">{title}</Text>
        <Grid cols={{ base: 1, md: Math.min(items.length, 3) }}>
          {items.map((it, i) => (
            <Stack key={it.title} gap="sm">
              <span className="b-step__n" aria-hidden="true">{i + 1}</span>
              <Text role="body"><strong>{it.title}</strong></Text>
              <Text role="caption">{it.body}</Text>
            </Stack>
          ))}
        </Grid>
      </Stack>
    </Section>
  );
}
