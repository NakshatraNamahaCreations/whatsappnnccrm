/**
 * Real WhatsApp connection through a linked device (same mechanism as WhatsApp Web), using Baileys v7.
 *
 * - The user scans the QR in WhatsApp > Linked devices. The session is saved in backend/wa-session.
 * - WhatsApp identifies most people by a hidden id ("@lid") instead of their phone number. Every id we see is
 *   recorded in the WaContact collection together with the phone number and names WhatsApp shares, so chats show
 *   real names and numbers and the two ids of the same person end up in one client.
 * - WhatsApp sends chat history only once, right after linking. Every history batch is saved raw in
 *   backend/data/wa-raw, so the import can be rebuilt later (POST /api/whatsapp/reimport) without scanning again.
 *
 * Unofficial: WhatsApp may ban numbers used for spam or bulk messaging. Use it for normal 1:1 client chats.
 */
import fs from "fs";
import path from "path";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateMessageID,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  proto,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import Client from "../../models/Client.js";
import Message from "../../models/Message.js";
import Meeting from "../../models/Meeting.js";
import Setting from "../../models/Setting.js";
import WaContact, { bestName } from "../../models/WaContact.js";
import { env } from "../../config/env.js";
import { getIO } from "../../sockets/index.js";
import { markDirty } from "../analytics.service.js";
import { detectFromMessage as detectPayments, queueOcr, queueUnreadPhotos, setMediaDownloader } from "../payments.service.js";
import { downloadMediaMessage } from "@whiskeysockets/baileys";

// Library diagnostics go to backend/logs/whatsapp.log (set WA_LOG_LEVEL=debug for more detail).
fs.mkdirSync(path.resolve("logs"), { recursive: true });
const logger = pino({ level: process.env.WA_LOG_LEVEL || "info" }, pino.destination({ dest: path.resolve("logs/whatsapp.log"), sync: false }));
const SESSION_DIR = path.resolve(env.sessionDir);
const RAW_DIR = path.resolve("data/wa-raw");
const COLORS = ["#1E6FD9", "#0F9D8A", "#0D1B3E", "#3B5BDB", "#0891B2", "#64748B", "#7C3AED", "#DB2777"];
const STATUS = { 0: "failed", 1: "sent", 2: "sent", 3: "delivered", 4: "read", 5: "read" };
const STUB = proto.WebMessageInfo.StubType;

const emit = (event, payload) => getIO()?.emit(event, payload);

// All database writes from WhatsApp events run one at a time, so parallel batches never create the same client twice.
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((e) => console.error("[WhatsApp] sync error:", e)));

// ---------- session state ----------
let sock = null;
let starting = false;
let manualStop = false;
let failures = 0; // consecutive connection failures
let awaitingInitialHistory = false; // WhatsApp sends chat history only right after a fresh link
let syncIdleTimer = null;
let me = { pn: "", lid: "" };

const state = {
  status: "idle", // idle | qr | connecting | syncing | connected
  qr: null,
  qrExpiresAt: null,
  qrCount: 0,
  number: "",
  name: "",
  sync: { contacts: 0, chats: 0, messages: 0, progress: 0 },
  error: "",
};
const publicState = () => ({ ...state });
const setState = (patch) => {
  Object.assign(state, patch);
  emit("wa:state", publicState());
};
export const getState = publicState;
export const hasSession = () => fs.existsSync(path.join(SESSION_DIR, "creds.json"));

