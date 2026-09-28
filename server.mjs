import { createServer } from "node:http";
import { createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const hostname = "0.0.0.0";
const port = Number(process.env.PORT || 43110);
const lanIp = process.env.FLASHDROP_HOST || findLanIp();
const destination = process.env.FLASHDROP_DESTINATION || path.join(os.homedir(), "Downloads", "FlashDrop");
const stateDir = process.env.FLASHDROP_DATA_DIR || path.join(os.homedir(), "Library", "Application Support", "FlashDrop Web");
const statePath = path.join(stateDir, "state.json");
const incomingDir = path.join(stateDir, "incoming");
const maxBody = 9 * 1024 * 1024;
const locks = new Map();
const appDir = path.dirname(fileURLToPath(import.meta.url));

await fs.mkdir(destination, { recursive: true });
await fs.mkdir(incomingDir, { recursive: true });

let state = await loadState();
const app = next({ dev, hostname, port, dir: appDir });
const handle = app.getRequestHandler();
await app.prepare();

function findLanIp() {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal && isPrivateIp(item.address)) return item.address;
    }
  }
  return "127.0.0.1";
}

function isPrivateIp(ip) {
  const value = ip.replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1" || value.startsWith("10.") || value.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

function isThisMac(req) {
  const remote = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  return remote === "127.0.0.1" || remote === "::1" || remote === lanIp;
}

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8"));
    return { session: parsed.session, uploads: parsed.uploads || {}, recent: parsed.recent || [] };
  } catch {
    const fresh = {
      session: { id: randomBytes(12).toString("base64url"), key: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString() },
      uploads: {},
      recent: [],
    };
    await persist(fresh);
    return fresh;
  }
}

