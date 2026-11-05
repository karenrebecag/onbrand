import './ui.css';

// Set propio y chico en SVG inline (B9 §2.3): sin librería de iconos, un clon limpio no instala nada para dibujarlos.
const PATHS = {
  check: 'M5 12l5 5L20 7',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z',
  quote: 'M7 17c-2 0-3-1.5-3-3.5C4 10 6.5 7 10 6l.5 1.5C8.5 8.3 7.5 9.7 7.3 11H10v6zm9 0c-2 0-3-1.5-3-3.5 0-3.5 2.5-6.5 6-7.5l.5 1.5c-2 .8-3 2.2-3.2 3.5H19v6z',
} as const;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps {
  name: IconName;
  label?: string;
}

/** Sin `label` es decorativo y se oculta a los lectores de pantalla. */
export function Icon({ name, label }: IconProps) {
  const filled = name === 'star' || name === 'quote';
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={PATHS[name]} />
    </svg>
  );
}
