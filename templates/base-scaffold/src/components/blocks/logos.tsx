import { Cluster, Section, Stack, Text } from '../layout/layout';
import type { SectionAnchor } from './types';

export interface LogosProps extends SectionAnchor { title?: string; logos: { name: string; src?: string }[] }

/** Sin `src` el logo es su nombre en texto: una marca sin archivo de logo no deja un hueco. */
export function Logos({ id, slug, title, logos }: LogosProps) {
  return (
    <Section id={id} slug={slug} role="logos" padding="md">
      <Stack gap="lg" align="center">
        {title ? <Text role="caption" align="center">{title}</Text> : null}
        <Cluster gap="xl" justify="center">
          {logos.map((l) => (l.src ? <img key={l.name} src={l.src} alt={l.name} height={32} /> : <Text key={l.name} role="subtitle">{l.name}</Text>))}
        </Cluster>
      </Stack>
    </Section>
  );
}