// ---------- small helpers ----------
const digits = (jid) => (jid || "").split("@")[0].split(":")[0];
const norm = (jid) => (jid ? jidNormalizedUser(jid) : "");
const toISODate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const colorFor = (key) => COLORS[[...key].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
const num = (v) => (v && typeof v === "object" && typeof v.toNumber === "function" ? v.toNumber() : Number(v?.low ?? v ?? 0));
const tsOf = (m) => new Date(num(m.messageTimestamp) * 1000 || Date.now());

export const displayPhone = (n) => {
  if (!n) return "";
  if (n.startsWith("91") && n.length === 12) return `+91 ${n.slice(2, 7)} ${n.slice(7)}`;
  return `+${n}`;
};

/** Why a chat id is not a 1:1 client chat (or "" if it is). */
function skipReason(jid) {
  if (!jid) return "no-id";
  if (isJidGroup(jid)) return "group";
  if (jid === "status@broadcast") return "status";
  if (isJidBroadcast(jid)) return "broadcast";
  if (isJidNewsletter(jid)) return "channel";
  if (!isPnUser(jid) && !isLidUser(jid)) return "other-id";
  if (digits(jid) === "0") return "whatsapp-system";
  const n = norm(jid);
  if (n === me.pn || n === me.lid) return "self";
  return "";
}

// ---------- contacts: lid <-> phone number <-> names ----------
const contactCache = new Map(); // any id -> WaContact (plain object)

async function remember({ lid, pn, name, notify, verifiedName }) {
  lid = isLidUser(lid) ? norm(lid) : undefined;
  pn = isPnUser(pn) ? norm(pn) : undefined;
  if (!lid && !pn) return null;
  const or = [lid && { lid }, pn && { pn }].filter(Boolean);
  const existing = await WaContact.find({ $or: or });
  let doc = existing[0];
  if (existing.length > 1) {
    // the same person was stored twice (once per id): merge into one
    for (const extra of existing.slice(1)) {
      for (const k of ["lid", "pn", "name", "notify", "verifiedName"]) if (!doc[k] && extra[k]) doc[k] = extra[k];
      await extra.deleteOne();
    }
  }
  if (!doc) doc = new WaContact({});
  let changed = doc.isNew;
  const set = (k, v) => {
    if (v && doc[k] !== v) {
      doc[k] = v;
      changed = true;
    }
  };
  set("lid", lid);
  set("pn", pn);
  set("name", name);
  set("verifiedName", verifiedName);
  set("notify", notify);
  if (changed) await doc.save();
  const plain = doc.toObject();
  if (plain.lid) contactCache.set(plain.lid, plain);
  if (plain.pn) contactCache.set(plain.pn, plain);
  return { contact: plain, changed };
}

async function contactOf(id) {
  if (!id) return null;
  if (contactCache.has(id)) return contactCache.get(id);
  const c = await WaContact.findOne(isLidUser(id) ? { lid: id } : { pn: id }).lean();
  if (c) contactCache.set(id, c);
  return c;
}

/** Turns a chat id (+ optional alternate id from the message) into { pn, lid } using everything we know. */
async function resolveIds(jid, alt) {
  let pn = isPnUser(jid) ? norm(jid) : isPnUser(alt) ? norm(alt) : "";
  let lid = isLidUser(jid) ? norm(jid) : isLidUser(alt) ? norm(alt) : "";
  if (lid && !pn) {
    pn = (await contactOf(lid))?.pn || "";
    if (!pn && sock?.signalRepository?.lidMapping) {
      pn = norm((await sock.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)) || "");
    }
  }
  if (pn && !lid) lid = (await contactOf(pn))?.lid || "";
  if (pn && lid) await remember({ pn, lid });
  return { pn, lid };
}

// Name ranks: 3 = saved in your phone, 2 = verified business name, 1 = their WhatsApp profile name, 0 = number only
function nameFor(contact, pushName, pn) {
  if (contact?.name) return { name: contact.name, rank: 3 };
  if (contact?.verifiedName) return { name: contact.verifiedName, rank: 2 };
  if (contact?.notify || pushName) return { name: contact?.notify || pushName, rank: 1 };
  return { name: pn ? displayPhone(digits(pn)) : "WhatsApp contact", rank: 0 };
}

// ---------- clients ----------
const clientCache = new Map(); // pn or lid -> client _id

/** Moves everything from `from` into `into` (same person seen under two ids) and deletes `from`. */
async function mergeClients(into, from) {
  await Message.updateMany({ client: from._id }, { client: into._id });
  await Meeting.updateMany({ client: from._id }, { client: into._id });
  const patch = {
    unread: (into.unread || 0) + (from.unread || 0),
    lastMessageAt: [into.lastMessageAt, from.lastMessageAt].filter(Boolean).sort((a, b) => b - a)[0],
    since: [into.since, from.since].filter(Boolean).sort()[0],
  };
  if ((from.nameRank || 0) > (into.nameRank || 0)) Object.assign(patch, { name: from.name, nameRank: from.nameRank });
  await from.deleteOne();
  for (const [k, v] of clientCache) if (String(v) === String(from._id)) clientCache.set(k, into._id);
  markDirty(into._id);
  return Client.findByIdAndUpdate(into._id, patch, { new: true });
}

