// Small shared controls.
import { useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { Status } from './image/exporter';
import { setSign, useSign } from './sign';

// Empty preview: the whole stage opens the file picker; files can also be dropped anywhere.
export function AddHint({ id, hidden }: { id?: string; hidden?: boolean }) {
  return (
    <span className="add" id={id} hidden={hidden}>
      <svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <span className="fine">クリックまたはドロップで追加</span><span className="coarse">タップして追加</span>
    </span>
  );
}

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

// Name / credit stamp settings, shared by the image and GIF inspectors.
export function SignRows() {
  const s = useSign();
  return <>
    <div className="prop signrow">
      <span>署名</span>
      <input className="t" type="text" aria-label="署名" value={s.text} onChange={e => { const text = e.target.value; setSign(!s.text.trim() && text.trim() ? { text, on: true } : { text }); }} onKeyDown={e => e.stopPropagation()} />
      <label className="sw"><input type="checkbox" aria-label="署名を入れる" checked={s.on} onChange={e => setSign({ on: e.target.checked })} /></label>
    </div>
    <div className="prop signopt" hidden={!s.on}><span></span><span className="unit">
      <Seg value={s.size} options={[['s', '小'], ['m', '中'], ['l', '大']]} onChange={size => setSign({ size })} />
      <Seg value={s.color} options={[['auto', '自動'], ['#ffffff', '白'], ['#000000', '黒']]} onChange={color => setSign({ color })} />
    </span></div>
  </>;
}
