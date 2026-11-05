import { Section, Stack, Text } from '../layout/layout';
import { Accordion } from '../ui/accordion';
import type { SectionAnchor } from './types';

export interface FaqProps extends SectionAnchor { title: string; items: { title: string; content: string }[] }

export function Faq({ id, slug, title, items }: FaqProps) {
  return (
    <Section id={id} slug={slug} role="faq">
      <Stack gap="lg">
        <Text role="title" align="center">{title}</Text>
        <Accordion items={items} />
      </Stack>
    </Section>
  );
}