/** Finds or creates the CRM client for a person and keeps their id, number and name up to date. */
async function clientFor({ pn, lid }, { pushName, at, live } = {}) {
  const contact = (await contactOf(pn)) || (await contactOf(lid));
  const best = nameFor(contact, pushName, pn);

  const cachedId = clientCache.get(pn) || clientCache.get(lid);
  let client = cachedId ? await Client.findById(cachedId) : null;
  if (!client) {
    const or = [pn && { jid: pn }, pn && { waId: digits(pn), source: "whatsapp" }, lid && { lid }, lid && { jid: lid }].filter(Boolean);
    const found = await Client.find({ $or: or, source: "whatsapp" });
    client = found[0] || null;
    for (const extra of found.slice(1)) client = await mergeClients(client, extra);
  }

  if (!client) {
    const key = pn || lid;
    client = await Client.create({
      name: best.name,
      nameRank: best.rank,
      phone: pn ? displayPhone(digits(pn)) : "",
      waId: pn ? digits(pn) : undefined,
      jid: key,
      lid: lid || undefined,
      color: colorFor(key),
      source: "whatsapp",
      stage: "New lead",
      since: toISODate(at || new Date()),
      pending: [],
      timeline: [],
    });
    if (pn) clientCache.set(pn, client._id);
    if (lid) clientCache.set(lid, client._id);
    if (live) emit("client:new", { ...client.toObject(), messages: [], messageCount: 0 });
    return client;
  }

  const patch = {};
  if (pn && client.jid !== pn) Object.assign(patch, { jid: pn, phone: displayPhone(digits(pn)), waId: digits(pn) });
  if (lid && client.lid !== lid) patch.lid = lid;
  if (best.rank > (client.nameRank || 0)) Object.assign(patch, { name: best.name, nameRank: best.rank });
  if (Object.keys(patch).length) {
    client = await Client.findByIdAndUpdate(client._id, patch, { new: true });
    emit("client:updated", client);
  }
  if (pn) clientCache.set(pn, client._id);
  if (lid) clientCache.set(lid, client._id);
  return client;
}

/** Re-applies the best known names and numbers to every WhatsApp client (after new contact info arrives). */
async function refreshClientIdentities() {
  const clients = await Client.find({ source: "whatsapp" });
  let updated = 0;
  for (const c of clients) {
    const ids = [c.jid, c.lid].filter(Boolean);
    let pn = ids.find((j) => isPnUser(j)) || "";
    const lid = ids.find((j) => isLidUser(j)) || "";
    if (!pn && lid) pn = (await contactOf(lid))?.pn || "";
    const before = `${c.jid}|${c.name}|${c.lid}`;
    const after = await clientFor({ pn, lid }, {});
    if (`${after.jid}|${after.name}|${after.lid}` !== before) updated++;
  }
  if (updated) {
    console.log(`[WhatsApp] updated names/numbers for ${updated} chats`);
    refreshClients();
  }
}
let identityTimer = null;
const scheduleIdentityRefresh = () => {
  clearTimeout(identityTimer);
  identityTimer = setTimeout(() => serial(refreshClientIdentities), 3000);
};

