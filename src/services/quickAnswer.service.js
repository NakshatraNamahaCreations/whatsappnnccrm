/**
 * Answers common questions straight from the database, without any AI model.
 * Used by "Ask AI" and the voice assistant while the AI server is off. Understands simple questions in
 * English, Hindi and Kannada (by keywords) and answers in English, with exact figures.
 */
import Client from "../models/Client.js";
import Meeting from "../models/Meeting.js";
import { dashboard } from "./analytics.service.js";

const DAY = 864e5;
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${new Date(d).getFullYear()}-${pad(new Date(d).getMonth() + 1)}-${pad(new Date(d).getDate())}`;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nice = (d) => `${new Date(d).getDate()} ${MON[new Date(d).getMonth()]}`;
const ago = (d) => {
  if (!d) return "never";
  const h = (Date.now() - new Date(d)) / 3600e3;
  if (h < 1) return "less than an hour ago";
  if (h < 24) return `${Math.round(h)} hours ago`;
  const days = Math.round(h / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
};
const hours = (m) => (m == null ? "unknown" : m < 60 ? `${m} minutes` : `${(m / 60).toFixed(1).replace(/\.0$/, "")} hours`);
const rs = (n) => `Rs. ${Math.round(n || 0).toLocaleString("en-IN")}`;
// "11:30 AM" -> minutes since midnight, for sorting meetings on the same day
const mins = (t) => {
  const [hm, ap] = (t || "12:00 AM").split(" ");
  let [h, m] = hm.split(":").map(Number);
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return h * 60 + (m || 0);
};
const newestFirst = (a, b) => b.date.localeCompare(a.date) || mins(b.time) - mins(a.time);
const list = (names, max = 5) => {
  if (!names.length) return "";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return shown.join(", ") + (rest > 0 ? ` and ${rest} more` : "");
};
// keeps letters, digits and combining marks (Kannada / Hindi vowel signs)
export const words = (s) => (s || "").toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length >= 2);

const INTENTS = [
  ["replyTime", /reply time|response time|how fast|how quick|average|औसत|ಸರಾಸರಿ/],
  ["waiting", /wait|reply|respond|unanswered|pending|jawab|javab|जवाब|इंतज़ार|इंतजार|ಉತ್ತರ|ಕಾಯ|ಪ್ರತ್ಯುತ್ತರ/],
  ["money", /money|owe|outstanding|\bdue\b|paid|payment|collect|revenue|income|pais|पैस|भुगतान|बकाया|ಹಣ|ಪಾವತಿ|ಬಾಕಿ/],
  ["meetings", /meeting|schedule|appointment|calendar|मीटिंग|बैठक|ಸಭೆ|ಮೀಟಿಂಗ್/],
  ["quiet", /quiet|inactive|silent|gone cold|follow.?up|not talk|no response|ठंड|फॉलो|ಮೌನ|ಫಾಲೋ/],
  ["mostActive", /most active|top|busiest|biggest|सबसे ज्यादा|ಹೆಚ್ಚು/],
  ["newConv", /\bnew\b|this month|नए|नया|इस महीने|ಹೊಸ|ಈ ತಿಂಗಳು/],
  ["active", /active|this week|today|सक्रिय|इस हफ्ते|आज|ಈ ವಾರ|ಇಂದು/],
  ["totals", /how many|total|count|number of|कितने|कुल|ಎಷ್ಟು|ಒಟ್ಟು/],
  ["overview", /overview|summary|summari|business|how is|how are|report|status|सारांश|व्यापार|बिज़नेस|ಸಾರಾಂಶ|ವ್ಯವಹಾರ|ಬಿಸಿನೆಸ್/],
];

function findContacts(question, clients) {
  const q = new Set(words(question));
  const STOP = new Set(["the", "and", "for", "who", "how", "is", "are", "of", "me", "my", "about", "tell", "show", "chat", "with", "what", "when", "last", "from", "to", "in", "on", "status", "project"]);
  return clients
    .map((c) => ({ c, score: words(c.name).filter((w) => w.length >= 3 && !STOP.has(w) && q.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

function contactAnswer(c) {
  const st = c.stats || {};
  const parts = [`${c.name}${c.phone ? ` (${c.phone})` : ""}.`];
  if (st.total) {
    parts.push(`You've been talking since ${nice(st.firstMessageAt)}: ${st.total} messages, ${st.inbound} from them and ${st.outbound} from you, about ${st.perWeek} a week.`);
    parts.push(`The last message was ${ago(st.lastMessageAt)}${st.awaitingReply ? ", from them, and they are waiting for your reply" : ", from you"}.`);
    if (st.avgReplyMinutes != null) parts.push(`You usually reply within ${hours(st.avgReplyMinutes)}.`);
  }
  if (c.project?.title) parts.push(`Project: ${c.project.title}. Stage: ${c.stage}.${c.projectStatus ? ` ${c.projectStatus}` : ""}`);
  if (c.summary) parts.push(c.summary);
  if (c.next) parts.push(`Next step: ${c.next}`);
  if (c._meetings?.length) {
    const last = c._meetings[0];
    parts.push(`${c._meetings.length} meeting${c._meetings.length === 1 ? "" : "s"} so far; the last was on ${nice(last.date)} at ${last.time}${last.mom?.summary ? `. Minutes: ${last.mom.summary}` : ", with no minutes added yet"}.`);
  }
  if (!c.ai?.summarizedAt && c.source !== "demo") parts.push("Project details and payments will be added once the AI server has read this chat.");
  return parts.join(" ");
}

