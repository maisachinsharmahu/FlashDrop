"use client";

import { Check, FileUp, FolderOpen, Image as ImageIcon, Pause, Play, Radio, RotateCcw, ShieldCheck, WifiOff, X } from "lucide-react";
import { bytesToHex, randomBytes } from "@noble/ciphers/utils.js";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

const CHUNK_SIZE = 8 * 1024 * 1024;
const RETRIES = 5;

type Encrypted = { ivHex: string; cipher: ArrayBuffer };
type CryptoJob = { id: number; key: Uint8Array; plain: Uint8Array; resolve: (value: Encrypted) => void; reject: (reason: Error) => void };
type CryptoSlot = { worker: Worker; busy: boolean; job?: CryptoJob };

class CryptoPool {
  private slots: CryptoSlot[];
  private queue: CryptoJob[] = [];
  private nextId = 1;

  constructor(size: number) {
    this.slots = Array.from({ length: size }, () => {
      const slot: CryptoSlot = {
        worker: new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module" }),
        busy: false,
      };
      slot.worker.onmessage = (event: MessageEvent<{ id: number; ivHex?: string; cipher?: ArrayBuffer; error?: string }>) => {
        const job = slot.job;
        slot.busy = false;
        slot.job = undefined;
        if (job && event.data.id === job.id) {
          if (event.data.error || !event.data.ivHex || !event.data.cipher) job.reject(new Error(event.data.error || "Encryption failed"));
          else job.resolve({ ivHex: event.data.ivHex, cipher: event.data.cipher });
        }
        this.dispatch();
      };
      slot.worker.onerror = () => {
        slot.job?.reject(new Error("Encryption worker stopped"));
        slot.busy = false;
        slot.job = undefined;
        this.dispatch();
      };
      return slot;
    });
  }

  encrypt(key: Uint8Array, plain: Uint8Array) {
    return new Promise<Encrypted>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, key, plain, resolve, reject });
      this.dispatch();
    });
  }

  private dispatch() {
    for (const slot of this.slots) {
      const job = this.queue.shift();
      if (!job) return;
      if (slot.busy) {
        this.queue.unshift(job);
        continue;
      }
      slot.busy = true;
      slot.job = job;
      const keyBuffer = job.key.slice().buffer as ArrayBuffer;
      const plainBuffer = job.plain.byteOffset === 0 && job.plain.byteLength === job.plain.buffer.byteLength
        ? job.plain.buffer as ArrayBuffer
        : job.plain.slice().buffer as ArrayBuffer;
      slot.worker.postMessage({ id: job.id, key: keyBuffer, plain: plainBuffer }, [keyBuffer, plainBuffer]);
    }
  }
}

let cryptoPool: CryptoPool | undefined;

function transferLanes() {
  return Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
}

function encryptOffThread(key: Uint8Array, value: Uint8Array) {
  cryptoPool ??= new CryptoPool(transferLanes());
  return cryptoPool.encrypt(key, value);
}