// ---------- messages ----------
const sizeLabel = (bytes) => {
  const n = num(bytes);
  if (!n) return "";
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

function unwrap(message) {
  let m = message;
  for (let i = 0; i < 6 && m; i++) {
    const inner = m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension ||
      m.documentWithCaptionMessage || m.editedMessage || m.associatedChildMessage || m.lottieStickerMessage;
    if (!inner?.message) break;
    m = inner.message;
  }
  return m;
}

/** Converts a WhatsApp message into our Message fields, or null for things that are not conversation content. */
function toData(waMsg) {
  const stub = waMsg.messageStubType;
  if (stub === STUB.CALL_MISSED_VOICE) return { kind: "text", text: "📞 Missed voice call" };
  if (stub === STUB.CALL_MISSED_VIDEO) return { kind: "text", text: "📹 Missed video call" };

  const m = unwrap(waMsg.message);
  if (!m) return null;
  if (m.conversation) return { kind: "text", text: m.conversation };
  if (m.extendedTextMessage?.text) return { kind: "text", text: m.extendedTextMessage.text };
  if (m.documentMessage) {
    const d = m.documentMessage;
    return { kind: "doc", doc: { name: d.fileName || d.title || "Document", size: sizeLabel(d.fileLength) }, text: d.caption || "" };
  }
  if (m.imageMessage) return { kind: "text", text: m.imageMessage.caption ? `📷 ${m.imageMessage.caption}` : "📷 Photo" };
  if (m.videoMessage || m.ptvMessage) {
    const v = m.videoMessage || m.ptvMessage;
    return { kind: "text", text: v.caption ? `🎥 ${v.caption}` : "🎥 Video" };
  }
  if (m.audioMessage) return { kind: "text", text: m.audioMessage.ptt ? "🎤 Voice message" : "🎵 Audio" };
  if (m.stickerMessage) return { kind: "text", text: "Sticker" };
  if (m.locationMessage || m.liveLocationMessage) return { kind: "text", text: "📍 Location" };
  if (m.contactMessage) return { kind: "text", text: `👤 Contact: ${m.contactMessage.displayName || ""}`.trim() };
  if (m.contactsArrayMessage) return { kind: "text", text: "👤 Contact cards" };
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) return { kind: "text", text: `📊 Poll: ${poll.name || ""}`.trim() };
  if (m.eventMessage) return { kind: "text", text: `📅 Event: ${m.eventMessage.name || ""}`.trim() };
  if (m.buttonsResponseMessage) return { kind: "text", text: m.buttonsResponseMessage.selectedDisplayText || "Button reply" };
  if (m.listResponseMessage) return { kind: "text", text: m.listResponseMessage.title || "List reply" };
  if (m.templateButtonReplyMessage) return { kind: "text", text: m.templateButtonReplyMessage.selectedDisplayText || "Button reply" };
  if (m.templateMessage || m.interactiveMessage || m.buttonsMessage || m.listMessage) {
    const t = m.templateMessage?.hydratedTemplate?.hydratedContentText || m.interactiveMessage?.body?.text || m.buttonsMessage?.contentText || m.listMessage?.description;
    return { kind: "text", text: t || "[Interactive message]" };
  }
  if (m.orderMessage) return { kind: "text", text: "🛒 Order" };
  if (m.productMessage) return { kind: "text", text: "🛍 Product" };
  if (m.groupInviteMessage) return { kind: "text", text: "Group invite" };
  return null; // reactions, protocol/system messages, key distribution, etc.
}

/**
 * Saves one WhatsApp message. Returns the saved Message, or null.
 * `stats` (optional) counts why messages were skipped, which shows up in the server log.
 */
