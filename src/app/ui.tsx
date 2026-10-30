// Small shared controls.
import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { Status } from './image/exporter';

// Segmented control: one pressed button per value.
export function Seg<T extends string>({ id, value, options, onChange, hiddenValues, hidden, disabled }: {
  id?: string; hidden?: boolean; disabled?: boolean; value: T; options: [T, ReactNode][]; onChange: (v: T) => void; hiddenValues?: T[];
}) {
  return (
    <div className="seg" id={id} hidden={hidden}>
      {options.map(([v, label]) => (
        <button key={v} data-v={v} aria-pressed={v === value} disabled={disabled} hidden={hiddenValues?.includes(v)} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

// Segmented control where any number of buttons can be pressed.
export function Toggles<T extends string>({ id, values, options, onToggle }: { id?: string; values: T[]; options: [T, ReactNode][]; onToggle: (v: T) => void }) {
  return (
    <div className="seg" id={id}>
      {options.map(([v, label]) => <button key={v} data-v={v} aria-pressed={values.includes(v)} onClick={() => onToggle(v)}>{label}</button>)}
    </div>
  );
}

// Text/number input that keeps what the user is typing while focused and shows `value` otherwise.
export function DraftInput({ value, onDraft, onBlur, onFocus, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string | number; onDraft: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input {...rest} value={draft ?? String(value)}
      onFocus={e => { setDraft(String(value)); onFocus?.(e); }}
      onChange={e => { setDraft(e.target.value); onDraft(e.target.value); }}
      onBlur={e => { setDraft(null); onBlur?.(e); }} />
  );
}

export function StatusText({ s }: { s: Status }) {
  return <>{s.map((p, i) => p.c ? <span key={i} className={p.c}>{p.t}</span> : p.t)}</>;
}
