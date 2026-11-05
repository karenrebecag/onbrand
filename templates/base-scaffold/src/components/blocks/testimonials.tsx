import { Cluster, Grid, Section, Stack, Text } from '../layout/layout';
import { Avatar } from '../ui/avatar';
import { Icon } from '../ui/icon';
import type { SectionAnchor } from './types';

export interface TestimonialsProps extends SectionAnchor { items: { quote: string; name: string; role?: string }[] }

export function Testimonials({ id, slug, items }: TestimonialsProps) {
  return (
    <Section id={id} slug={slug} role="testimonials">
      <Grid cols={{ base: 1, md: 2, lg: Math.min(items.length, 3) }}>
        {items.map((it) => (
          <figure key={it.name} style={{ margin: 0 }}>
            <Stack gap="md">
              <Icon name="quote" />
              <blockquote style={{ margin: 0 }}><Text role="body">{it.quote}</Text></blockquote>
              <figcaption>
                <Cluster gap="sm">
                  <Avatar name={it.name} />
                  <Stack gap="none"><Text role="body"><strong>{it.name}</strong></Text>{it.role ? <Text role="caption">{it.role}</Text> : null}</Stack>
                </Cluster>
              </figcaption>
            </Stack>
          </figure>
        ))}
      </Grid>
    </Section>
  );
}
