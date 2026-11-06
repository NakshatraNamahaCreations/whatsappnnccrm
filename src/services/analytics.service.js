/**
 * Conversation statistics computed straight from the messages (no AI):
 * when the chat started, how long it has run, message volume and frequency, reply times, waiting-on-reply.
 * Also builds the business dashboard.
 */
import Client from "../models/Client.js";
import Message from "../models/Message.js";
import Meeting from "../models/Meeting.js";
import { paidOutOf, receivedOf } from "./payments.service.js";
import { getIO } from "../sockets/index.js";

const DAY = 864e5;
const REPLY_WINDOW_MS = 3 * DAY; // replies later than this count as a new conversation, not a slow reply

// ---------- per-client stats ----------
export async function computeStats(clientId) {
  const msgs = await Message.find({ client: clientId }, { from: 1, kind: 1, sentAt: 1 }).sort("sentAt").lean();
  if (!msgs.length) return null;

  const days = new Set();
  let inbound = 0, outbound = 0, documents = 0, lastInboundAt = null, lastOutboundAt = null;
  const replyGaps = [];
  let pendingSince = null; // first unanswered client message

  for (const m of msgs) {
    days.add(m.sentAt.toISOString().slice(0, 10));
    if (m.kind === "doc") documents++;
    if (m.from === "client") {
      inbound++;
      lastInboundAt = m.sentAt;
      if (!pendingSince) pendingSince = m.sentAt;
    } else {
      outbound++;
      lastOutboundAt = m.sentAt;
      if (pendingSince) {
        const gap = m.sentAt - pendingSince;
        if (gap >= 0 && gap <= REPLY_WINDOW_MS) replyGaps.push(gap);
        pendingSince = null;
      }
    }
  }

  const first = msgs[0].sentAt;
  const last = msgs[msgs.length - 1].sentAt;
  const spanDays = Math.max(1, Math.round((last - first) / DAY) + 1);
  const stats = {
    firstMessageAt: first,
    lastMessageAt: last,
    lastInboundAt,
    lastOutboundAt,
    total: msgs.length,
    inbound,
    outbound,
    documents,
    activeDays: days.size,
    spanDays,
    perWeek: Math.round((msgs.length / Math.max(1, spanDays / 7)) * 10) / 10,
    avgReplyMinutes: replyGaps.length ? Math.round(replyGaps.reduce((a, b) => a + b, 0) / replyGaps.length / 60000) : null,
    awaitingReply: msgs[msgs.length - 1].from === "client",
  };
  await Client.updateOne({ _id: clientId }, { stats });
  return stats;
}

// Recompute in the background shortly after messages change (many messages arrive in bursts).
const dirty = new Set();
let timer = null;
export function markDirty(clientId) {
  dirty.add(String(clientId));
  clearTimeout(timer);
  timer = setTimeout(flush, 3000);
}
async function flush() {
  const ids = [...dirty];
  dirty.clear();
  for (const id of ids) {
    try {
      const stats = await computeStats(id);
      if (stats) getIO()?.emit("client:updated", { _id: id, stats });
    } catch (e) {
      console.error("[analytics] stats error:", e.message);
    }
  }
  // let the AI step know which chats changed
  const { onMessagesChanged } = await import("./ai.service.js");
  onMessagesChanged(ids);
  // meeting links shared in those chats become calendar entries
  const { detectForClient } = await import("./meetings.service.js");
  for (const id of ids) await detectForClient(id).catch((e) => console.error("[meetings] detect error:", e.message));
}

export async function recomputeAll() {
  const ids = (await Client.find({}, "_id").lean()).map((c) => c._id);
  for (const id of ids) await computeStats(id);
  return ids.length;
}

