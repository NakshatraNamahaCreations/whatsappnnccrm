/**
 * AI that reads every conversation, using an open model on YOUR OWN AI server (vLLM on a rented GPU,
 * default Qwen 2.5 32B Instruct). No third-party AI service is involved. See llm.service.js and deploy/gpu-server.
 *  1. Summarises each conversation: project, stage, status, start date, duration, deadline, amounts, payments,
 *     timeline, pending items, next action, mood, and whether it's a client / lead / vendor / team / personal.
 *  2. Answers questions about the CRM data ("Ask your data"), see ask.service.js.
 *
 * Settings (backend/.env): LLM_URL, LLM_API_KEY, AI_MODEL, AI_CONTEXT, AI_CONCURRENCY, AI_AUTO.
 */
import Client, { STAGES } from "../models/Client.js";
import Message from "../models/Message.js";
import Setting from "../models/Setting.js";
import { getIO } from "../sockets/index.js";

import { CONCURRENCY, MODEL, NUM_CTX, SERVER_LABEL, checkLLM, health, llmComplete, llmReady } from "./llm.service.js";
export { MODEL, NUM_CTX };

const MIN_MESSAGES = 3;
const RESUMMARIZE_AFTER = 5; // new messages before a chat is summarised again
const RESUMMARIZE_GAP_MS = 30 * 60 * 1000;
// ~3.5 characters per token for English (fewer for Hindi/Kannada script). Leave room for instructions and the answer.
const MAX_TRANSCRIPT_CHARS = Math.round(Math.max(2000, NUM_CTX - 4500) * 3);
const HEAD_CHARS = Math.round(MAX_TRANSCRIPT_CHARS * 0.2);

const emit = (event, payload) => getIO()?.emit(event, payload);

export const checkOllama = checkLLM; // old name
export { checkLLM };
export const aiEnabled = llmReady;

// ---------- output format ----------
const str = { type: "string" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["category", "contactName", "company", "city", "summary", "project", "stage", "projectStatus", "startDate", "duration", "deadline",
    "quoted", "value", "payments", "sentiment", "pending", "next", "agenda", "timeline", "keyFacts", "alert"],
  properties: {
    category: { type: "string", enum: ["client", "lead", "vendor", "team", "personal", "other"] },
    contactName: str,
    company: str,
    city: str,
    summary: str,
    project: {
      type: "object",
      additionalProperties: false,
      required: ["title", "description", "services"],
      properties: { title: str, description: str, services: { type: "array", items: str } },
    },
    stage: { type: "string", enum: STAGES },
    projectStatus: str,
    startDate: str,
    duration: str,
    deadline: str,
    quoted: { type: "number" },
    value: { type: "number" },
    payments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "amount", "mode", "source"],
        properties: { date: str, amount: { type: "number" }, mode: str, source: str },
      },
    },
    sentiment: str,
    pending: { type: "array", items: str },
    next: str,
    agenda: str,
    timeline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "label", "done"],
        properties: { date: str, label: str, done: { type: "boolean" } },
      },
    },
    keyFacts: { type: "array", items: str },
    alert: {
      type: "object",
      additionalProperties: false,
      required: ["needed", "icon", "title", "text"],
      properties: {
        needed: { type: "boolean" },
        icon: { type: "string", enum: ["chat", "cal", "rupee", "trend", "alert"] },
        title: str,
        text: str,
      },
    },
  },
};

// Kept short and concrete: small models follow short instructions better.
const SYSTEM = `You analyse one WhatsApp conversation between our business and one contact, and fill in a CRM record about it as JSON.
Messages marked "Us" were sent by our business. Messages marked "Contact" were sent by the other person.

The chat may be in English, Hindi, Kannada, Tamil, Telugu, or a mix written in English letters (Hinglish, Kanglish). Read it in whatever language it is written, but write every field in clear English. Keep names of people, companies and products exactly as written.

Fill every field from what the conversation actually says. When something is not mentioned, use an empty string, 0, false or an empty list. Never invent projects, amounts, dates or payments.

Field guide:
- category: "client" (paying or has agreed to work with us), "lead" (enquiring, not yet agreed), "vendor" (we buy from them), "team" (staff or freelancers working with us), "personal" (friends or family, not business), "other".
- contactName: the person's name if the chat reveals it (signature, introduction); otherwise empty.
- summary: 3 to 6 sentences a salesperson can read in 20 seconds: who they are, what they want, how the deal went, where it stands now, and anything they are waiting for.
- project.title: a short name for the work, e.g. "Real estate website + lead CRM". project.description: one or two sentences. project.services: the services involved.
- stage: "New lead" = first enquiry, nothing quoted or agreed. "Negotiation" = price shared, not agreed. "In development" = agreed and work in progress. "UAT and testing" = delivered for review or testing. "Active retainer" = ongoing monthly work. "Completed" = delivered and closed.
- projectStatus: one sentence on where the project stands right now.
- startDate: the date the enquiry or project started, YYYY-MM-DD.
- duration: how long the project has run or ran, plus the agreed timeline if one was given, e.g. "10 weeks agreed, 6 weeks so far" or "Monthly retainer since June 2026".
- deadline: a committed delivery or decision date (YYYY-MM-DD) or a short phrase; empty if none.
- quoted: the latest price we quoted, in rupees, including GST when GST was stated. value: the price both sides agreed, in rupees including GST; 0 if not agreed yet. Convert "25k" to 25000 and "3.5 lakh" to 350000.
- payments: each payment the conversation shows as made (screenshot, "paid", UTR, "received with thanks"), with date YYYY-MM-DD, amount in rupees, mode (UPI, NEFT, cash, bank transfer...) and source (what in the chat shows it).
- sentiment: the contact's mood in a few words.
- pending: concrete open items or promises, either side.
- next: the single most useful next action for us, specific and short.
- agenda: a short agenda for the next meeting with this contact.
- timeline: the key milestones in date order (enquiry, quote, negotiation, agreement, payments, deliveries, approvals, upcoming steps). done=false for future or not-yet-happened steps; date empty if unknown.
- keyFacts: other useful facts (decision maker, preferences, objections, competitor prices, links shared).
- alert: needed=true only if something needs our attention soon (an unanswered question, a promised payment, a decision due, an unhappy contact). Short title and one-line text.`;

