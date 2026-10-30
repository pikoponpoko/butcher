// Small shared controls.
import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { Status } from './image/exporter';
import { setSign, useSign } from './sign';

// Segmented control: one pressed button per value.
export function Seg<T extends string>({ id, value, options, onChange, hiddenValues, hidden }: {
  id?: string; hidden?: boolean; value: T; options: [T, ReactNode][]; onChange: (v: T) => void; hiddenValues?: T[];
}) {
  return (
    <div className="seg" id={id} hidden={hidden}>
      {options.map(([v, label]) => (
        <button key={v} data-v={v} aria-pressed={v === value} hidden={hiddenValues?.includes(v)} onClick={() => onChange(v)}>{label}</button>
      ))}
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

// Name / credit stamp settings, shared by the image and GIF inspectors.
export function SignRows() {
  const s = useSign();
  return <>
    <div className="prop signrow">
      <span>署名</span>
      <input className="t" type="text" aria-label="署名" value={s.text} onChange={e => setSign({ text: e.target.value })} onKeyDown={e => e.stopPropagation()} />
      <label className="sw"><input type="checkbox" aria-label="署名を入れる" checked={s.on} onChange={e => setSign({ on: e.target.checked })} /></label>
    </div>
    <div className="prop signopt" hidden={!s.on}><span></span><span className="unit">
      <Seg value={s.size} options={[['s', '小'], ['m', '中'], ['l', '大']]} onChange={size => setSign({ size })} />
      <Seg value={s.color} options={[['#ffffff', '白'], ['#000000', '黒']]} onChange={color => setSign({ color })} />
    </span></div>
  </>;
}
