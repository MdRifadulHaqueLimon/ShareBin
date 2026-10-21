'use client';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { motion, AnimatePresence } from 'framer-motion';
import { Sun, Moon, Copy, Check, Flame, Download, ArrowRight, Clock, FileUp, Link2, RefreshCw, Trash2, Eraser, File as FileIcon } from 'lucide-react';
import { detectLanguages, labelOf } from '../lib/detect.js';
import { encryptFile, decryptFile } from '../lib/clientCrypto.js';

const Editor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => <div className="skeleton" style={{ height: '100%' }} />,
});

const MAX_FILE = 10 * 1024 * 1024;   // 10 MB
const MAX_TEXT = 200_000;

const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const fmtSize = (b) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.ceil(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const isMedia = (mime) => /^(image|video)\//.test(mime || '');

function useCountdown(expiresAt) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [expiresAt]);
  return left;
}
const toBase64 = (file) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] || '');
  r.onerror = () => rej(new Error('Could not read that file'));
  r.readAsDataURL(file);
});
const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Direct browser -> Cloudflare R2 upload (XHR, because fetch cannot report upload progress)
function putFile(url, data, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`Upload failed (${x.status}). Check the R2 bucket CORS settings.`)));
    x.onerror = () => reject(new Error('Upload failed. Check your connection and the R2 bucket CORS settings.'));
    x.send(data);
  });
}

const editorOpts = { minimap: { enabled: false }, fontSize: 14, scrollBeyondLastLine: false, automaticLayout: true,
  fontFamily: 'JetBrains Mono, ui-monospace, monospace', padding: { top: 12 } };

function CopyBtn({ value, label }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn" onClick={async () => {
      try { await navigator.clipboard.writeText(value); setOk(true); setTimeout(() => setOk(false), 1500); } catch {}
    }}>
      {ok ? <Check size={16} /> : <Copy size={16} />} {ok ? 'Copied' : label}
    </button>
  );
}

function LangTags({ langs, hasText }) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-live="polite">
      <span className="muted text-sm">Language</span>
      {langs.length
        ? langs.map((l) => <span key={l} className="lang-tag mono">[{labelOf(l)}]</span>)
        : <span className="muted text-sm">{hasText ? 'Plain text' : 'Detected automatically as you paste'}</span>}
    </div>
  );
}

function FileView({ data }) {
  const [st, setSt] = useState({ status: 'loading', url: '', err: '' });
  useEffect(() => {
    let dead = false, objectUrl = '';
    (async () => {
      try {
        let bytes;
        if (data.storage === 'r2') {
          const res = await fetch(data.url);
          if (!res.ok) throw new Error('Download failed. The file may have expired.');
          bytes = await decryptFile(await res.arrayBuffer(), data.k);
        } else {
          bytes = fromBase64(data.content);
        }
        // only images and videos keep their type; anything else is a plain download
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: isMedia(data.mime) ? data.mime : 'application/octet-stream' }));
        if (dead) URL.revokeObjectURL(objectUrl); else setSt({ status: 'ready', url: objectUrl, err: '' });
      } catch (e) {
        if (!dead) setSt({ status: 'error', url: '', err: e.message });
      }
    })();
    return () => { dead = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [data]);

  if (st.status === 'loading') return <div className="skeleton" style={{ height: 160 }} aria-label="Downloading and decrypting" />;
  if (st.status === 'error') return <p role="alert" style={{ color: 'var(--danger)' }}>{st.err}</p>;
  return (
    <>
      {data.mime.startsWith('image/') && <img src={st.url} alt={data.name} className="max-h-96 rounded-xl object-contain" />}
      {data.mime.startsWith('video/') && <video src={st.url} controls className="max-h-96 w-full rounded-xl" />}
      <a className="btn btn-primary w-fit" href={st.url} download={data.name}>
        <Download size={16} /> Download {data.name}{data.size ? ` (${fmtSize(data.size)})` : ''}
      </a>
    </>
  );
}

