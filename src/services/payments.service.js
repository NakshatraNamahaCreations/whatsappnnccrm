/**
 * Payments found in WhatsApp chats, recorded with the client, date and time.
 *
 * From message text: "Paid 10k pls check", "sent ₹5,000 via GPay", "Rs 23,600 transferred", "1.5 lakh done",
 *   "received with thanks", Hindi/Kannada phrases ("bhej diya", "kalisiddini"...).
 * From screenshots: the photo is downloaded from WhatsApp and its text is read with Tesseract OCR (open source,
 *   runs inside this backend). UPI / GPay / PhonePe / Paytm / bank receipts are recognised and their amount and
 *   reference number recorded.
 *
 * Direction: "in" = money received from the client, "out" = money we paid (vendors, refunds...).
 * Amounts that are not clearly a payment (quotes, prices, a bare "10000") are kept as kind "mention" so they can be
 * reviewed in Payments > To review; they never count in totals until marked as a payment.
 * OTPs, phone numbers, passwords, dates and long reference numbers are not treated as amounts.
 */
import fs from "fs";
import path from "path";
import Client from "../models/Client.js";
import Message from "../models/Message.js";
import { getIO } from "../sockets/index.js";

const emit = (e, p) => getIO()?.emit(e, p);
const HOUR = 3600e3;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm12 = (d) => {
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${ap}`;
};

// ---------- reading amounts ----------
const UNIT = { k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7 };
const num = (s) => Number(String(s).replace(/,/g, ""));
const MIN = 50;
const MAX = 5e7; // 5 crore: anything bigger is a phone number, an id or a typo

/** Removes things that contain digits but are not amounts. */
function clean(text) {
  return (text || "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\S+@\S+/g, " ") // emails
    .replace(/\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, " ") // dates
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi, " ") // times
    .replace(/(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, " ") // Indian mobile numbers
    .replace(/\b\d{9,}\b/g, " ") // long ids / account / reference numbers
    .replace(/\b(?=\w*\d)(?=\w*[a-z])\w{6,}\b/gi, (w) => (/^(?:rs|inr)?\d+(?:\.\d+)?(?:k|l|cr|lakhs?|lacs?|crore|thousand|rs|inr|rupees?)?$/i.test(w) ? w : " ")); // passwords like abc123x
}

/** All amounts in a text: [{ amount, marked }] where marked = had ₹/Rs/k/lakh/,-format. */
export function amountsIn(text) {
  const t = clean(text);
  const found = [];
  const taken = []; // character ranges already used, so "Rs 23,600" is one amount, not 23600 + 23600 + 600
  const add = (m, value, marked) => {
    const start = m.index;
    const end = m.index + m[0].length;
    if (taken.some(([s, e]) => start < e && end > s)) return;
    taken.push([start, end]);
    if (value >= MIN && value <= MAX) found.push({ amount: Math.round(value), marked, index: start });
  };
  // ₹ 10,000 / Rs. 10000 / INR 5k / rupees 2 lakh
  for (const m of t.matchAll(/(?:₹|\brs\.?|\binr|\brupees?)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(k|thousand|lakhs?|lacs?|l|cr|crore)?\b/gi)) {
    add(m, num(m[1]) * (UNIT[(m[2] || "").toLowerCase()] || 1), true);
  }
  // 10k / 1.5 lakh / 2 cr
  for (const m of t.matchAll(/\b([0-9]+(?:\.[0-9]+)?)\s*(k|thousand|lakhs?|lacs?|cr|crore)\b/gi)) add(m, num(m[1]) * UNIT[m[2].toLowerCase()], true);
  // 10,000/- / 5000 rs / 2500 rupees
  for (const m of t.matchAll(/\b([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:\/-|rs\.?\b|rupees?\b|inr\b)/gi)) add(m, num(m[1]), true);
  // 1,00,000 / 23,600.00 (Indian or western grouping)
  for (const m of t.matchAll(/\b[0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?\b/g)) add(m, num(m[0]), true);
  // bare numbers: 10000 / 2500.50
  for (const m of t.matchAll(/\b[0-9]{3,8}(?:\.[0-9]{1,2})?\b/g)) add(m, num(m[0]), false);
  return found.sort((a, b) => a.index - b.index);
}

const PAID = /\b(paid|payed|sent|transferred|transfer(?:red)? done|deposited|credited|debited|received|recieved|recived|cleared|settled|got (?:the )?(?:payment|amount|money)|payment (?:done|made|completed|successful|sent|received)|done (?:the )?payment|advance (?:paid|sent|done)|utr|txn|transaction id|upi ref)\b|bhej (?:diya|diye|di)|kar (?:diya|diye|di)|de (?:diya|diye|di)|daal diya|jama kar|bhugtan|भेज दिया|भेज दिए|कर दिया|भुगतान|जमा|kalisiddini|kaliside|kalsidini|haakiddini|hakidini|pay madiddini|pay madide|ಕಳುಹಿಸಿದ್ದೇನೆ|ಕಳಿಸಿದ್ದೀನಿ|ಕಳಿಸಿದೆ|ಪಾವತಿಸಿದ್ದೇನೆ|ಹಾಕಿದ್ದೇನೆ/i;
const NOT_YET = /\b(will (?:pay|send|transfer)|shall (?:pay|send)|going to pay|(?:pls|please|kindly|can you|could you) (?:pay|send|transfer)|pay (?:karo|kardo|madi)|bhej (?:do|dena|denge)|kar (?:do|dena|denge)|pending|due|balance|remaining|invoice|quote|quotation|price|cost|charges?|per month|monthly|estimate|budget|would be|will be|starting|starts at|package|plan|\+\s*gst|offer|discount)\b/i;
const MODES = [
  ["GPay", /\bg ?pay\b|google pay/i],
  ["PhonePe", /phone ?pe/i],
  ["Paytm", /paytm/i],
  ["BHIM", /\bbhim\b/i],
  ["NEFT", /\bneft\b/i],
  ["IMPS", /\bimps\b/i],
  ["RTGS", /\brtgs\b/i],
  ["Cash", /\bcash\b|नकद|ನಗದು/i],
  ["Cheque", /\bcheque|\bcheck no|\bchq\b/i],
  ["Card", /\bcard\b/i],
  ["Bank transfer", /bank transfer|net ?banking|account transfer/i],
  ["UPI", /\bupi\b/i],
];
const modeOf = (t) => MODES.find(([, re]) => re.test(t))?.[0] || "";
const refOf = (t) =>
  (t.match(/(?:utr|upi (?:ref(?:erence)?|transaction)|ref(?:erence)?|txn|transaction)(?:\s*(?:no|number|id)\b\.?)?[\s:#.-]*([A-Z0-9]{8,24})/i) || [])[1] || "";

/** What a text message says about money. Returns null if no amount and no payment wording. */
export function classifyText(text, fromMe) {
  const t = (text || "").trim();
  if (!t) return null;
  const amounts = amountsIn(t);
  const paidWords = PAID.test(t);
  const future = NOT_YET.test(t);
  const isPayment = paidWords && !future;
  const received = /\b(received|recieved|recived|got (?:the )?(?:payment|amount|money)|credited)\b|mil gaya|mil gaye|ಬಂದಿದೆ|ಸಿಕ್ಕಿದೆ|मिल गया/i.test(t);
  // who paid whom: "received" from us = client paid us; "received" from the client = we paid them
  const direction = received ? (fromMe ? "in" : "out") : fromMe ? "out" : "in";

  // which amounts count: with payment wording any plausible amount; otherwise only "money-looking" ones
  const short = t.replace(/[^\d]/g, "").length === t.replace(/\s/g, "").length; // message is just a number
  const usable = amounts.filter((a) => {
    if (a.marked) return true;
    if (a.amount >= 1990 && a.amount <= 2040) return false; // a year ("report ready ... 2026"), not money
    if (isPayment) return true;
    if (future) return true; // "Balance 23600", "invoice 15000": the wording says it's money
    // a bare number on its own ("10000") is a mention only if it looks like money (round), not an OTP like 424223
    return short && a.amount % 100 === 0;
  });
  if (!usable.length && !isPayment) return null;
  return {
    kind: isPayment ? "payment" : "mention",
    direction,
    amounts: usable.map((a) => a.amount),
    mode: modeOf(t),
    ref: refOf(t),
    received,
  };
}

// ---------- recording ----------
const sameish = (p, amount, direction, at, windowH) =>
  p.amount === amount && (p.direction || "in") === direction && p.at && Math.abs(new Date(p.at) - at) < windowH * HOUR;

/**
 * Adds a payment / mention to the client, merging with what's already there:
 * - the same amount, direction and kind within 36 h is the same payment (e.g. screenshot + "paid 10k")
 * - a payment arriving after a matching mention turns the mention into the payment
 */
async function record(clientId, entry) {
  const client = await Client.findById(clientId);
  if (!client) return null;
  const list = client.payments;
  // this message was already used (recorded, or merged into another payment): nothing to do
  const used = (p) => [p.message, ...(p.messages || [])].some((id) => id && String(id) === String(entry.message));
  if (entry.message && list.some((p) => used(p) && p.amount === entry.amount)) return null;
  const remember = (p) => {
    if (entry.message && !used(p)) p.messages = [...(p.messages || []), entry.message];
  };

  const at = entry.at;
  const samePayment = list.find((p) => p.kind === "payment" && p.status !== "ignored" && sameish(p, entry.amount, entry.direction, at, 36));
  if (entry.kind === "payment" && samePayment) {
    if (!samePayment.ref && entry.ref) samePayment.ref = entry.ref;
    if ((!samePayment.mode || samePayment.mode === "UPI") && entry.mode) samePayment.mode = entry.mode;
    if (entry.detectedBy === "screenshot" && samePayment.detectedBy !== "screenshot") Object.assign(samePayment, { detectedBy: "screenshot", source: entry.source, message: entry.message });
    remember(samePayment);
    await client.save();
    return { client, payment: samePayment, merged: true };
  }
  if (entry.kind === "mention" && list.some((p) => sameish(p, entry.amount, p.direction || "in", at, 36))) return null; // already known

  if (entry.kind === "payment") {
    // "10000" ... "Paid 10k pls check": the earlier mention becomes this payment
    const mention = list.find((p) => p.kind === "mention" && p.status !== "ignored" && p.amount === entry.amount && p.at && at - new Date(p.at) >= 0 && at - new Date(p.at) < 36 * HOUR);
    if (mention) {
      remember(mention);
      Object.assign(mention, { kind: "payment", direction: entry.direction, mode: entry.mode || mention.mode, ref: entry.ref || mention.ref, note: entry.note, source: entry.source, message: entry.message, detectedBy: entry.detectedBy, at, date: ymd(at), time: hm12(at) });
      await client.save();
      return { client, payment: mention, merged: true };
    }
  }

  list.push({
    date: ymd(at),
    time: hm12(at),
    at,
    amount: entry.amount,
    direction: entry.direction,
    kind: entry.kind,
    status: "detected",
    mode: entry.mode || (entry.detectedBy === "screenshot" ? "UPI" : ""),
    ref: entry.ref,
    source: entry.source,
    detectedBy: entry.detectedBy,
    note: (entry.note || "").slice(0, 400),
    message: entry.message,
    messages: entry.message ? [entry.message] : [],
    verified: false,
  });
  await client.save();
  return { client, payment: list[list.length - 1], merged: false };
}

const announce = (res) => {
  if (!res) return;
  emit("client:updated", { _id: res.client._id, payments: res.client.payments });
  const p = res.payment;
  console.log(`[payments] ${p.kind === "payment" ? (p.direction === "in" ? "received" : "paid out") : "amount to review"} Rs. ${p.amount} - ${res.client.name} ${p.date} ${p.time} (${p.detectedBy}${res.merged ? ", merged" : ""})`);
};

/** Looks at one text message and records any payment or amount in it. */
export async function detectFromMessage(message) {
  // long broadcasts / reports / minutes are not payment messages
  if (!message || message.kind !== "text" || !message.text || message.invite || message.text.length > 1500) return [];
  const fromMe = message.from === "me";
  const text = message.text.replace(/^📷\s*/, ""); // photo captions count too
  const c = classifyText(text, fromMe);
  if (!c) return [];
  const at = new Date(message.sentAt);
  const out = [];

  if (!c.amounts.length && c.kind === "payment") {
    // "Paid, please check" / "Received with thanks": no amount, so use the amount mentioned shortly before
    const client = await Client.findById(message.client).lean();
    const recent = (client?.payments || [])
      .filter((p) => p.status !== "ignored" && p.at && at - new Date(p.at) >= 0 && at - new Date(p.at) < 36 * HOUR)
      .sort((a, b) => new Date(b.at) - new Date(a.at))[0];
    if (recent?.kind === "mention" && ![recent.message, ...(recent.messages || [])].some((id) => id && String(id) === String(message._id))) {
      out.push(await record(message.client, { amount: recent.amount, direction: c.direction, kind: "payment", mode: c.mode, ref: c.ref, at, source: fromMe ? "Our message" : "Client message", detectedBy: "text", note: text, message: message._id }));
    }
  } else {
    for (const amount of c.amounts.slice(0, 3)) {
      out.push(await record(message.client, { amount, direction: c.direction, kind: c.kind, mode: c.mode, ref: c.ref, at, source: fromMe ? "Our message" : "Client message", detectedBy: "text", note: text, message: message._id }));
    }
  }
  out.forEach(announce);
  return out.filter(Boolean);
}

// ---------- screenshots (OCR) ----------
const RECEIPT = /(paid|payment successful|transaction successful|successful|completed|debited|credited|sent to|paid to|received from|transferred|upi transaction|upi ref|utr|transaction id|google pay|g pay|phonepe|paytm|bhim|bank|amount|₹|\brs\b)/gi;

/** Reads a payment receipt's text. Returns { amount, ref, mode, direction } or null if it isn't a receipt. */
export function parseReceipt(ocrText, fromMe) {
  const t = (ocrText || "").replace(/[|]/g, " ");
  const hits = new Set((t.match(RECEIPT) || []).map((x) => x.toLowerCase()));
  if (hits.size < 2) return null;
  // OCR often reads ₹ as "%", "X", "F" or "Z": treat those right before a number as ₹
  const fixed = t.replace(/(^|\s)[%XFZ¥€]\s?(?=[0-9][0-9,]*(?:\.[0-9]{2})?\b)/g, "$1₹");
  const before = (a) => fixed.slice(Math.max(0, a.index - 30), a.index).toLowerCase();
  // drop balances, limits, fees and cashback ("Avl Bal Rs 1,23,456" is not the payment)
  const amounts = amountsIn(fixed)
    .filter((a) => a.marked)
    .filter((a) => !/(bal(?:ance)?|avl|available|limit|fee|charges?|cashback|reward)[\s.:a-z]*$/.test(before(a)));
  if (!amounts.length) return null;
  // prefer the amount right after "credited with / debited / paid / amount"; otherwise the biggest (receipts show it largest)
  const near = amounts.find((a) => /(credited|debited|paid|sent|received|transferred|amount|payment of)[\s\w.:]*$/.test(before(a)));
  const amount = (near || [...amounts].sort((a, b) => b.amount - a.amount)[0]).amount;
  const incoming = /credited|received from|money received/i.test(t);
  const outgoing = /debited|paid to|sent to|payment to/i.test(t);
  // a client's screenshot of paying = we received; our screenshot of paying = we paid
  const direction = incoming && !outgoing ? (fromMe ? "in" : "out") : fromMe ? "out" : "in";
  const ref = refOf(t) || (t.match(/\b\d{12}\b/) || [])[0] || ""; // UPI refs are 12 digits
  return { amount, ref, mode: modeOf(t) || "UPI", direction };
}

let worker = null;
async function ocrWorker() {
  if (worker) return worker;
  const { createWorker } = await import("tesseract.js");
  const langPath = path.resolve("node_modules/@tesseract.js-data/eng/4.0.0_best_int");
  fs.mkdirSync(path.resolve("data/ocr-cache"), { recursive: true });
  worker = await createWorker("eng", 1, { langPath, cachePath: path.resolve("data/ocr-cache"), gzip: true });
  return worker;
}
export async function ocrImage(fileOrBuffer) {
  const w = await ocrWorker();
  const { data } = await w.recognize(fileOrBuffer);
  return data.text || "";
}

const MEDIA_DIR = path.resolve("data/media");
let mediaDownloader = null; // set by the WhatsApp service: (rawJson) => Buffer
export const setMediaDownloader = (fn) => (mediaDownloader = fn);

const ocrQueue = [];
const queued = new Set();
let ocrBusy = false;
export function queueOcr(messageId) {
  const id = String(messageId);
  if (queued.has(id)) return;
  queued.add(id);
  ocrQueue.push(id);
  pumpOcr();
}

async function pumpOcr() {
  if (ocrBusy) return;
  ocrBusy = true;
  try {
    while (ocrQueue.length) {
      const id = ocrQueue.shift();
      try {
        await processPhoto(id);
      } catch (e) {
        await Message.updateOne({ _id: id }, { ocr: { done: true, error: e.message, at: new Date() } });
      } finally {
        queued.delete(id);
      }
    }
  } finally {
    ocrBusy = false;
  }
}

async function processPhoto(id) {
  const msg = await Message.findById(id).select("+mediaRaw");
  if (!msg || msg.ocr?.done) return;
  let file = msg.media?.path && fs.existsSync(msg.media.path) ? msg.media.path : null;
  if (!file) {
    if (!msg.mediaRaw) throw new Error("No download details for this photo");
    if (!mediaDownloader) throw new Error("WhatsApp is not connected");
    const buf = await mediaDownloader(msg.mediaRaw);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    file = path.join(MEDIA_DIR, `${msg.waMessageId || msg._id}.jpg`);
    fs.writeFileSync(file, buf);
    msg.media = { path: file, mime: "image/jpeg" };
  }
  const text = await ocrImage(file);
  msg.ocr = { done: true, text: text.slice(0, 4000), at: new Date() };
  await msg.save();
  emit("message:media", { id: msg._id, client: msg.client, media: true });

  const r = parseReceipt(text, msg.from === "me");
  if (!r) return;
  const res = await record(msg.client, {
    amount: r.amount, direction: r.direction, kind: "payment", mode: r.mode, ref: r.ref, at: new Date(msg.sentAt),
    source: msg.from === "me" ? "Our screenshot" : "Payment screenshot", detectedBy: "screenshot", note: text.replace(/\s+/g, " ").slice(0, 400), message: msg._id,
  });
  announce(res);
}

/** Queues every photo that hasn't been read yet (only possible while WhatsApp is connected). */
export async function queueUnreadPhotos({ retryFailed = false } = {}) {
  const filter = retryFailed
    ? { mediaRaw: { $exists: true }, $or: [{ "ocr.done": { $ne: true } }, { "ocr.error": { $exists: true } }] }
    : { mediaRaw: { $exists: true }, "ocr.done": { $ne: true } };
  if (retryFailed) await Message.updateMany({ mediaRaw: { $exists: true }, "ocr.error": { $exists: true } }, { $unset: { ocr: "" } });
  const ids = await Message.find(filter, "_id").sort("-sentAt").lean();
  ids.forEach((m) => queueOcr(m._id));
  return ids.length;
}

/** Runs text detection over every stored message (oldest first). Safe to run again: nothing is recorded twice. */
export async function scanAllText() {
  const cursor = Message.find({ kind: "text" }).sort("sentAt").cursor();
  let n = 0;
  for await (const m of cursor) n += (await detectFromMessage(m)).length;
  return n;
}

// ---------- totals ----------
const counts = (p) => (p.kind || "payment") === "payment" && p.status !== "ignored";
export const receivedOf = (c) => (c.payments || []).filter((p) => counts(p) && (p.direction || "in") === "in").reduce((a, p) => a + p.amount, 0);
export const paidOutOf = (c) => (c.payments || []).filter((p) => counts(p) && p.direction === "out").reduce((a, p) => a + p.amount, 0);

export const __test = { clean, amountsIn, classifyText, parseReceipt, record };
