import './ui.css';

export interface LinkProps {
  label: string;
  href: string;
}

export function Link({ label, href }: LinkProps) {
  return <a className="ui-link" href={href}>{label}</a>;
}
