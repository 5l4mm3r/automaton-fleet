'use client';
import { useEffect, useRef, useState } from 'react';

export type Field = { key: string; label: string; value?: string; options?: { value: string; label: string }[]; type?: string; hint?: string };
export type Action = { title: string; op: string; args?: Record<string,string>; fields?: Field[]; sensitive?: boolean; description?: string };
export function ActionDialog({ action, submit, close }: { action: Action; submit: (args: Record<string,string>) => Promise<void>; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [stage,setStage] = useState<'edit'|'confirm'>('edit');
  const [args,setArgs] = useState<Record<string,string>>(() => ({ ...action.args, ...Object.fromEntries((action.fields||[]).map(f => [f.key,f.value ?? f.options?.[0]?.value ?? ''])) }));
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const lock = useRef(false);
  useEffect(() => { const el = ref.current; el?.showModal(); return () => el?.close(); },[]);
  return <dialog ref={ref} onCancel={e => { if(busy) e.preventDefault(); else close(); }} className="dialog">
    <form onSubmit={async e => { e.preventDefault(); if(lock.current) return; if(stage === 'edit') {setStage('confirm');return;} lock.current=true;setBusy(true);setError('');try {await submit(args);close();}catch(e){setError(e instanceof Error?e.message:'Operation failed');}finally{lock.current=false;setBusy(false);} }}>
      <div className="eyebrow">SIMULATION / OWNER CONTROL</div><h2>{action.title}</h2>
      <p>{action.description || 'This changes fictional Fleet data only.'}</p>
      {stage === 'edit' ? (action.fields||[]).map(f => <label className="field" key={f.key}>{f.label}{f.options ? <select value={args[f.key]} onChange={e=>setArgs({...args,[f.key]:e.target.value})}>{f.options.map(o=><option value={o.value} key={o.value}>{o.label}</option>)}</select> : <input autoComplete="off" required maxLength={240} type={f.type||'text'} value={args[f.key]} onChange={e=>setArgs({...args,[f.key]:e.target.value})} />}{f.hint && <small>{f.hint}</small>}</label>) : <div className="confirmation"><h3>Review simulation changes</h3><dl>{Object.entries(args).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>{action.sensitive && <p className="warning">Simulated step-up: confirming represents an owner authentication check. No real passkey is used.</p>}</div>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button type="button" disabled={busy} onClick={close}>Cancel</button>{stage==='confirm' && <button type="button" disabled={busy} onClick={()=>setStage('edit')}>Edit</button>}<button className="primary" disabled={busy}>{busy?'Applying…':stage==='edit'?'Review changes':action.sensitive?'Confirm simulated step-up':'Apply simulation'}</button></div>
    </form>
  </dialog>;
}

export function RevealDialog({ kind, close }: { kind: 'document'|'credential'; close: () => void }) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const el=ref.current;el?.showModal();const timeout=setTimeout(close,60000);return()=>{clearTimeout(timeout);el?.close();};},[close]);
  return <dialog ref={ref} className="dialog" onCancel={close}><div className="eyebrow">FICTIONAL SAMPLE · CLOSES AFTER 60 SECONDS</div><h2>{kind==='document'?'Sample identity card':'Sample credential'}</h2>{kind==='document'?<div className="identity-card"><span>FLEET / TRAINING ID</span><h3>ALEX EXAMPLE</h3><p>000 DEMO STREET · EXAMPLE CITY</p><p>ID: FICTIONAL-0000</p><strong>NOT A VALID IDENTITY DOCUMENT</strong></div>:<div className="secret">DEMO-ONLY-NOT-A-REAL-KEY-0000</div>}<p>This sample is not encrypted and contains no personal data. Live reveals require the verified broker implementation.</p><button className="primary" onClick={close}>Close and clear preview</button></dialog>;
}

