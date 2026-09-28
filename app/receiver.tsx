"use client";

import { Check, Copy, FolderOpen, QrCode, Radio, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";

type Bootstrap = {
  pairingUrl: string;
  displayUrl: string;
  destination: string;
  deviceName: string;
};

type ReceivedFile = { name: string; size: number; completedAt: string };

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function Receiver() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [qr, setQr] = useState("");
  const [files, setFiles] = useState<ReceivedFile[]>([]);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store" });
      if (!response.ok) throw new Error("Open this dashboard on the Mac running FlashDrop.");
      const data = (await response.json()) as Bootstrap & { recent: ReceivedFile[] };
      setBootstrap(data);
      setFiles(data.recent);
      setQr(await QRCode.toDataURL(data.pairingUrl, {
        width: 440,
        margin: 1,
        color: { dark: "#090a0c", light: "#ffffff" },
        errorCorrectionLevel: "M",
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start receiver.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/recent", { cache: "no-store" });
        if (response.ok) setFiles((await response.json()).recent);
      } catch { /* Mac can briefly change networks. */ }
    }, 1800);
    return () => window.clearInterval(timer);
  }, []);

  async function copyUrl() {
    if (!bootstrap) return;
    await navigator.clipboard.writeText(bootstrap.pairingUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <main className="receiver-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FlashDrop home">
          <span className="brand-mark"><Radio size={19} strokeWidth={2.5} /></span>
          <span>FlashDrop</span>
        </a>
        <div className="online"><span /> Receiver online</div>
      </header>

      <section className="receiver-grid">
        <div className="hero-copy">
          <p className="eyebrow">PHONE → MAC · DIRECT LAN</p>
          <h1>Send big files.<br /><span>Skip the cloud.</span></h1>
          <p className="lede">Scan once, pick from Gallery or Files, and transfer directly to this Mac over your Wi‑Fi.</p>

          <div className="url-box">
            <div><small>OPEN ON PHONE</small><strong>{bootstrap?.displayUrl ?? "Finding local address…"}</strong></div>
            <button onClick={copyUrl} disabled={!bootstrap} aria-label="Copy private link">
              {copied ? <Check size={19} /> : <Copy size={19} />}
            </button>
          </div>

          <div className="trust-row">
            <span><ShieldCheck size={17} /> Encrypted chunks</span>
            <span><RefreshCw size={17} /> Auto retry</span>
            <span><FolderOpen size={17} /> Saves to Downloads</span>
          </div>
        </div>

        <aside className="qr-card">
          <div className="qr-heading"><QrCode size={20} /><span>SCAN TO SEND</span></div>
          <div className="qr-frame">
            {qr ? <img src={qr} alt="QR code to open FlashDrop on your phone" /> : <div className="qr-loading" />}
          </div>
          <div className="scan-hint"><Smartphone size={20} /><span>Same Wi‑Fi required<br /><small>No app needed on phone</small></span></div>
          {error && <p className="error-text">{error}</p>}
        </aside>
      </section>

      <section className="activity">
        <div className="section-title"><div><span className="pulse-dot" /> LIVE ACTIVITY</div><small>{files.length ? `${files.length} received` : "Waiting for phone"}</small></div>
        {files.length === 0 ? (
          <div className="empty-state"><Radio size={27} /><span>Ready for your first transfer</span></div>
        ) : (
          <div className="file-list">
            {files.map((file) => (
              <div className="received-file" key={`${file.name}-${file.completedAt}`}>
                <span className="file-check"><Check size={16} /></span>
                <div><strong>{file.name}</strong><small>{bytes(file.size)} · saved</small></div>
                <time>{new Date(file.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer>Files save to <strong>{bootstrap?.destination ?? "Downloads/FlashDrop"}</strong></footer>
    </main>
  );
}