function Viewer({ data, dark, onClose }) {
  const left = useCountdown(data.expiresAt);
  const expired = left === 0;
  const langs = data.langs?.length ? data.langs : data.lang && data.lang !== 'plaintext' ? [data.lang] : [];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="mono text-2xl font-bold tracking-widest">{data.code}</span>
          {data.burn && <span className="muted flex items-center gap-1 text-sm"><Flame size={14} /> Deleted after this view</span>}
        </div>
        <span className="muted flex items-center gap-1 mono"><Clock size={14} /> {expired ? 'Expired' : fmt(left)}</span>
      </div>
      {expired ? (
        <p className="muted py-16 text-center">This share has expired and is gone from the server.</p>
      ) : data.type === 'code' ? (
        <>
          <LangTags langs={langs} hasText />
          <div className="overflow-hidden rounded-xl" style={{ height: 380, border: '1px solid var(--border)' }}>
            <Editor value={data.content} language={data.lang} theme={dark ? 'vs-dark' : 'light'} options={{ ...editorOpts, readOnly: true }} />
          </div>
          <div><CopyBtn value={data.content} label="Copy code" /></div>
        </>
      ) : data.type === 'text' ? (
        <>
          <pre className="field mono max-h-96 overflow-auto whitespace-pre-wrap text-sm">{data.content}</pre>
          <div><CopyBtn value={data.content} label="Copy text" /></div>
        </>
      ) : <FileView data={data} />}
      <button className="btn w-fit" onClick={onClose}>Close</button>
    </div>
  );
}

function Result({ result, onReset }) {
  const left = useCountdown(result.expiresAt);
  const link = typeof window !== 'undefined' ? `${location.origin}/#${encodeURIComponent(result.code)}` : '';
  return (
    <div className="flex flex-col items-center gap-5 py-6 text-center">
      <p className="muted">Share this code. The receiver types it in the top bar.</p>
      <div className="mono text-5xl font-bold tracking-[.3em] sm:text-6xl" aria-label={`Code ${result.code.split('').join(' ')}`}>{result.code}</div>
      <p className="mono muted flex items-center gap-2"><Clock size={16} /> {left ? `Gone in ${fmt(left)}` : 'Expired'}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <CopyBtn value={result.code} label="Copy code" />
        <CopyBtn value={link} label="Copy link" />
      </div>
      <button className="btn" onClick={onReset}>Share something else</button>
    </div>
  );
}

