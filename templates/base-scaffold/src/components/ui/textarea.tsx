import './ui.css';

export interface TextareaProps {
  label: string;
  name: string;
  rows?: number;
  placeholder?: string;
}

export function Textarea({ label, name, rows = 4, placeholder }: TextareaProps) {
  return (
    <label className="ui-field">
      {label}
      <textarea className="ui-field__control" name={name} rows={rows} placeholder={placeholder} />
    </label>
  );
}