async function persist(nextState = state) {
  await fs.mkdir(stateDir, { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(nextState, null, 2), { mode: 0o600 });
  await fs.rename(temp, statePath);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function fail(res, status, message) { json(res, status, { error: message }); }

async function readBody(req, limit = maxBody) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function decrypt(body, ivHex) {
  if (!/^[a-f0-9]{24}$/i.test(ivHex || "") || body.length < 16) throw Object.assign(new Error("Invalid encrypted request"), { status: 400 });
  const key = Buffer.from(state.session.key, "base64url");
  const tag = body.subarray(body.length - 16);
  const content = body.subarray(0, body.length - 16);
  const decipher = createDecipheriv("chacha20-poly1305", key, Buffer.from(ivHex, "hex"), { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(content), decipher.final()]);
}

function validSession(req) { return req.headers["x-session-id"] === state.session.id; }

function safeName(input) {
  const cleaned = path.basename(String(input || "file")).replace(/[\u0000-\u001f<>:\"/\\|?*]/g, "_").trim();
  return cleaned.slice(0, 220) || "file";
}

async function uniqueDestination(name) {
  const parsed = path.parse(name);
  for (let index = 0; index < 10000; index += 1) {
    const suffix = index ? ` (${index})` : "";
    const candidate = path.join(destination, `${parsed.name}${suffix}${parsed.ext}`);
    try { await fs.access(candidate); } catch { return candidate; }
  }
  return path.join(destination, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

async function locked(id, work) {
  const previous = locks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  locks.set(id, current);
  try { return await current; } finally { if (locks.get(id) === current) locks.delete(id); }
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/bootstrap") {
    if (!isThisMac(req)) return fail(res, 403, "Dashboard is only available on the receiving Mac.");
    const pairingUrl = `http://${lanIp}:${port}/send#s=${state.session.id}&k=${state.session.key}`;
    return json(res, 200, {
      pairingUrl,
      displayUrl: `http://${lanIp}:${port}`,
      destination,
      deviceName: os.hostname(),
      recent: state.recent.slice(0, 8),
    });
  }

  if (req.method === "GET" && url.pathname === "/api/recent") {
    if (!isThisMac(req)) return fail(res, 403, "Not available");
    return json(res, 200, { recent: state.recent.slice(0, 8) });
  }

  if (!validSession(req)) return fail(res, 401, "Pairing expired. Scan the QR again.");

  if (req.method === "POST" && url.pathname === "/api/uploads/init") {
    const raw = decrypt(await readBody(req, 128 * 1024), req.headers["x-iv"]);
    const meta = JSON.parse(raw.toString("utf8"));
    if (!Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > 2 ** 44) return fail(res, 400, "Invalid file size");
    if (!Number.isInteger(meta.chunkSize) || meta.chunkSize < 1024 || meta.chunkSize > 8 * 1024 * 1024) return fail(res, 400, "Invalid chunk size");
    if (!Number.isInteger(meta.totalChunks) || meta.totalChunks !== Math.ceil(meta.size / meta.chunkSize)) return fail(res, 400, "Invalid chunk count");
    const existing = Object.values(state.uploads).find((upload) => upload.fingerprint === meta.fingerprint && upload.size === meta.size && !upload.completedAt);
    if (existing) return json(res, 200, { uploadId: existing.id, received: existing.received });
    const id = randomUUID();
    const upload = {
      id,
      name: safeName(meta.name),
      size: meta.size,
      type: String(meta.type || "application/octet-stream").slice(0, 160),
      fingerprint: String(meta.fingerprint || "").slice(0, 500),
      chunkSize: meta.chunkSize,
      totalChunks: meta.totalChunks,
      received: [],
      partPath: path.join(incomingDir, `${id}.part`),
      createdAt: new Date().toISOString(),
    };
    const file = await fs.open(upload.partPath, "w", 0o600);
    await file.truncate(meta.size);
    await file.close();
    state.uploads[id] = upload;
    await persist();
    return json(res, 200, { uploadId: id, received: [] });
  }

  const chunkMatch = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]+)\/chunks\/(\d+)$/);
  if (req.method === "POST" && chunkMatch) {
    const [, id, indexText] = chunkMatch;
    const upload = state.uploads[id];
    const index = Number(indexText);
    if (!upload) return fail(res, 404, "Upload not found");
    if (!Number.isInteger(index) || index < 0 || index >= upload.totalChunks) return fail(res, 400, "Invalid chunk index");
    if (upload.received.includes(index)) return json(res, 200, { ok: true, duplicate: true });
    const offset = Number(req.headers["x-offset"]);
    if (offset !== index * upload.chunkSize) return fail(res, 400, "Invalid chunk offset");
    const encrypted = await readBody(req, upload.chunkSize + 16);
    const plain = decrypt(encrypted, req.headers["x-iv"]);
    const expected = Math.min(upload.chunkSize, upload.size - offset);
    if (plain.length !== expected) return fail(res, 400, "Invalid chunk length");
    await locked(id, async () => {
      if (upload.received.includes(index)) return;
      const file = await fs.open(upload.partPath, "r+");
      try { await file.write(plain, 0, plain.length, offset); } finally { await file.close(); }
      upload.received.push(index);
      upload.received.sort((a, b) => a - b);
      await persist();
    });
    return json(res, 200, { ok: true });
  }

  const completeMatch = url.pathname.match(/^\/api\/uploads\/([a-f0-9-]+)\/complete$/);
  if (req.method === "POST" && completeMatch) {
    const id = completeMatch[1];
    const upload = state.uploads[id];
    if (!upload) return fail(res, 404, "Upload not found");
    return locked(id, async () => {
      if (upload.received.length !== upload.totalChunks) return json(res, 200, { complete: false, received: upload.received });
      const target = await uniqueDestination(upload.name);
      await fs.rename(upload.partPath, target);
      const completed = { name: path.basename(target), size: upload.size, completedAt: new Date().toISOString() };
      state.recent = [completed, ...state.recent].slice(0, 30);
      delete state.uploads[id];
      await persist();
      return json(res, 200, { complete: true, name: completed.name });
    });
  }

  return fail(res, 404, "Not found");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${lanIp}:${port}`}`);
    if (!isPrivateIp((req.socket.remoteAddress || "").replace(/^::ffff:/, ""))) return fail(res, 403, "FlashDrop only accepts private-network connections.");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    return handle(req, res);
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error(error);
    if (!res.headersSent) return fail(res, status, status >= 500 ? "Receiver error" : error.message);
    res.destroy();
  }
});

server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 0;

server.listen(port, hostname, () => {
  console.log(`\n  FlashDrop receiver: http://${lanIp}:${port}`);
  console.log(`  Files save to:      ${destination}\n`);
});