// ---------- transcript ----------
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

function line(m) {
  const who = m.from === "me" ? "Us" : "Contact";
  let body = m.text || "";
  if (m.kind === "doc") body = `[document: ${m.doc?.name || "file"}]${m.text ? ` ${m.text}` : ""}`;
  if (m.kind === "pay") body = `[payment ${m.pay?.amount} via ${m.pay?.mode}] ${m.text || ""}`;
  return `[${stamp(new Date(m.sentAt))}] ${who}: ${body.replace(/\s+/g, " ").trim()}`;
}

async function buildTranscript(client) {
  const msgs = await Message.find({ client: client._id }).sort("sentAt").lean();
  let text = msgs.map(line).join("\n");
  let note = "";
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    const head = text.slice(0, HEAD_CHARS);
    const tail = text.slice(-(MAX_TRANSCRIPT_CHARS - HEAD_CHARS));
    text = `${head}\n[... older messages in the middle are left out ...]\n${tail}`;
    note = "Very long chat: the AI read the start and the most recent messages, not the middle.";
  }
  return { text, count: msgs.length, note };
}

// ---------- applying the result ----------
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

function mergePayments(existing, detected) {
  // keep everything found in messages / screenshots / added by you, and anything verified; only AI guesses are replaced
  const verified = existing.filter((p) => p.verified || p.status === "verified" || (p.detectedBy && p.detectedBy !== "ai"));
  const same = (a, b) => a.date === b.date && Math.round(a.amount) === Math.round(b.amount);
  const fresh = detected
    .filter((p) => p.amount > 0 && isDate(p.date))
    .filter((p) => !verified.some((v) => same(v, p)))
    .filter((p) => !verified.some((v) => Math.round(v.amount) === Math.round(p.amount) && v.date && Math.abs(new Date(v.date) - new Date(p.date)) <= 3 * 864e5))
    .map((p) => ({ date: p.date, amount: Math.round(p.amount), mode: p.mode || "Unknown", source: p.source || "Chat", detectedBy: "ai", kind: "payment", direction: "in", status: "detected", verified: false }));
  return [...verified, ...fresh].sort((a, b) => a.date.localeCompare(b.date));
}

async function applyResult(client, r, { count, note }) {
  const patch = {
    category: r.category,
    summary: r.summary,
    project: r.project,
    stage: STAGES.includes(r.stage) ? r.stage : client.stage,
    projectStatus: r.projectStatus,
    startDate: isDate(r.startDate) ? r.startDate : client.since || "",
    duration: r.duration,
    deadline: r.deadline,
    quoted: Math.max(0, Math.round(r.quoted || 0)),
    value: Math.max(0, Math.round(r.value || 0)),
    payments: mergePayments(client.payments || [], r.payments || []),
    sentiment: r.sentiment,
    pending: r.pending || [],
    next: r.next,
    agenda: r.agenda,
    service: r.project?.services?.join(", ") || client.service,
    timeline: (r.timeline || []).map((t) => ({ date: isDate(t.date) ? t.date : "", label: t.label, done: !!t.done })),
    keyFacts: r.keyFacts || [],
    alert: r.alert?.needed && r.alert.title ? { order: -Date.now(), icon: r.alert.icon, title: r.alert.title, text: r.alert.text } : { title: "" },
    ai: { summarizedAt: new Date(), messageCount: count, model: MODEL, error: note || "" },
  };
  if (!client.company && r.company) patch.company = r.company;
  if (!client.city && r.city) patch.city = r.city;
  if ((client.nameRank || 0) === 0 && r.contactName) Object.assign(patch, { name: r.contactName, nameRank: 1 });
  const updated = await Client.findByIdAndUpdate(client._id, patch, { new: true }).lean();
  emit("client:updated", updated);
  return updated;
}

