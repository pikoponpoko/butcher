// Small shared controls.
import { useEffect, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { Status } from './image/exporter';
import { setSign, useSign } from './sign';
import { tr } from './i18n';

// Empty preview: the whole stage opens the file picker; files can also be dropped anywhere.
export function AddHint({ id, hidden }: { id?: string; hidden?: boolean }) {
  return (
    <span className="add" id={id} hidden={hidden}>
      <svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      <span className="fine">{tr('クリックまたはドロップで追加')}</span><span className="coarse">{tr('タップして追加')}</span>
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

// Small dropdown: a grid of choices opens under the button (a native select fills the screen on phones).
export function Pick<T extends string | number>({ id, label, value, options, onChange }: {
  id?: string; label: string; value: T; options: [T, ReactNode, ReactNode?][]; onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null), list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('pointerdown', off); addEventListener('keydown', key); addEventListener('resize', place); addEventListener('scroll', place, true);
    return () => { removeEventListener('pointerdown', off); removeEventListener('keydown', key); removeEventListener('resize', place); removeEventListener('scroll', place, true); };
  }, [open]);
  // fixed under the button so scrolling panels don't clip it; kept on screen (left / up when there is no room)
  function place() {
    const l = list.current, b = ref.current; if (!l || !b) return;
    const r = b.getBoundingClientRect(), w = l.offsetWidth, h = l.offsetHeight, vw = document.documentElement.clientWidth, vh = innerHeight;
    l.style.left = Math.max(8, Math.min(r.left, vw - 8 - w)) + 'px';
    l.style.top = (r.bottom + 4 + h > vh - 8 && r.top - 4 - h >= 8 ? r.top - 4 - h : r.bottom + 4) + 'px';
  }
  useLayoutEffect(() => { if (open) place(); }, [open]);
  const cur = options.find(o => o[0] === value);
  return (
    <span className="pick" ref={ref}>
      <button id={id} className="pickb" aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{cur ? cur[1] : ''}</span><svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && <div className="pickl" role="listbox" ref={list}>
        {options.map(([v, l, short]) => <button key={v} role="option" aria-selected={v === value} onClick={() => { onChange(v); setOpen(false); }}>{short ?? l}</button>)}
      </div>}
    </span>
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
      <span>{tr('署名')}</span>
      <input className="t" type="text" aria-label={tr('署名')} value={s.text} onChange={e => { const text = e.target.value; setSign(!s.text.trim() && text.trim() ? { text, on: true } : { text }); }} onKeyDown={e => e.stopPropagation()} />
      <label className="sw"><input type="checkbox" aria-label={tr('署名を入れる')} checked={s.on} onChange={e => setSign({ on: e.target.checked })} /></label>
    </div>
    <div className="prop signopt" hidden={!s.on}><span></span><span className="unit">
      <Seg value={s.size} options={[['s', tr('小')], ['m', tr('中')], ['l', tr('大')]]} onChange={size => setSign({ size })} />
      <Seg value={s.color} options={[['auto', tr('自動')], ['#ffffff', tr('白')], ['#000000', tr('黒')]]} onChange={color => setSign({ color })} />
    </span></div>
  </>;
}
