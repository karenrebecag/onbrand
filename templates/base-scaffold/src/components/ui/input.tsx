import './ui.css';

export interface InputProps {
  label: string;
  name: string;
  type?: 'text' | 'email' | 'tel' | 'url' | 'number' | 'password' | 'search';
  placeholder?: string;
}

export function Input({ label, name, type = 'text', placeholder }: InputProps) {
  return (
    <label className="ui-field">
      {label}
      <input className="ui-field__control" name={name} type={type} placeholder={placeholder} />
    </label>
  );
}
