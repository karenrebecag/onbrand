import { Grid, Section, Stack, Text } from '../layout/layout';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import type { Action, SectionAnchor } from './types';
import './blocks.css';

export interface PricingProps extends SectionAnchor { title?: string; plans: { name: string; price: string; features: string[]; action: Action }[] }

export function Pricing({ id, slug, title, plans }: PricingProps) {
  return (
    <Section id={id} slug={slug} role="pricing">
      <Stack gap="xl">
        {title ? <Text role="title" align="center">{title}</Text> : null}
        <Grid cols={{ base: 1, md: Math.min(plans.length, 3) }}>
          {plans.map((p) => (
            <div key={p.name} className="ui-card">
              <Text role="body"><strong>{p.name}</strong></Text>
              <span className="b-plan__price">{p.price}</span>
              <ul className="b-list">{p.features.map((f) => <li key={f}><Icon name="check" />{f}</li>)}</ul>
              <div className="ui-card__action"><Button {...p.action} /></div>
            </div>
          ))}
        </Grid>
      </Stack>
    </Section>
  );
}