async function storeMessage(waMsg, { live, stats } = {}) {
  const count = (k) => stats && (stats[k] = (stats[k] || 0) + 1);
  const key = waMsg.key || {};
  const jid = key.remoteJid;
  const reason = skipReason(jid);
  if (reason) return count(`skip:${reason}`), null;

  const data = toData(waMsg);
  if (!data) {
    const t = Object.keys(waMsg.message || {}).filter((k) => k !== "messageContextInfo")[0] || (waMsg.messageStubType ? `stub-${waMsg.messageStubType}` : "empty");
    return count(`skip:no-content:${t}`), null;
  }
  if (env.historyDays > 0 && tsOf(waMsg).getTime() < Date.now() - env.historyDays * 864e5) return count("skip:too-old"), null;
  if (key.id && (await Message.exists({ waMessageId: key.id }))) return count("skip:duplicate"), null;

  const ids = await resolveIds(jid, key.remoteJidAlt);
  const fromMe = !!key.fromMe;
  if (!fromMe && waMsg.pushName) {
    const r = await remember({ lid: ids.lid, pn: ids.pn, notify: waMsg.pushName });
    if (r?.changed) scheduleIdentityRefresh();
  }

  const sentAt = tsOf(waMsg);
  const client = await clientFor(ids, { pushName: fromMe ? undefined : waMsg.pushName, at: sentAt, live });

  // photos keep what's needed to download them later, so payment screenshots can be read
  const isPhoto = !!unwrap(waMsg.message)?.imageMessage;
  let message;
  try {
    message = await Message.create({
      client: client._id,
      from: fromMe ? "me" : "client",
      ...data,
      status: fromMe ? STATUS[waMsg.status] || "sent" : "received",
      waMessageId: key.id,
      sentAt,
      ...(isPhoto ? { mediaRaw: JSON.stringify({ key, message: waMsg.message, messageTimestamp: waMsg.messageTimestamp }, BufferJSON.replacer) } : {}),
    });
  } catch (e) {
    if (e.code === 11000) return count("skip:duplicate"), null; // already saved (e.g. sent from the CRM)
    throw e;
  }
  count("saved");

  // payments: amounts in the text / caption now, payment screenshots read in the background
  await detectPayments(message).catch((e) => console.error("[payments] detect error:", e.message));
  if (isPhoto) queueOcr(message._id);

  const update = { $max: { lastMessageAt: sentAt } };
  if (live && !fromMe) update.$inc = { unread: 1 };
  if (!client.since || toISODate(sentAt) < client.since) update.$set = { since: toISODate(sentAt) };
  await Client.updateOne({ _id: client._id }, update);
  markDirty(client._id);
  if (live) emit("message:new", message);

  // A "yes" / "ok" / "confirm" reply confirms this client's pending meeting invite.
  if (live && !fromMe && data.kind === "text" && /^\s*(yes|ok|okay|confirm(ed)?)\b/i.test(data.text)) {
    const { confirmPendingMeeting } = await import("../messaging.service.js");
    await confirmPendingMeeting(client._id);
  }
  return message;
}