/** Returns { answer, intent } or null when the question isn't one of the common ones. */
export async function quickAnswer(question) {
  const q = question.toLowerCase();
  const [clients, d] = await Promise.all([Client.find({}).lean(), dashboard({ weeks: 8 })]);
  const t = d.totals;
  const intent = INTENTS.find(([, re]) => re.test(q))?.[0];

  // a named contact wins over general questions ("what's the status of Pradeep")
  const named = findContacts(question, clients);
  if (named.length && !["totals", "mostActive", "newConv", "quiet"].includes(intent)) {
    named[0]._meetings = (await Meeting.find({ client: named[0]._id, date: { $lte: ymd(new Date()) } }).lean()).sort(newestFirst);
    return { intent: "contact", answer: contactAnswer(named[0]) + (named.length > 1 ? ` (Also matching: ${list(named.slice(1).map((c) => c.name), 3)}.)` : "") };
  }

  const waiting = clients.filter((c) => c.stats?.awaitingReply).sort((a, b) => new Date(b.stats.lastInboundAt) - new Date(a.stats.lastInboundAt));
  const recent = (days) => clients.filter((c) => c.stats?.lastMessageAt && Date.now() - new Date(c.stats.lastMessageAt) < days * DAY);
  const quiet = clients
    .filter((c) => c.stats?.lastMessageAt && Date.now() - new Date(c.stats.lastMessageAt) > 14 * DAY && !["personal", "team"].includes(c.category))
    .sort((a, b) => new Date(b.stats.lastMessageAt) - new Date(a.stats.lastMessageAt));
  const now = new Date();
  const newThisMonth = clients.filter((c) => {
    const f = c.stats?.firstMessageAt && new Date(c.stats.firstMessageAt);
    return f && f.getMonth() === now.getMonth() && f.getFullYear() === now.getFullYear();
  });

  switch (intent) {
    case "waiting":
      return {
        intent,
        answer: waiting.length
          ? `${waiting.length} ${waiting.length === 1 ? "person is" : "people are"} waiting for your reply. Most recent: ${list(waiting.map((c) => `${c.name} (${ago(c.stats.lastInboundAt)})`))}.`
          : "Nobody is waiting for your reply right now.",
      };
    case "replyTime":
      return { intent, answer: `Your average reply time is ${hours(t.avgReplyMinutes)}, measured across ${t.conversations} conversations.` };
    case "active": {
      const today = recent(1);
      const week = recent(7);
      return { intent, answer: `${week.length} conversations were active in the last 7 days${week.length ? `: ${list(week.map((c) => c.name))}` : ""}. ${today.length ? `Today: ${list(today.map((c) => c.name))}.` : "None today yet."}` };
    }
    case "newConv":
      return { intent, answer: newThisMonth.length ? `${newThisMonth.length} new conversations started this month: ${list(newThisMonth.map((c) => c.name))}.` : "No new conversations have started this month yet." };
    case "quiet":
      return { intent, answer: quiet.length ? `${quiet.length} conversations have been quiet for more than two weeks. Worth a follow-up: ${list(quiet.map((c) => `${c.name} (last message ${ago(c.stats.lastMessageAt)})`))}.` : "No conversations have gone quiet for more than two weeks." };
    case "mostActive":
      return { intent, answer: `Your most active conversations: ${list(d.mostActive.map((c) => `${c.name} with ${c.total} messages`), 5)}.` };
    case "totals":
      return { intent, answer: `You have ${t.conversations} conversations with ${t.messages} messages. ${t.activeThisWeek} were active this week, ${t.awaitingReply} are waiting for your reply, and ${t.newThisMonth} are new this month.` };
    case "money": {
      const all = clients.flatMap((c) =>
        (c.payments || []).filter((p) => (p.kind || "payment") === "payment" && p.status !== "ignored").map((p) => ({ ...p, who: c.name }))
      );
      const recentPay = all.sort((a, b) => new Date(b.at || b.date) - new Date(a.at || a.date)).slice(0, 4);
      const parts = [`Payments found in your chats: received ${rs(t.collected)}, paid out ${rs(t.paidOut)}.`];
      if (recentPay.length) parts.push(`Latest: ${recentPay.map((p) => `${rs(p.amount)} ${p.direction === "out" ? "paid to" : "from"} ${p.who} on ${nice(p.at || p.date)}`).join("; ")}.`);
      if (t.unverified) parts.push(`${t.unverified} ${t.unverified === 1 ? "payment needs" : "payments need"} checking against your bank statement.`);
      if (t.toReview) parts.push(`${t.toReview} other ${t.toReview === 1 ? "amount was" : "amounts were"} mentioned in chats and ${t.toReview === 1 ? "is" : "are"} waiting for review in Payments.`);
      if (t.outstanding) parts.push(`Still due on agreed projects: ${rs(t.outstanding)}.`);
      return { intent, answer: parts.join(" ") };
    }
    case "meetings": {
      const byId = Object.fromEntries(clients.map((c) => [String(c._id), c.name]));
      const who = (m) => byId[String(m.client)] || "a client";
      if (/last|previous|past|history|held|minutes|\bmom\b|पिछल|ಹಿಂದಿನ|ಕಳೆದ/.test(q)) {
        const past = (await Meeting.find({ date: { $lte: ymd(now) } }).lean()).sort(newestFirst).slice(0, 6);
        if (!past.length) return { intent, answer: "No meetings have been held yet." };
        const noMom = past.filter((m) => !m.mom).length;
        return {
          intent,
          answer:
            `Your recent meetings: ${past.map((m) => `${nice(m.date)} at ${m.time} with ${who(m)}${m.mom?.summary ? ` (minutes: ${m.mom.summary.slice(0, 120)})` : ""}`).join("; ")}.` +
            (noMom ? ` ${noMom} of these ${noMom === 1 ? "has" : "have"} no minutes yet; you can add them in Calendar, Meeting history.` : ""),
        };
      }
      const upcoming = await Meeting.find({ date: { $gte: ymd(now) }, status: { $ne: "Completed" } }).sort("date").limit(5).lean();
      const last = (await Meeting.find({ date: { $lte: ymd(now) } }).lean()).sort(newestFirst)[0];
      return {
        intent,
        answer:
          (upcoming.length ? `Upcoming meetings: ${upcoming.map((m) => `${m.title} on ${nice(m.date)} at ${m.time}`).join("; ")}.` : "You have no upcoming meetings.") +
          (last ? ` Your last meeting was with ${who(last)} on ${nice(last.date)} at ${last.time}.` : ""),
      };
    }
    case "overview":
      return {
        intent,
        answer:
          `Here's your business at a glance. ${t.conversations} conversations and ${t.messages} messages in total. ` +
          `${t.activeThisWeek} were active in the last 7 days and ${t.newThisMonth} started this month. ` +
          `${t.awaitingReply} people are waiting for your reply${waiting.length ? `, most recently ${list(waiting.map((c) => c.name), 3)}` : ""}. ` +
          `Your average reply time is ${hours(t.avgReplyMinutes)}.` +
          (t.analysed ? ` Money so far: ${rs(t.collected)} collected, ${rs(t.outstanding)} still due.` : ""),
      };
    default:
      return null;
  }
}

export const QUICK_HELP =
  "I can answer that once the AI server is running. Right now I can tell you: who is waiting for your reply, which chats are active this week, " +
  "new conversations this month, your average reply time, chats that have gone quiet, your most active chats, upcoming meetings, " +
  "a business overview, or about any contact by name, for example: tell me about Pradeep.";
