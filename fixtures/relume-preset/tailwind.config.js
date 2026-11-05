import relumePreset from '@relume_io/relume-tailwind';

// Config per get_setup_instructions: el preset v3 publicado NO define text-h1…/text-medium/scheme-*/
// rounded-*; se añaden aquí o los encabezados colapsan a 16px y la página se ve plana.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  presets: [relumePreset],
  theme: {
    extend: {
      gradientColorStops: ({ theme }) => theme('colors'),
      // Escala FLUIDA con clamp(min, preferido, max): el preset v3 no escala por breakpoint, así
      // que el h1 medía 56px también en móvil. clamp() baja los encabezados en pantallas chicas.
      fontSize: {
        h1: ['clamp(2.25rem, 1.4rem + 3.8vw, 3.5rem)', { lineHeight: '1.15', letterSpacing: '-0.02em' }],
        h2: ['clamp(1.875rem, 1.2rem + 3vw, 3rem)', { lineHeight: '1.2', letterSpacing: '-0.015em' }],
        h3: ['clamp(1.5rem, 1.05rem + 2.2vw, 2.5rem)', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
        h4: ['clamp(1.375rem, 1.1rem + 1.3vw, 2rem)', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        h5: ['clamp(1.25rem, 1.1rem + 0.6vw, 1.5rem)', { lineHeight: '1.4', letterSpacing: '-0.01em' }],
        h6: ['clamp(1.125rem, 1.05rem + 0.3vw, 1.25rem)', { lineHeight: '1.4', letterSpacing: '-0.01em' }],
        large: ['1.25rem', { lineHeight: '1.5' }],
        medium: ['1.125rem', { lineHeight: '1.5' }],
        regular: ['1rem', { lineHeight: '1.5' }],
        small: ['0.875rem', { lineHeight: '1.5' }],
        tiny: ['0.75rem', { lineHeight: '1.5' }],
      },
      colors: {
        scheme: {
          background: '#ffffff',
          foreground: '#ffffff',
          text: '#000000',
          border: '#000000',
          'btn-text': '#ffffff',
        },
      },
      borderRadius: {
        button: '0.5rem',
        card: '0.75rem',
        image: '0.75rem',
        form: '0.5rem',
        badge: '0.25rem',
        checkbox: '0.25rem',
        carousel: '0.5rem',
        dropdown: '0.5rem',
      },
    },
  },
};
