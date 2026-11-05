import type { ReactNode } from 'react';
import { Cluster, Section, Split, Stack, Text } from '../layout/layout';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { Action, SectionAnchor } from './types';

export interface HeroProps extends SectionAnchor { eyebrow?: string; title: string; subtitle?: string; actions: Action[]; media?: ReactNode }

export function Hero({ id, slug, eyebrow, title, subtitle, actions, media }: HeroProps) {
  const copy = (
    <Stack gap="lg" align={media ? 'start' : 'center'}>
      {eyebrow ? <Badge label={eyebrow} /> : null}
      <Text role="display" align={media ? 'start' : 'center'}>{title}</Text>
      {subtitle ? <Text role="subtitle" align={media ? 'start' : 'center'}>{subtitle}</Text> : null}
      <Cluster gap="sm" justify={media ? 'start' : 'center'}>{actions.map((a, i) => <Button key={a.label} {...a} variant={a.variant ?? (i ? 'secondary' : 'primary')} size="lg" />)}</Cluster>
    </Stack>
  );
  return <Section id={id} slug={slug} role="hero">{media ? <Split>{copy}{media}</Split> : copy}</Section>;
}
