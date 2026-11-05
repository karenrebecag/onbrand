import './ui.css';

export interface AvatarProps {
  name: string;
  src?: string;
}

const initials = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export function Avatar({ name, src }: AvatarProps) {
  return <span className="ui-avatar">{src ? <img src={src} alt={name} /> : <span aria-label={name} role="img">{initials(name)}</span>}</span>;
}
