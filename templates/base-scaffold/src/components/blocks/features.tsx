import { Grid, Section, Stack, Text } from '../layout/layout';
import { Icon, type IconName } from '../ui/icon';
import type { SectionAnchor } from './types';

export interface FeaturesProps extends SectionAnchor { title: string; items: { icon?: IconName; title: string; body: string }[] }

export function Features({ id, slug, title, items }: FeaturesProps) {
  return (
    <Section id={id} slug={slug} role="features">
      <Stack gap="xl">
        <Text role="title" align="center">{title}</Text>
        <Grid cols={{ base: 1, md: 2, lg: 3 }}>
          {items.map((it) => (
            <Stack key={it.title} gap="sm">
              {it.icon ? <Icon name={it.icon} /> : null}
              <Text role="body"><strong>{it.title}</strong></Text>
              <Text role="caption">{it.body}</Text>
            </Stack>
          ))}
        </Grid>
      </Stack>
    </Section>
  );
}