// ---------- raw copies (so imports can be rebuilt without scanning again) ----------
let rawSeq = 0;
function saveRaw(kind, payload) {
  try {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    const file = path.join(RAW_DIR, `${Date.now()}-${String(++rawSeq).padStart(4, "0")}-${kind}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, BufferJSON.replacer));
  } catch (e) {
    console.error("[WhatsApp] could not save raw data:", e.message);
  }
}

// ---------- history import ----------
let refreshTimer = null;
const refreshClients = () => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => emit("clients:refresh"), 800);
};

const finishSync = async () => {
  clearTimeout(syncIdleTimer);
  if (state.status !== "syncing") return;
  await serial(refreshClientIdentities);
  await Setting.updateOne({ key: "workspace" }, { "whatsapp.lastSyncAt": new Date() });
  setState({ status: "connected" });
  emit("clients:refresh");
  emit("wa:history-complete");
};
const touchSync = (ms = 25000) => {
  clearTimeout(syncIdleTimer);
  syncIdleTimer = setTimeout(finishSync, ms);
};

async function importHistory(h, { save = true } = {}) {
  const { chats = [], contacts = [], messages = [], lidPnMappings = [], isLatest, progress } = h;
  if (save) saveRaw("history", { chats, contacts, messages, lidPnMappings, isLatest, progress, syncType: h.syncType });

  for (const m of lidPnMappings) await remember({ lid: m.lid, pn: m.pn });
  for (const c of contacts) {
    await remember({
      lid: c.lid || (isLidUser(c.id) ? c.id : undefined),
      pn: c.phoneNumber || (isPnUser(c.id) ? c.id : undefined),
      name: c.name,
      notify: c.notify,
      verifiedName: c.verifiedName,
    });
  }
  for (const ch of chats) {
    if (ch.lidJid || ch.pnJid) await remember({ lid: ch.lidJid, pn: ch.pnJid });
  }

  // oldest first, so each chat's start date and order are right
  const sorted = [...messages].sort((a, b) => tsOf(a) - tsOf(b));
  const stats = {};
  for (const m of sorted) {
    try {
      await storeMessage(m, { live: false, stats });
    } catch (e) {
      stats["error"] = (stats["error"] || 0) + 1;
      if (stats["error"] <= 3) console.error("[WhatsApp] message import error:", e.message);
    }
  }

  // unread counts from the phone
  for (const ch of chats) {
    if (!ch.unreadCount || skipReason(ch.id)) continue;
    const ids = await resolveIds(ch.id, ch.pnJid || ch.lidJid);
    const id = clientCache.get(ids.pn) || clientCache.get(ids.lid);
    if (id) await Client.updateOne({ _id: id }, { unread: ch.unreadCount });
  }

  const summary = Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`[WhatsApp] history batch: ${chats.length} chats, ${contacts.length} contacts, ${lidPnMappings.length} id-mappings, ${messages.length} messages -> ${summary || "nothing"} (progress ${progress ?? "?"}%)`);

  setState({
    sync: {
      contacts: await WaContact.countDocuments(),
      chats: await Client.countDocuments({ source: "whatsapp" }),
      messages: state.sync.messages + (stats.saved || 0),
      progress: progress ?? state.sync.progress,
    },
  });
  refreshClients();
  if (state.status === "syncing") (isLatest || progress === 100 ? touchSync(8000) : touchSync());
  return stats;
}

/**
 * Rebuilds all WhatsApp chats from the raw copies in data/wa-raw (no new scan needed).
 * Manual and demo clients are left alone.
 */
export async function reimportFromRaw() {
  const files = fs.existsSync(RAW_DIR) ? fs.readdirSync(RAW_DIR).filter((f) => f.endsWith(".json")).sort() : [];
  if (!files.length) throw new Error("No saved WhatsApp data yet. Scan the QR once; the history is saved automatically after that.");
  return serial(async () => {
    const ids = (await Client.find({ source: "whatsapp" }, "_id")).map((c) => c._id);
    await Promise.all([Message.deleteMany({ client: { $in: ids } }), Client.deleteMany({ _id: { $in: ids } })]);
    clientCache.clear();
    contactCache.clear();
    const totals = {};
    for (const f of files) {
      const payload = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), "utf8"), BufferJSON.reviver);
      let stats = {};
      if (f.endsWith("-history.json")) stats = await importHistory(payload, { save: false });
      else if (f.endsWith("-contacts.json")) for (const c of payload) await learnContact(c);
      else if (f.endsWith("-lidmap.json")) await remember(payload);
      else if (f.endsWith("-live.json")) for (const m of payload.messages || []) await storeMessage(m, { live: false, stats });
      for (const [k, v] of Object.entries(stats)) totals[k] = (totals[k] || 0) + v;
    }
    await refreshClientIdentities();
    emit("clients:refresh");
    return { files: files.length, clients: await Client.countDocuments({ source: "whatsapp" }), ...totals };
  });
}

async function learnContact(c) {
  const r = await remember({
    lid: c.lid || (isLidUser(c.id) ? c.id : undefined),
    pn: c.phoneNumber || (isPnUser(c.id) ? c.id : undefined),
    name: c.name,
    notify: c.notify,
    verifiedName: c.verifiedName,
  });
  return r?.changed;
}

// ---------- connection ----------
export async function start() {
  if (sock || starting) return publicState();
  starting = true;
  manualStop = false;
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    const { state: auth, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    if (!auth.creds.me) awaitingInitialHistory = true; // no account yet: this session will show a QR
    setState({ status: "connecting", error: "" });

    sock = makeWASocket({
      version,
      auth,
      logger,
      browser: Browsers.macOS("Desktop"), // desktop identity makes WhatsApp share recent chat history on link
      // syncFullHistory: true makes WhatsApp refuse the link from this machine, so we take the recent history
      // WhatsApp shares by default. shouldSyncHistoryMessage must still say yes, or the history is discarded.
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => true,
      markOnlineOnConnect: false,
      getMessage: async () => undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    // Errors in here are logged instead of crashing the server.
    sock.ev.on("connection.update", (u) => onConnection(u).catch((e) => console.error("[WhatsApp] connection handler error:", e.message)));
    const onConnection = async (u) => {
      if (u.qr) {
        const ttl = state.qrCount === 0 ? 60 : 20;
        setState({
          status: "qr",
          qr: await QRCode.toDataURL(u.qr, { errorCorrectionLevel: "H", margin: 1, width: 480, color: { dark: "#0D1B3E", light: "#FFFFFF" } }),
          qrExpiresAt: Date.now() + ttl * 1000,
          qrCount: state.qrCount + 1,
        });
      }

      if (u.connection === "open") {
        failures = 0;
        me = { pn: norm(sock.user?.id), lid: norm(sock.user?.lid) };
        // photos can be downloaded while connected (WhatsApp asks the phone to re-send older ones)
        const s = sock;
        setMediaDownloader(async (raw) => {
          const m = JSON.parse(raw, BufferJSON.reviver);
          const ctx = { logger, reuploadRequest: (x) => s.updateMediaMessage(x) };
          try {
            return await downloadMediaMessage(m, "buffer", {}, ctx);
          } catch {
            // older photos are gone from WhatsApp's servers: ask the phone to upload it again, then retry
            const fresh = await s.updateMediaMessage(m);
            return downloadMediaMessage(fresh, "buffer", {}, ctx);
          }
        });
        backfillPhotoDetails()
          .then(() => queueUnreadPhotos())
          .then((n) => n && console.log(`[payments] reading ${n} photos for payment screenshots`))
          .catch((e) => console.error("[payments] photo backfill error:", e.message));
        const number = displayPhone(digits(sock.user?.id));
        const name = sock.user?.name || sock.user?.verifiedName || "";
        await Setting.updateOne(
          { key: "workspace" },
          { $set: { "whatsapp.connected": true, "whatsapp.number": number, "whatsapp.businessName": name || "WhatsApp", "whatsapp.connectedAt": new Date() } },
          { upsert: true }
        );
        const syncing = awaitingInitialHistory || !!u.isNewLogin;
        awaitingInitialHistory = false;
        console.log(`[WhatsApp] connected as ${number} (${name || "no name"})${syncing ? ", waiting for chat history" : ""}`);
        setState({ status: syncing ? "syncing" : "connected", qr: null, qrCount: 0, number, name });
        if (syncing) {
          setState({ sync: { contacts: 0, chats: 0, messages: 0, progress: 0 } });
          touchSync(45000); // finish even if WhatsApp sends no history
        }
        emit("clients:refresh");
      }

      if (u.connection === "close") {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null;
        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession) {
          await clearSession();
          setState({ status: "idle", qr: null, qrCount: 0, error: code === DisconnectReason.loggedOut ? "Logged out from the phone" : "Session expired" });
        } else if (manualStop) {
          setState({ status: "idle", qr: null, qrCount: 0 });
        } else if (state.status === "qr" && code === DisconnectReason.timedOut) {
          setState({ status: "idle", qr: null, qrCount: 0, error: "QR code expired" });
        } else if (++failures > 5) {
          failures = 0;
          setState({ status: "idle", qr: null, qrCount: 0, error: `Could not reach WhatsApp (${u.lastDisconnect?.error?.message || "connection closed"})` });
        } else {
          const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30000, 2000 * failures);
          setTimeout(() => start().catch((e) => console.error("[WhatsApp] reconnect failed:", e.message)), delay);
        }
      }
    };

    sock.ev.on("messaging-history.set", (h) => serial(() => importHistory(h)));
    sock.ev.on("messaging-history.status", (s) => {
      console.log(`[WhatsApp] history ${s.status} (type ${s.syncType})`);
      if (s.status === "complete" && state.status === "syncing") touchSync(5000);
    });

    sock.ev.on("messages.upsert", ({ messages, type }) =>
      serial(async () => {
        if (type === "notify") saveRaw("live", { messages });
        const stats = {};
        for (const m of messages) {
          try {
            await storeMessage(m, { live: type === "notify", stats });
          } catch (e) {
            console.error("[WhatsApp] store message error:", e.message);
          }
        }
        const summary = Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(", ");
        console.log(`[WhatsApp] ${type} messages: ${messages.length} -> ${summary}`);
        if (type !== "notify") refreshClients();
      })
    );

    sock.ev.on("messages.update", (updates) =>
      serial(async () => {
        for (const { key, update } of updates) {
          const st = STATUS[update?.status];
          if (!st || !key.fromMe) continue;
          const msg = await Message.findOneAndUpdate({ waMessageId: key.id }, { status: st }, { new: true });
          if (msg) emit("message:status", { id: msg._id, client: msg.client, status: st });
        }
      })
    );

    const onContacts = (list) =>
      serial(async () => {
        saveRaw("contacts", list);
        let changed = 0;
        for (const c of list) if (await learnContact(c)) changed++;
        if (changed) scheduleIdentityRefresh();
      });
    sock.ev.on("contacts.upsert", onContacts);
    sock.ev.on("contacts.update", onContacts);
    sock.ev.on("lid-mapping.update", (m) =>
      serial(async () => {
        saveRaw("lidmap", m);
        const r = await remember({ lid: m.lid, pn: m.pn });
        if (r?.changed) scheduleIdentityRefresh();
      })
    );
  } catch (e) {
    sock = null;
    setState({ status: "idle", error: e.message });
    throw e;
  } finally {
    starting = false;
  }
  return publicState();
}

async function clearSession() {
  clientCache.clear();
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  await Setting.updateOne({ key: "workspace" }, { "whatsapp.connected": false });
}

/** Unlinks this device from the phone and deletes the saved session. */
export async function logout() {
  manualStop = true;
  clearTimeout(syncIdleTimer);
  if (sock) {
    try {
      await sock.logout();
    } catch {
      sock?.end?.(undefined);
    }
  }
  sock = null;
  await clearSession();
  setState({ status: "idle", qr: null, qrCount: 0, number: "", name: "", sync: { contacts: 0, chats: 0, messages: 0, progress: 0 }, error: "" });
}

/**
 * Asks WhatsApp to send the account's app-state again. That is where the names saved in the phone's
 * address book come from (they arrive as contact updates and replace profile names).
 */
export async function resyncContacts() {
  if (!sock || !["connected", "syncing"].includes(state.status)) throw new Error("WhatsApp is not connected");
  const before = await WaContact.countDocuments({ name: { $exists: true, $ne: "" } });
  await sock.resyncAppState(["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"], true);
  await new Promise((r) => setTimeout(r, 4000)); // contact updates are processed in the background
  await serial(refreshClientIdentities);
  const after = await WaContact.countDocuments({ name: { $exists: true, $ne: "" } });
  return { savedNamesBefore: before, savedNamesAfter: after };
}

/**
 * Photos imported before download details were stored: finds them in the saved raw history and attaches the details,
 * so their screenshots can be read for payments. Runs once per photo.
 */
async function backfillPhotoDetails() {
  const missing = await Message.find({ text: /^📷/, waMessageId: { $exists: true }, mediaRaw: { $exists: false } }, "waMessageId").lean();
  if (!missing.length || !fs.existsSync(RAW_DIR)) return 0;
  const want = new Set(missing.map((m) => m.waMessageId));
  let n = 0;
  for (const f of fs.readdirSync(RAW_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const payload = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), "utf8"), BufferJSON.reviver);
    for (const m of payload.messages || []) {
      if (!want.has(m.key?.id) || !unwrap(m.message)?.imageMessage) continue;
      await Message.updateOne({ waMessageId: m.key.id }, { mediaRaw: JSON.stringify({ key: m.key, message: m.message, messageTimestamp: m.messageTimestamp }, BufferJSON.replacer) });
      want.delete(m.key.id);
      n++;
    }
  }
  if (n) console.log(`[payments] found download details for ${n} older photos`);
  return n;
}

/** Removes the saved raw WhatsApp data (used when the user asks to delete imported chats). */
export function deleteRaw() {
  fs.rmSync(RAW_DIR, { recursive: true, force: true });
}

/** Sends a text and returns the WhatsApp message id. The id is created first so WhatsApp's echo is not stored twice. */
export async function sendText(client, text, messageId = generateMessageID()) {
  if (!sock || !["connected", "syncing"].includes(state.status)) throw new Error("WhatsApp is not connected");
  const jid = client.jid || `${client.waId}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text }, { messageId });
  return messageId;
}

export const newMessageId = () => generateMessageID();

// Internal functions exposed for automated tests only.
export const __test = { importHistory, storeMessage, remember, resolveIds, clientCache, contactCache, setMe: (v) => (me = v) };
