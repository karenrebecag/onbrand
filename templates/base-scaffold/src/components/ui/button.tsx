import './ui.css';

export interface ButtonProps {
  label: string;
  href?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  type?: 'button' | 'submit';
}

/** Con `href` es un enlace (navega), sin él un botón (acción): la semántica sigue a lo que hace. */
export function Button({ label, href, variant = 'primary', size = 'md', type = 'button' }: ButtonProps) {
  const className = `ui-button ui-button--${variant} ui-button--${size}`;
  return href ? <a className={className} href={href}>{label}</a> : <button className={className} type={type}>{label}</button>;
}
