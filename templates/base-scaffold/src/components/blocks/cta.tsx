import { Cluster, Section, Stack, Text } from '../layout/layout';
import { Button } from '../ui/button';
import type { Action, SectionAnchor } from './types';

export interface CtaProps extends SectionAnchor { title: string; subtitle?: string; actions: Action[] }

export function Cta({ id, slug, title, subtitle, actions }: CtaProps) {
  return (
    <Section id={id} slug={slug} role="cta" surface="inverse">
      <Stack gap="lg" align="center">
        <Text role="title" align="center">{title}</Text>
        {subtitle ? <Text role="subtitle" align="center">{subtitle}</Text> : null}
        <Cluster gap="sm" justify="center">{actions.map((a, i) => <Button key={a.label} {...a} variant={a.variant ?? (i ? 'secondary' : 'primary')} size="lg" />)}</Cluster>
      </Stack>
    </Section>
  );
}