// ---------- one chat ----------
export async function summarizeClient(clientId) {
  if (!aiEnabled()) await checkLLM();
  if (!aiEnabled()) throw new Error(health.error);
  const client = await Client.findById(clientId);
  if (!client) throw new Error("Client not found");
  const { text, count, note } = await buildTranscript(client);
  if (!count) throw new Error("This chat has no messages yet");

  const s = await Setting.get();
  const user =
    `Our business: ${s.whatsapp.businessName || "our business"}.\n` +
    `Contact: ${client.name}${client.phone ? ` (${client.phone})` : ""}.\n` +
    `Today: ${stamp(new Date()).slice(0, 10)}.\n\nCHAT:\n${text}`;

  const started = Date.now();
  const content = await llmComplete({ messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }], schema: SCHEMA });
  status.seconds.push((Date.now() - started) / 1000);
  if (status.seconds.length > 20) status.seconds.shift();

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("The AI returned an unreadable answer");
  }
  return applyResult(client, parsed, { count, note });
}

// ---------- queue (one at a time: the model runs on the CPU) ----------
const queue = [];
const queued = new Set();
let running = 0;
let paused = false;
const status = { done: 0, failed: 0, lastError: "", seconds: [] };

export function aiStatus() {
  const avg = status.seconds.length ? status.seconds.reduce((a, b) => a + b, 0) / status.seconds.length : null;
  return {
    enabled: aiEnabled(),
    server: SERVER_LABEL,
    model: MODEL,
    reachable: health.reachable,
    modelReady: health.modelReady,
    setupError: health.error,
    queued: queue.length,
    running,
    done: status.done,
    failed: status.failed,
    paused,
    lastError: status.lastError,
    avgSeconds: avg ? Math.round(avg) : null,
    etaMinutes: avg ? Math.ceil(((queue.length + running) * avg) / 60) : null,
  };
}
const broadcast = () => emit("ai:status", aiStatus());

export function enqueue(ids, { front = false } = {}) {
  if (!aiEnabled()) return 0;
  let added = 0;
  for (const raw of ids) {
    const id = String(raw);
    if (queued.has(id)) continue;
    queued.add(id);
    front ? queue.unshift(id) : queue.push(id);
    added++;
  }
  if (added) {
    broadcast();
    pump();
  }
  return added;
}

function pump() {
  while (!paused && running < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running++;
    summarizeClient(id)
      .then(() => {
        status.done++;
        status.lastError = "";
      })
      .catch(async (e) => {
        status.failed++;
        status.lastError = e.message;
        console.error(`[AI] summary failed for ${id}:`, e.message);
        await Client.updateOne({ _id: id }, { "ai.error": e.message }).catch(() => {});
        await checkLLM();
        if (!aiEnabled()) paused = true; // AI server stopped: wait until it is back
      })
      .finally(() => {
        running--;
        queued.delete(id);
        broadcast();
        pump();
      });
  }
}

/** Queues every chat that has never been summarised or has changed a lot since. */
export async function summarizeAll({ force = false } = {}) {
  await checkLLM();
  if (!aiEnabled()) return 0;
  paused = false;
  const clients = await Client.find({ "stats.total": { $gte: MIN_MESSAGES } }, { stats: 1, ai: 1, source: 1 }).sort("-lastMessageAt").lean();
  const ids = clients
    .filter((c) => c.source !== "demo")
    .filter((c) => force || !c.ai?.summarizedAt || (c.stats?.total || 0) - (c.ai?.messageCount || 0) >= RESUMMARIZE_AFTER)
    .map((c) => c._id);
  const added = enqueue(ids);
  pump(); // also restarts chats that were waiting while the AI server was offline
  return added;
}

/** Called after messages change: re-summarise chats that have moved on since their last summary. */
export async function onMessagesChanged(ids) {
  if (!aiEnabled() || paused || process.env.AI_AUTO === "false") return;
  const clients = await Client.find({ _id: { $in: ids } }, { stats: 1, ai: 1, source: 1 }).lean();
  const due = clients.filter((c) => {
    if (c.source === "demo" || (c.stats?.total || 0) < MIN_MESSAGES) return false;
    if (!c.ai?.summarizedAt) return true;
    const grown = (c.stats.total || 0) - (c.ai.messageCount || 0) >= RESUMMARIZE_AFTER;
    return grown && Date.now() - new Date(c.ai.summarizedAt) > RESUMMARIZE_GAP_MS;
  });
  enqueue(due.map((c) => c._id));
}

/**
 * Watches the AI server: when it becomes reachable (GPU server started, model loaded),
 * the AI turns on and, unless AI_AUTO=false, starts on chats that have no summary yet.
 */
export function startAiWatcher() {
  let wasReady = false;
  const tick = async () => {
    await checkLLM();
    if (aiEnabled() !== wasReady) {
      wasReady = aiEnabled();
      console.log(wasReady ? `[AI] ready: ${MODEL} on ${SERVER_LABEL}` : `[AI] off: ${health.error}`);
      broadcast();
      if (wasReady && process.env.AI_AUTO !== "false") summarizeAll().then((n) => n && console.log(`[AI] queued ${n} chats for summaries`));
    }
  };
  tick();
  setInterval(tick, 15000).unref();
}

// for tests
export const __test = { SCHEMA, applyResult, buildTranscript, mergePayments, health };