// ---------- business dashboard ----------
const startOfWeek = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
};
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function dashboard({ weeks = 12 } = {}) {
  const now = new Date();
  const from = startOfWeek(new Date(now.getTime() - (weeks - 1) * 7 * DAY));

  const [clients, weekly, meetings] = await Promise.all([
    Client.find({}, { name: 1, company: 1, color: 1, stage: 1, category: 1, value: 1, quoted: 1, payments: 1, project: 1, projectStatus: 1, stats: 1, unread: 1, alert: 1, ai: 1, since: 1, source: 1 }).lean(),
    Message.aggregate([
      { $match: { sentAt: { $gte: from } } },
      { $group: { _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$sentAt" } }, from: "$from" }, n: { $sum: 1 } } },
    ]),
    Meeting.find({ date: { $gte: isoDay(now) }, status: { $ne: "Completed" } }).lean(),
  ]);

  // messages per week, split by who sent them
  const buckets = [];
  for (let i = 0; i < weeks; i++) {
    const start = new Date(from.getTime() + i * 7 * DAY);
    buckets.push({ week: isoDay(start), inbound: 0, outbound: 0 });
  }
  for (const r of weekly) {
    const idx = Math.floor((startOfWeek(new Date(`${r._id.day}T12:00:00`)) - from) / (7 * DAY));
    if (idx >= 0 && idx < weeks) buckets[idx][r._id.from === "client" ? "inbound" : "outbound"] += r.n;
  }

  // new conversations per month (first message), last 6 months
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, count: 0 });
  }
  for (const c of clients) {
    const f = c.stats?.firstMessageAt && new Date(c.stats.firstMessageAt);
    if (!f) continue;
    const key = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, "0")}`;
    const m = months.find((x) => x.month === key);
    if (m) m.count++;
  }

  const business = clients.filter((c) => !["personal", "team", "vendor"].includes(c.category));
  // A chat's stage and money only mean something once AI has read it (new chats default to "New lead").
  const classified = business.filter((c) => c.ai?.summarizedAt || c.source === "demo");
  const received = receivedOf;
  const week = 7 * DAY;
  const activeThisWeek = clients.filter((c) => c.stats?.lastMessageAt && now - new Date(c.stats.lastMessageAt) < week);
  const waiting = business
    .filter((c) => c.stats?.awaitingReply && c.stats?.lastInboundAt)
    .sort((a, b) => new Date(b.stats.lastInboundAt) - new Date(a.stats.lastInboundAt));
  const replyTimes = business.map((c) => c.stats?.avgReplyMinutes).filter((v) => v != null);

  const byCategory = {};
  for (const c of clients) byCategory[c.category || "not analysed"] = (byCategory[c.category || "not analysed"] || 0) + 1;
  const byStage = {};
  for (const c of classified) byStage[c.stage] = (byStage[c.stage] || 0) + 1;

  const totalMsgs = clients.reduce((a, c) => a + (c.stats?.total || 0), 0);
  return {
    generatedAt: now,
    totals: {
      conversations: clients.length,
      businessConversations: business.length,
      messages: totalMsgs,
      activeThisWeek: activeThisWeek.length,
      newThisMonth: months[months.length - 1].count,
      awaitingReply: waiting.length,
      avgReplyMinutes: replyTimes.length ? Math.round(replyTimes.reduce((a, b) => a + b, 0) / replyTimes.length) : null,
      quoted: classified.reduce((a, c) => a + (c.value || c.quoted || 0), 0),
      collected: clients.reduce((a, c) => a + received(c), 0), // payments found in chats count even before AI
      paidOut: clients.reduce((a, c) => a + paidOutOf(c), 0),
      toReview: clients.reduce((a, c) => a + (c.payments || []).filter((p) => p.kind === "mention" && p.status !== "ignored").length, 0),
      unverified: clients.reduce((a, c) => a + (c.payments || []).filter((p) => (p.kind || "payment") === "payment" && p.status === "detected").length, 0),
      outstanding: classified.reduce((a, c) => a + (c.value ? Math.max(0, c.value - received(c)) : 0), 0),
      inProgress: classified.filter((c) => ["In development", "UAT and testing", "Active retainer"].includes(c.stage)).length,
      completed: classified.filter((c) => c.stage === "Completed").length,
      leads: classified.filter((c) => ["New lead", "Negotiation"].includes(c.stage)).length,
      analysed: clients.filter((c) => c.ai?.summarizedAt).length,
      upcomingMeetings: meetings.length,
    },
    weekly: buckets,
    monthlyNew: months,
    byCategory,
    byStage,
    waiting: waiting.slice(0, 8).map((c) => ({ _id: c._id, name: c.name, color: c.color, since: c.stats.lastInboundAt, project: c.project?.title || "" })),
    mostActive: [...business]
      .sort((a, b) => (b.stats?.total || 0) - (a.stats?.total || 0))
      .slice(0, 6)
      .map((c) => ({ _id: c._id, name: c.name, color: c.color, total: c.stats?.total || 0, perWeek: c.stats?.perWeek || 0, project: c.project?.title || "", stage: c.stage })),
  };
}