export default function Home() {
  const [dark, setDark] = useState(true);
  const [tab, setTab] = useState('code');
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState({ file: null, url: '' });
  const [drag, setDrag] = useState(false);
  const [mins, setMins] = useState(5);
  const [burn, setBurn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState(null);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);
  const [codeIn, setCodeIn] = useState('');
  const [recv, setRecv] = useState(null);
  const [recvErr, setRecvErr] = useState('');
  const fileRef = useRef(null);
  const textFileRef = useRef(null);

  // automatic language detection (no dropdown): re-runs as you type, without blocking typing
  const deferredText = useDeferredValue(text);
  const det = useMemo(() => (tab === 'code' ? detectLanguages(deferredText) : { langs: [], primary: 'plaintext' }), [deferredText, tab]);

  useEffect(() => {
    try { const s = localStorage.getItem('theme'); if (s) setDark(s === 'dark'); } catch {}
    let h = '';
    try { h = decodeURIComponent(location.hash.slice(1)); } catch {}
    if ([...h].length === 5) { setCodeIn(h); open(h); }
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.classList.toggle('light', !dark);
    try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch {}
  }, [dark]);
  // Preview of the chosen image / video. The URL is stored together with the file it belongs to, so a
  // revoked URL can never be shown for a newly chosen file.
  const previewUrl = preview.file === file ? preview.url : '';
  useEffect(() => {
    if (!file || !isMedia(file.type)) return;
    const u = URL.createObjectURL(file);
    setPreview({ file, url: u });
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // ---- choosing / replacing what to share (timer + delete-after-view settings are untouched) ----
  function pickFile(f) {
    if (!f || busy) return;
    if (f.size === 0) { setErr('That file is empty. Choose another one.'); return; }
    if (f.size > MAX_FILE) { setErr(`That file is ${fmtSize(f.size)}. The limit is 10 MB. Your current selection is unchanged.`); return; }
    setErr(''); setFile(f);
  }
  const onFileInput = (e) => { pickFile(e.target.files?.[0]); e.target.value = ''; };   // reset so the same file can be picked again
  const onDrop = (e) => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files?.[0]); };
  const onDragOver = (e) => { e.preventDefault(); if (!busy) setDrag(true); };

  async function loadTextFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || busy) return;
    if (f.size > 1_000_000) { setErr('That file is too large to open as text. Use the File tab for files up to 10 MB.'); return; }
    const t = await f.text();
    if (t.includes('\u0000')) { setErr('That looks like a binary file. Use the File tab to share it.'); return; }
    if (t.length > MAX_TEXT) { setErr('Text is over the 200,000 character limit'); return; }
    setErr(''); setText(t);
  }

  async function share() {
    setErr(''); setBusy(true); setProgress(null); setPhase('Preparing…');
    try {
      let body = { ttl: mins * 60, burn };
      if (tab === 'file') {
        if (!file) throw new Error('Choose a file first');
        if (file.size > MAX_FILE) throw new Error('Files can be up to 10 MB');
        const mime = file.type || 'application/octet-stream';
        const up = await api('/api/upload', post({ name: file.name, mime, size: file.size }));
        if (up.mode === 'r2') {
          setPhase('Encrypting…');
          const { data, key } = await encryptFile(await file.arrayBuffer());
          setPhase('Uploading'); setProgress(0);
          await putFile(up.uploadUrl, data, setProgress);
          setPhase('Finishing…'); setProgress(null);
          body = { ...body, type: 'file', key: up.key, k: key };
        } else {
          setPhase('Encrypting…');
          body = { ...body, type: 'file', name: file.name, mime, content: await toBase64(file) };
        }
      } else {
        if (!text.trim()) throw new Error('Add some ' + (tab === 'code' ? 'code' : 'text') + ' first');
        body = { ...body, type: tab, content: text };
        if (tab === 'code') { const d = detectLanguages(text); body = { ...body, lang: d.primary, langs: d.langs }; }
      }
      const j = await api('/api/share', post(body));
      setRecv(null); setResult({ code: j.code, expiresAt: Date.now() + j.ttl * 1000 });
    } catch (e) { setErr(e.message); } finally { setBusy(false); setPhase(''); setProgress(null); }
  }
  async function open(c) {
    const code = String(c ?? codeIn).trim();
    setRecvErr(''); setRecv(null);
    try {
      const j = await api('/api/fetch/' + encodeURIComponent(code));
      setResult(null); setRecv({ ...j, code, expiresAt: Date.now() + j.ttl * 1000 });
    } catch (e) { setRecvErr(e.message); }
  }

  const shareLabel = !busy ? 'Share' : progress !== null ? `Uploading ${Math.round(progress * 100)}%` : phase || 'Sharing…';

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-5 sm:px-8">
      <header className="glass flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="mr-auto flex items-center gap-2 text-xl font-bold">
          <img src="/favicon-32x32.png" alt="" width={26} height={26} /> ShareBin
        </div>
        <form className="flex w-full gap-2 sm:w-auto" onSubmit={(e) => { e.preventDefault(); open(); }}>
          <input className="field mono w-full text-center tracking-[.3em] sm:w-44" value={codeIn} maxLength={5}
            autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
            onChange={(e) => setCodeIn(e.target.value)} placeholder="2Y@xG" aria-label="Enter 5-character code (case-sensitive)" />
          <button className="btn btn-primary" type="submit">Open <ArrowRight size={16} /></button>
        </form>
        <button className="btn" onClick={() => setDark(!dark)} aria-label="Toggle light and dark theme">{dark ? <Sun size={16} /> : <Moon size={16} />}</button>
      </header>
      {recvErr && <p role="alert" style={{ color: 'var(--danger)' }}>{recvErr}</p>}

      <main className="grid flex-1 gap-6 lg:grid-cols-2">
        <section className="glass flex flex-col gap-4 p-5">
          <h1 className="text-2xl font-bold">Share it for a few minutes</h1>
          <div role="tablist" className="flex gap-1">
            {[['code', 'Code'], ['text', 'Text'], ['file', 'File']].map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className="tab" onClick={() => { setTab(k); setErr(''); }}>{l}</button>
            ))}
          </div>

          {tab !== 'file' && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                {tab === 'code' ? <LangTags langs={det.langs} hasText={!!text.trim()} /> : <span className="muted text-sm">Plain text</span>}
                <div className="flex gap-2">
                  <button className="btn btn-sm" disabled={busy} onClick={() => textFileRef.current?.click()}>
                    <RefreshCw size={14} /> {text ? 'Replace from file' : 'Load from file'}
                  </button>
                  <button className="btn btn-sm" disabled={busy || !text} onClick={() => { setText(''); setErr(''); }}>
                    <Eraser size={14} /> Clear
                  </button>
                </div>
                <input ref={textFileRef} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={loadTextFile} />
              </div>
              {tab === 'code'
                ? (
                  <div className="overflow-hidden rounded-xl" style={{ height: 340, border: '1px solid var(--border)' }}>
                    <Editor value={text} onChange={(v) => setText(v || '')} language={det.primary} theme={dark ? 'vs-dark' : 'light'} options={editorOpts} />
                  </div>
                )
                : <textarea className="field mono h-[340px] resize-none" value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste or type anything" />}
            </>
          )}

          {tab === 'file' && (
            <>
              <input ref={fileRef} type="file" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onFileInput} />
              {!file ? (
                <button type="button" className="field dropzone flex h-[390px] flex-col items-center justify-center gap-3 text-center" data-drag={drag}
                  onClick={() => fileRef.current?.click()} onDragOver={onDragOver} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
                  <FileUp size={36} style={{ color: 'var(--accent)' }} />
                  <span>Choose an image, video or file</span>
                  <span className="muted text-sm">Up to 10 MB</span>
                </button>
              ) : (
                <div className="field dropzone flex h-[390px] flex-col gap-4 p-4" data-drag={drag} style={{ cursor: 'default' }}
                  onDragOver={onDragOver} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
                  <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl" style={{ background: 'var(--glass)' }}>
                    {previewUrl && file.type.startsWith('image/') ? <img src={previewUrl} alt={`Preview of ${file.name}`} className="max-h-full max-w-full object-contain" />
                      : previewUrl && file.type.startsWith('video/') ? <video src={previewUrl} controls className="max-h-full max-w-full" />
                      : <FileIcon size={56} className="muted" />}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{file.name}</p>
                      <p className="muted text-sm">{fmtSize(file.size)}. Up to 10 MB. Drop another file here to replace it.</p>
                    </div>
                    <button className="btn btn-sm" disabled={busy} onClick={() => fileRef.current?.click()}><RefreshCw size={14} /> Replace file</button>
                    <button className="btn btn-sm" disabled={busy} onClick={() => { setFile(null); setErr(''); }}><Trash2 size={14} /> Remove</button>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="mono text-sm">Disappears in {mins} {mins === 1 ? 'minute' : 'minutes'}</span>
              <input type="range" min="1" max="10" value={mins} onChange={(e) => setMins(Number(e.target.value))} />
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} /> <Flame size={16} /> Delete after the first view</label>
          </div>
          {err && <p role="alert" style={{ color: 'var(--danger)' }}>{err}</p>}
          {progress !== null && (
            <div className="progress" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
              <span style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={share}>{shareLabel}</button>
        </section>

        <section className="glass p-5">
          <AnimatePresence mode="wait">
            <motion.div key={recv ? 'recv-' + recv.code : result ? 'res-' + result.code : 'empty'}
              initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: .2 }}>
              {recv ? <Viewer data={recv} dark={dark} onClose={() => { setRecv(null); history.replaceState(null, '', '/'); }} />
                : result ? <Result result={result} onReset={() => { setResult(null); setText(''); setFile(null); }} />
                : (
                  <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-2 text-center">
                    <Link2 size={32} className="muted" />
                    <p className="font-semibold">Your code will show up here</p>
                    <p className="muted max-w-xs text-sm">Or enter a 5-character code in the top bar to open someone else’s share.</p>
                  </div>
                )}
            </motion.div>
          </AnimatePresence>
        </section>
      </main>
      <footer className="muted pb-2 text-center text-sm">© 2026 ShareBin. All rights reserved.</footer>
    </div>
  );
}
