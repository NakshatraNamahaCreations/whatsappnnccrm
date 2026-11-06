/**
 * "Ask your data": answers questions about the CRM with the AI model on your AI server.
 *
 * Language models are unreliable at counting or querying a database themselves, so the backend does the exact work:
 * it turns the database into a compact, pre-calculated briefing (totals, lists, one line per contact) and adds the
 * full details of any contact the question mentions. The model only reads that briefing and explains it.
 */
import Client from "../models/Client.js";
import Message from "../models/Message.js";
import Meeting from "../models/Meeting.js";
import { dashboard } from "./analytics.service.js";
import { aiEnabled, checkLLM, NUM_CTX } from "./ai.service.js";
import { llmStream } from "./llm.service.js";
import { QUICK_HELP, quickAnswer } from "./quickAnswer.service.js";
import { receivedOf } from "./payments.service.js";

const DAY = 864e5;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => (d ? `${new Date(d).getFullYear()}-${pad(new Date(d).getMonth() + 1)}-${pad(new Date(d).getDate())}` : "-");
const rs = (n) => `Rs. ${Math.round(n || 0).toLocaleString("en-IN")}`;
const daysAgo = (d) => (d ? Math.max(0, Math.round((Date.now() - new Date(d)) / DAY)) : null);
const agoText = (d) => {
  const n = daysAgo(d);
  return n == null ? "-" : n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
};
const received = receivedOf;
// keeps letters, digits and combining marks, so Kannada / Hindi words stay intact
const words = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 3);
const STOP = new Set(["the", "and", "for", "with", "what", "which", "who", "how", "many", "much", "are", "was", "this", "that", "from", "have", "has", "his", "her", "their", "client", "clients", "project", "status", "about", "show", "tell", "give", "list", "all", "any", "did", "does", "when", "last", "week", "month", "today", "payment", "paid", "pending", "chat", "chats", "message", "messages"]);