type Status = "queued" | "uploading" | "paused" | "done" | "error";
type Item = {
  key: string;
  file: File;
  status: Status;
  sent: number;
  speed: number;
  startedAt: number;
  uploadId?: string;
  error?: string;
};

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function base64UrlToBytes(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function UploadIcon({ item }: { item: Item }) {
  if (item.status === "done") return <Check size={18} />;
  if (item.status === "error") return <X size={18} />;
  if (item.file.type.startsWith("image/") || item.file.type.startsWith("video/")) return <ImageIcon size={18} />;
  return <FileUp size={18} />;
}

export function Sender() {
  const [session, setSession] = useState<{ id: string; rawKey: Uint8Array } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [connectionError, setConnectionError] = useState("");
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    const id = params.get("s");
    const key = params.get("k");
    if (!id || !key) {
      setConnectionError("This link is incomplete. Scan the QR again on your Mac.");
      return;
    }
    setSession({ id, rawKey: base64UrlToBytes(key) });
    history.replaceState(null, "", `${location.pathname}${location.hash}`);
  }, []);

  const totals = useMemo(() => {
    const total = items.reduce((sum, item) => sum + item.file.size, 0);
    const sent = items.reduce((sum, item) => sum + item.sent, 0);
    return { total, sent, percent: total ? Math.round((sent / total) * 100) : 0 };
  }, [items]);

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    setItems((current) => [
      ...current,
      ...selected.map((file) => ({
        key: `${file.name}:${file.size}:${file.lastModified}:${bytesToHex(randomBytes(8))}`,
        file,
        status: "queued" as const,
        sent: 0,
        speed: 0,
        startedAt: 0,
      })),
    ]);
    event.target.value = "";
  }

  function update(key: string, changes: Partial<Item>) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...changes } : item));
  }

  async function request(url: string, init: RequestInit, attempts = RETRIES): Promise<Response> {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 45_000);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (response.ok) return response;
        if (response.status < 500 && response.status !== 429) throw new Error(await response.text());
        last = new Error(`Receiver returned ${response.status}`);
      } catch (cause) { last = cause; }
      finally { window.clearTimeout(timeout); }
      await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempt)));
    }
    throw last instanceof Error ? last : new Error("Connection lost");
  }

  async function upload(item: Item) {
    const activeSession = session;
    if (!activeSession) return;
    const sessionId = activeSession.id;
    update(item.key, { status: "uploading", error: undefined, startedAt: Date.now() });
    const encryptionKey = activeSession.rawKey;
    const totalChunks = Math.ceil(item.file.size / CHUNK_SIZE);
    const metadata = new TextEncoder().encode(JSON.stringify({
      name: item.file.name,
      size: item.file.size,
      type: item.file.type,
      lastModified: item.file.lastModified,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      fingerprint: `${item.file.name}:${item.file.size}:${item.file.lastModified}`,
    }));
    try {
      const sealed = await encryptOffThread(encryptionKey, metadata);
      const initResponse = await request("/api/uploads/init", {
        method: "POST",
        headers: { "x-session-id": sessionId, "x-iv": sealed.ivHex },
        body: sealed.cipher,
      });
      const initialized = await initResponse.json() as { uploadId: string; received: number[] };
      update(item.key, { uploadId: initialized.uploadId });
      const done = new Set(initialized.received);
      let acknowledged = initialized.received.reduce((sum, index) => sum + Math.min(CHUNK_SIZE, item.file.size - index * CHUNK_SIZE), 0);
      const resumedBytes = acknowledged;
      update(item.key, { sent: acknowledged });
      const pending = Array.from({ length: totalChunks }, (_, index) => index).filter((index) => !done.has(index));
      let cursor = 0;
      const started = performance.now();

      async function worker() {
        while (cursor < pending.length) {
          const current = itemsRef.current.find((candidate) => candidate.key === item.key);
          if (!current || current.status === "paused") return;
          const index = pending[cursor++];
          const offset = index * CHUNK_SIZE;
          const plain = new Uint8Array(await item.file.slice(offset, Math.min(item.file.size, offset + CHUNK_SIZE)).arrayBuffer());
          const plainLength = plain.byteLength;
          const chunk = await encryptOffThread(encryptionKey, plain);
          await request(`/api/uploads/${initialized.uploadId}/chunks/${index}`, {
            method: "POST",
            headers: {
              "x-session-id": sessionId,
              "x-iv": chunk.ivHex,
              "x-offset": String(offset),
            },
            body: chunk.cipher,
          });
          acknowledged += plainLength;
          const elapsed = Math.max(0.25, (performance.now() - started) / 1000);
          update(item.key, { sent: acknowledged, speed: Math.max(0, (acknowledged - resumedBytes) / elapsed) });
        }
      }

      await Promise.all(Array.from({ length: Math.min(transferLanes(), pending.length || 1) }, worker));
      const latest = itemsRef.current.find((candidate) => candidate.key === item.key);
      if (latest?.status === "paused") return;
      const complete = await request(`/api/uploads/${initialized.uploadId}/complete`, {
        method: "POST",
        headers: { "x-session-id": sessionId },
      });
      const result = await complete.json() as { complete: boolean };
      if (!result.complete) throw new Error("Some chunks are still missing. Tap retry.");
      update(item.key, { status: "done", sent: item.file.size, speed: 0 });
    } catch (cause) {
      update(item.key, { status: "error", error: cause instanceof Error ? cause.message : "Transfer failed", speed: 0 });
    }
  }

  async function startAll() {
    setConnectionError("");
    for (const item of itemsRef.current) {
      if (item.status === "queued" || item.status === "paused" || item.status === "error") await upload(item);
    }
  }

  function pause(key: string) { update(key, { status: "paused", speed: 0 }); }
  function remove(key: string) { setItems((current) => current.filter((item) => item.key !== key)); }

  return (
    <main className="sender-shell">
      <header className="mobile-header"><span className="brand-mark"><Radio size={18} /></span><strong>FlashDrop</strong><span className="secure-pill"><ShieldCheck size={14} /> Private LAN</span></header>
      <section className="send-hero">
        <p className="eyebrow">SEND TO THIS MAC</p>
        <h1>Choose your files</h1>
        <p>Keep this page open while files transfer. Interrupted chunks retry automatically.</p>
      </section>

      {connectionError && <div className="connection-error"><WifiOff size={20} /><span>{connectionError}</span></div>}

      <section className="pick-grid">
        <label className="pick-card primary"><ImageIcon size={28} /><strong>Photos & videos</strong><span>Pick from Gallery</span><input type="file" accept="image/*,video/*" multiple onChange={addFiles} /></label>
        <label className="pick-card"><FolderOpen size={28} /><strong>Browse files</strong><span>Any file or folder item</span><input type="file" multiple onChange={addFiles} /></label>
      </section>

      {items.length > 0 && (
        <section className="queue-card">
          <div className="queue-summary"><div><strong>{items.length} {items.length === 1 ? "file" : "files"}</strong><span>{formatBytes(totals.sent)} of {formatBytes(totals.total)}</span></div><b>{totals.percent}%</b></div>
          <div className="overall-track"><span style={{ width: `${totals.percent}%` }} /></div>
          <div className="upload-list">
            {items.map((item) => {
              const percent = item.file.size ? Math.round((item.sent / item.file.size) * 100) : 0;
              return (
                <article className={`upload-item ${item.status}`} key={item.key}>
                  <span className="upload-icon"><UploadIcon item={item} /></span>
                  <div className="upload-info"><strong>{item.file.name}</strong><small>{item.status === "uploading" ? `${percent}% · ${formatBytes(item.speed)}/s · ${(item.speed * 8 / 1_000_000).toFixed(0)} Mbps` : item.status === "done" ? `${formatBytes(item.file.size)} · sent` : item.error ?? `${formatBytes(item.file.size)} · ${item.status}`}</small><div className="mini-track"><span style={{ width: `${percent}%` }} /></div></div>
                  {item.status === "uploading" ? <button onClick={() => pause(item.key)} aria-label="Pause"><Pause size={17} /></button> : item.status === "done" ? <span className="done-mark"><Check size={17} /></span> : item.status === "paused" || item.status === "error" ? <button onClick={() => void upload(item)} aria-label="Resume"><RotateCcw size={17} /></button> : <button onClick={() => remove(item.key)} aria-label="Remove"><X size={17} /></button>}
                </article>
              );
            })}
          </div>
          {items.some((item) => item.status !== "done" && item.status !== "uploading") && <button className="send-button" onClick={() => void startAll()} disabled={!session}><Play size={19} fill="currentColor" /> Send now</button>}
        </section>
      )}
      <p className="keep-awake">Speed shows both MB/s and Mbps. 2.5 MB/s = 20 Mbps. Keep both devices on 5 GHz Wi‑Fi and this screen awake.</p>
    </main>
  );
}
