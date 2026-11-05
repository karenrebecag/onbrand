// Fixture: bloque Relume genérico con un prop de contenido (featureCategories) que el copy del rol no
// llena, un prop de app (socialMediaLinks) y un numérico (count). Solo se leen sus Defaults.
type Props = Record<string, unknown>;

export const PricingDemoDefaults: Props = {
  heading: 'Pricing plan',
  description: 'Lorem ipsum dolor sit amet',
  pricingPlans: [{ planName: 'Basic', monthlyPrice: '$19', features: ['Feature text goes here'] }],
  featureCategories: [{ title: 'Feature text goes here', features: [{ text: 'Feature text goes here' }] }],
  socialMediaLinks: [{ url: '#', icon: null }],
  count: 3,
};

export const PricingDemo = (_props: Props) => null;