/** Contacts whose name, company or project the question mentions, best match first. */
function mentioned(question, clients) {
  const q = new Set(words(question).filter((w) => !STOP.has(w)));
  if (!q.size) return [];
  return clients
    .map((c) => {
      const nameWords = words(`${c.name} ${c.company || ""}`);
      const projWords = words(c.project?.title || "");
      const score = nameWords.filter((w) => q.has(w)).length * 3 + projWords.filter((w) => q.has(w)).length;
      const phoneHit = /\d{5,}/.test(question) && c.phone && c.phone.replace(/\D/g, "").includes(question.replace(/\D/g, "").slice(-5));
      return { c, score: score + (phoneHit ? 5 : 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

function contactLine(c) {
  const st = c.stats || {};
  const analysed = !!c.ai?.summarizedAt || c.source === "demo";
  const due = c.value ? Math.max(0, c.value - received(c)) : 0;
  return [
    c.name,
    c.phone || "no number",
    analysed ? c.category || "-" : "not analysed",
    analysed ? c.stage : "-",
    c.project?.title || "-",
    c.projectStatus || "-",
    c.quoted || c.value ? rs(c.value || c.quoted) : "-",
    received(c) ? rs(received(c)) : "-",
    due ? rs(due) : "-",
    ymd(st.firstMessageAt),
    `${agoText(st.lastMessageAt)}${st.lastMessageAt ? (st.awaitingReply ? " (from them)" : " (from us)") : ""}`,
    `${st.total || 0} (${st.inbound || 0} in / ${st.outbound || 0} out)`,
    st.perWeek ?? "-",
    st.awaitingReply ? "YES" : "no",
  ].join(" | ");
}

async function detailBlock(c) {
  const msgs = await Message.find({ client: c._id }).sort("-sentAt").limit(25).lean();
  const meetings = await Meeting.find({ client: c._id }).sort("date").lean();
  const lines = msgs.reverse().map((m) => `  [${ymd(m.sentAt)}] ${m.from === "me" ? "Us" : c.name}: ${(m.kind === "doc" ? `[document ${m.doc?.name}] ` : "") + (m.text || "").replace(/\s+/g, " ").slice(0, 220)}`);
  return [
    `DETAILS FOR ${c.name} (${c.phone || "no number"})`,
    `Summary: ${c.summary || "not summarised by AI yet"}`,
    c.project?.title ? `Project: ${c.project.title}. ${c.project.description || ""}` : "",
    c.projectStatus ? `Status: ${c.projectStatus}` : "",
    c.startDate ? `Started: ${c.startDate}` : "",
    c.duration ? `Duration: ${c.duration}` : "",
    c.deadline ? `Deadline: ${c.deadline}` : "",
    c.value || c.quoted ? `Price: ${rs(c.value || c.quoted)}${c.value ? " (agreed)" : " (quoted)"}; paid ${rs(received(c))}` : "",
    (c.payments || []).some((p) => (p.kind || "payment") === "payment" && p.status !== "ignored") ? `Payments: ${c.payments.filter((p) => (p.kind || "payment") === "payment" && p.status !== "ignored").map((p) => `${p.date} ${p.time || ""} ${p.direction === "out" ? "paid out" : "received"} ${rs(p.amount)} ${p.mode || ""}${p.ref ? ` ref ${p.ref}` : ""}${p.status === "verified" ? " (verified)" : ""}`).join("; ")}` : "",
    (c.pending || []).length ? `Pending: ${c.pending.join("; ")}` : "",
    c.next ? `Next step: ${c.next}` : "",
    (c.timeline || []).length ? `Timeline: ${c.timeline.map((t) => `${t.date || "upcoming"} ${t.label}${t.done ? "" : " (not done)"}`).join("; ")}` : "",
    meetings.length ? `Meetings: ${meetings.map((m) => `${m.date} ${m.time} ${m.title} (${m.status})${m.mom?.summary ? ` - minutes: ${m.mom.summary}${m.mom.actionItems?.length ? ` Action items: ${m.mom.actionItems.map((x) => `${x.task} (${x.owner || "-"}${x.due ? `, ${x.due}` : ""}${x.done ? ", done" : ""})`).join("; ")}` : ""}` : ""}`).join("; ")}` : "",
    `Last ${lines.length} messages:`,
    ...lines,
  ].filter(Boolean).join("\n");
}

/** Builds the briefing the model answers from. Exported for tests and for showing "what the AI saw". */
export async function buildContext(question) {
  const [clients, d, meetings] = await Promise.all([
    Client.find({}).lean(),
    dashboard({ weeks: 8 }),
    Meeting.find({ date: { $gte: ymd(new Date()) }, status: { $ne: "Completed" } }).sort("date").lean(),
  ]);
  const t = d.totals;
  const byId = Object.fromEntries(clients.map((c) => [String(c._id), c]));
  const waiting = clients.filter((c) => c.stats?.awaitingReply).sort((a, b) => new Date(b.stats.lastInboundAt) - new Date(a.stats.lastInboundAt));
  const owing = clients.filter((c) => c.value && c.value > received(c)).sort((a, b) => b.value - received(b) - (a.value - received(a)));
  const newThisMonth = clients.filter((c) => {
    const f = c.stats?.firstMessageAt && new Date(c.stats.firstMessageAt);
    const n = new Date();
    return f && f.getMonth() === n.getMonth() && f.getFullYear() === n.getFullYear();
  });
  const quiet = clients.filter((c) => (daysAgo(c.stats?.lastMessageAt) ?? 0) > 14 && !["personal", "team"].includes(c.category));
  const stageText = Object.entries(d.byStage).map(([s, n]) => `${s} ${n}`).join(", ") || "none yet (chats not analysed)";
  const catText = Object.entries(d.byCategory).map(([k, n]) => `${k} ${n}`).join(", ");

  const focus = mentioned(question, clients).slice(0, 2);
  const focusIds = new Set(focus.map((c) => String(c._id)));
  const ordered = [...focus, ...clients.filter((c) => !focusIds.has(String(c._id))).sort((a, b) => new Date(b.stats?.lastMessageAt || 0) - new Date(a.stats?.lastMessageAt || 0))];
  const budget = NUM_CTX * 4 * 0.55; // characters available for the contact table
  const rows = [];
  let used = 0;
  for (const c of ordered) {
    const l = contactLine(c);
    if (used + l.length > budget * 0.6) break;
    rows.push(l);
    used += l.length;
  }

  const parts = [
    `TODAY: ${ymd(new Date())}`,
    "OVERVIEW (exact numbers, use these as they are):",
    `- Conversations: ${t.conversations} total. Active in the last 7 days: ${t.activeThisWeek}. New this month: ${t.newThisMonth}${newThisMonth.length ? ` (${newThisMonth.map((c) => c.name).join(", ")})` : ""}.`,
    `- Messages: ${t.messages}. Our average reply time: ${t.avgReplyMinutes == null ? "unknown" : `${(t.avgReplyMinutes / 60).toFixed(1)} hours`}.`,
    `- Waiting for our reply: ${waiting.length}${waiting.length ? ` -> ${waiting.slice(0, 15).map((c) => `${c.name} (${agoText(c.stats.lastInboundAt)})`).join(", ")}` : ""}.`,
    `- No messages for over 14 days: ${quiet.length}${quiet.length ? ` -> ${quiet.slice(0, 12).map((c) => c.name).join(", ")}` : ""}.`,
    `- Chats summarised by AI: ${t.analysed} of ${t.conversations}. Contact types: ${catText}.`,
    `- Pipeline by stage: ${stageText}. Leads/negotiations ${t.leads}, in progress ${t.inProgress}, completed ${t.completed}.`,
    `- Money: received ${rs(t.collected)} and paid out ${rs(t.paidOut)} (payments found in chats and screenshots). Quoted/agreed ${rs(t.quoted)}, outstanding ${rs(t.outstanding)}${owing.length ? ` -> owed by ${owing.slice(0, 10).map((c) => `${c.name} ${rs(c.value - received(c))}`).join(", ")}` : ""}.`,
    `- Upcoming meetings: ${meetings.length ? meetings.slice(0, 8).map((m) => `${m.date} ${m.time} ${m.title} with ${byId[String(m.client)]?.name || "?"} (${m.status})`).join("; ") : "none"}.`,
    "",
    `CONTACTS (${rows.length} of ${clients.length}, most recent first):`,
    "name | phone | type | stage | project | status | price | paid | due | first message | last message | messages | per week | waiting for our reply",
    ...rows,
  ];
  for (const c of focus) parts.push("", await detailBlock(c));
  return { text: parts.join("\n"), focus: focus.map((c) => ({ _id: c._id, name: c.name })) };
}

const SYSTEM = `You are the assistant inside a WhatsApp CRM for a small Indian agency. You answer the owner's questions about their clients and business.
Answer ONLY from the CRM DATA given below. The numbers in OVERVIEW are exact: repeat them, do not recount.
If the data does not contain the answer, say so plainly (for example, project details and payments exist only for chats that AI has summarised).
Be short and practical: a direct answer first, then a few bullet points if useful. Use names, dates and "Rs." amounts from the data.
Reply in the language the question is asked in (English, Hindi, Kannada...). Messages quoted in the data may be in any of these languages.`;

/**
 * Streams an answer. onToken(text) is called for each piece; resolves with { focus } when done.
 * history: [{ role: "user"|"assistant", content }] earlier turns (last few are kept).
 */
export async function ask({ question, history = [], onToken, signal }) {
  if (!aiEnabled()) await checkLLM();
  if (!aiEnabled()) {
    // No AI server: answer common questions straight from the database
    const qa = await quickAnswer(question);
    onToken(qa ? qa.answer : QUICK_HELP);
    return { focus: [], mode: "quick", intent: qa?.intent || null };
  }
  const ctx = await buildContext(question);
  await llmStream({
    signal,
    messages: [
      { role: "system", content: `${SYSTEM}\n\nCRM DATA:\n${ctx.text}` },
      ...history.slice(-6).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 2000) })),
      { role: "user", content: question },
    ],
  }, onToken);

  return { focus: ctx.focus };
}
