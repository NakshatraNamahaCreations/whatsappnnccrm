/**
 * Meetings from WhatsApp chats + minutes of meeting (MoM).
 *
 * - Every Google Meet / Zoom / Teams link shared in a chat becomes a meeting in the calendar.
 *   If the message (or one just before it) says when ("tomorrow 4 pm", "Monday 10:30"), that time is used;
 *   otherwise the time the link was sent is used, because links are usually sent as the meeting starts.
 * - Meetings whose time has passed are marked Completed.
 * - After a meeting, notes / a transcript can be added; the AI turns them into minutes (summary, decisions,
 *   action items with owner and due date, next meeting). Without the AI server the notes are saved as they are.
 */
import * as chrono from "chrono-node";
import Client from "../models/Client.js";
import Message from "../models/Message.js";
import Meeting from "../models/Meeting.js";
import { getIO } from "../sockets/index.js";
import { aiEnabled, checkLLM, MODEL } from "./ai.service.js";
import { llmComplete } from "./llm.service.js";

const emit = (event, payload) => getIO()?.emit(event, payload);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm12 = (d) => {
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${ap}`;
};
const toDate = (date, time) => {
  const [y, m, d] = date.split("-").map(Number);
  const [hmPart, ap] = (time || "12:00 PM").split(" ");
  let [h, min] = hmPart.split(":").map(Number);
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return new Date(y, m - 1, d, h, min || 0);
};

// ---------- link detection ----------
const LINK_RE = /\b(?:https?:\/\/)?(meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3}|meet\.google\.com\/lookup\/[\w-]+|(?:[\w-]+\.)?zoom\.us\/(?:j|my)\/[\w?=&.-]+|teams\.(?:microsoft|live)\.com\/[^\s]+)/gi;

export function findLinks(text) {
  const out = [];
  for (const m of (text || "").matchAll(LINK_RE)) {
    const url = m[1];
    const type = /zoom\.us/i.test(url) ? "zoom" : /teams\./i.test(url) ? "teams" : "meet";
    const code = type === "meet" ? url.split("/").pop() : type === "zoom" ? (url.match(/\/(?:j|my)\/([\w.-]+)/) || [])[1] : "";
    out.push({ url: `https://${url}`, type, code });
  }
  return out;
}

/** A time stated in the text (relative to when it was sent), or null. Hours 1-7 without am/pm are read as afternoon. */
export function timeIn(text, sentAt) {
  const r = chrono.en.GB.parse(text || "", sentAt, { forwardDate: true }).find((x) => x.start.isCertain("hour"));
  if (!r) return null;
  const d = r.start.date();
  if (!r.start.isCertain("meridiem") && d.getHours() >= 1 && d.getHours() <= 7) d.setHours(d.getHours() + 12);
  // ignore times far from the message (e.g. "since 2019") - meetings are set up to a month ahead
  if (d < new Date(sentAt.getTime() - 12 * 3600e3) || d > new Date(sentAt.getTime() + 31 * 864e5)) return null;
  return d;
}

const TYPE_LABEL = { meet: "Google Meet", zoom: "Zoom", teams: "Teams" };

/** Finds meetings in one client's chat. Returns the number of meetings created or updated. */
export async function detectForClient(clientId) {
  const client = await Client.findById(clientId).lean();
  if (!client) return 0;
  const msgs = await Message.find({ client: clientId, kind: "text", text: { $regex: /meet\.google\.com|zoom\.us\/|teams\.(microsoft|live)\.com/i } }).sort("sentAt").lean();
  let changed = 0;
  for (const m of msgs) {
    if (m.invite) continue; // invites sent from the CRM already have their meeting
    for (const link of findLinks(m.text)) {
      if (await Meeting.exists({ message: m._id, link: link.url })) continue;

      // when: the message itself, else a message just before it (within 12 h) that states a time
      let when = timeIn(m.text, m.sentAt);
      let timeFrom = when ? "message-text" : "link-sent";
      if (!when) {
        const before = await Message.find({ client: clientId, sentAt: { $gte: new Date(m.sentAt - 12 * 3600e3), $lt: m.sentAt } }).sort("-sentAt").limit(4).lean();
        for (const b of before) {
          const t = timeIn(b.text, b.sentAt);
          if (t && Math.abs(t - m.sentAt) < 12 * 3600e3) {
            when = t;
            timeFrom = "message-text";
            break;
          }
        }
      }
      if (!when) when = new Date(m.sentAt);

      // the same link sent again around the same time (e.g. a reminder) is the same meeting
      const dayKey = ymd(when);
      const same = await Meeting.findOne({ client: clientId, link: link.url, date: { $in: [dayKey, ymd(new Date(when - 864e5)), ymd(new Date(+when + 864e5))] } });
      if (same) continue;

      const meeting = await Meeting.create({
        client: clientId,
        title: `${TYPE_LABEL[link.type]} with ${client.name}`,
        type: link.type,
        date: dayKey,
        time: hm12(when),
        dur: 30,
        status: when < new Date() ? "Completed" : "Confirmed",
        code: link.code,
        link: link.url,
        source: "chat",
        message: m._id,
        timeFrom,
        reminder: false,
      });
      emit("meeting:updated", meeting.toObject());
      changed++;
    }
  }
  return changed;
}

export async function detectAll() {
  const ids = await Message.distinct("client", { text: { $regex: /meet\.google\.com|zoom\.us\/|teams\.(microsoft|live)\.com/i } });
  let n = 0;
  for (const id of ids) n += await detectForClient(id);
  return n;
}

/** Marks meetings whose end time has passed as Completed (unless they were never confirmed). */
export async function markPastCompleted() {
  const now = new Date();
  const open = await Meeting.find({ status: "Confirmed", date: { $lte: ymd(now) } });
  let n = 0;
  for (const m of open) {
    if (toDate(m.date, m.time).getTime() + (m.dur || 30) * 60000 < now.getTime()) {
      m.status = "Completed";
      await m.save();
      emit("meeting:updated", m.toObject());
      n++;
    }
  }
  return n;
}

export function startMeetingWatcher() {
  const run = async () => {
    try {
      const found = await detectAll();
      const done = await markPastCompleted();
      if (found || done) console.log(`[meetings] ${found} found in chats, ${done} marked completed`);
    } catch (e) {
      console.error("[meetings] error:", e.message);
    }
  };
  run();
  setInterval(() => markPastCompleted().catch(() => {}), 10 * 60000).unref();
}

// ---------- minutes of meeting ----------
const str = { type: "string" };
const MOM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "discussed", "decisions", "actionItems", "nextMeeting"],
  properties: {
    summary: str,
    discussed: { type: "array", items: str },
    decisions: { type: "array", items: str },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task", "owner", "due"],
        properties: { task: str, owner: str, due: str },
      },
    },
    nextMeeting: str,
  },
};

const MOM_SYSTEM = `You write minutes of meeting (MoM) for a meeting between our business and a client.
You get the meeting details, the notes or transcript of the meeting, and the WhatsApp messages exchanged around it.
The notes may be in English, Hindi, Kannada or a mix; write the minutes in clear English. Keep names exactly as written.
Only use what the notes and messages say. Do not invent decisions, prices or dates.
- summary: 2 to 4 sentences on what the meeting was about and its outcome.
- discussed: the topics covered, one short line each.
- decisions: what was agreed or decided.
- actionItems: concrete tasks with owner ("Us", "Client", or a person's name) and due (YYYY-MM-DD if a date is given, otherwise a short phrase or "").
- nextMeeting: the next meeting date/time or plan if mentioned, else "".`;

/** Creates or replaces the minutes of a meeting from notes / a transcript. */
export async function createMom(meetingId, notes) {
  const meeting = await Meeting.findById(meetingId);
  if (!meeting) throw new Error("Meeting not found");
  const text = (notes || "").trim();
  if (!text) throw new Error("Add the meeting notes or transcript first");
  const client = await Client.findById(meeting.client).lean();
  const now = new Date();

  if (!aiEnabled()) await checkLLM();
  if (!aiEnabled()) {
    // No AI server: keep the notes as the minutes; the summary is the first lines
    meeting.mom = {
      notes: text,
      summary: text.split(/\n+/).slice(0, 3).join(" ").slice(0, 600),
      discussed: [], decisions: [], actionItems: [], nextMeeting: "",
      by: "manual", createdAt: meeting.mom?.createdAt || now, updatedAt: now,
    };
    await meeting.save();
    emit("meeting:updated", meeting.toObject());
    return { meeting, ai: false };
  }

  const start = toDate(meeting.date, meeting.time);
  const around = await Message.find({ client: meeting.client, sentAt: { $gte: new Date(start - 864e5), $lte: new Date(+start + 2 * 864e5) } }).sort("sentAt").limit(80).lean();
  const chat = around.map((m) => `[${ymd(new Date(m.sentAt))} ${hm12(new Date(m.sentAt))}] ${m.from === "me" ? "Us" : client?.name || "Client"}: ${(m.text || (m.doc ? `[document ${m.doc.name}]` : "")).replace(/\s+/g, " ")}`).join("\n");
  const content = await llmComplete({
    schema: MOM_SCHEMA,
    messages: [
      { role: "system", content: MOM_SYSTEM },
      {
        role: "user",
        content:
          `Meeting: ${meeting.title}, ${meeting.date} at ${meeting.time} (${meeting.type}).\nClient: ${client?.name || ""}${client?.company ? `, ${client.company}` : ""}.\n` +
          (client?.project?.title ? `Project: ${client.project.title}.\n` : "") +
          `\nMEETING NOTES / TRANSCRIPT:\n${text.slice(0, 40000)}\n\nWHATSAPP MESSAGES AROUND THE MEETING:\n${chat || "(none)"}`,
      },
    ],
  });
  const r = JSON.parse(content);
  meeting.mom = { notes: text, ...r, actionItems: r.actionItems.map((a) => ({ ...a, done: false })), by: "ai", model: MODEL, createdAt: meeting.mom?.createdAt || now, updatedAt: now };
  meeting.status = "Completed";
  await meeting.save();
  emit("meeting:updated", meeting.toObject());
  return { meeting, ai: true };
}

/** Plain-text minutes, for sharing on WhatsApp. */
export function momText(meeting, businessName = "") {
  const m = meeting.mom || {};
  const lines = [`*Minutes of meeting*`, `${meeting.title}`, `${meeting.date}, ${meeting.time}`, ""];
  if (m.summary) lines.push(m.summary, "");
  if (m.discussed?.length) lines.push("*Discussed*", ...m.discussed.map((x) => `• ${x}`), "");
  if (m.decisions?.length) lines.push("*Decisions*", ...m.decisions.map((x) => `• ${x}`), "");
  if (m.actionItems?.length) lines.push("*Action items*", ...m.actionItems.map((a) => `• ${a.task}${a.owner ? ` (${a.owner})` : ""}${a.due ? ` - ${a.due}` : ""}`), "");
  if (m.nextMeeting) lines.push(`*Next meeting:* ${m.nextMeeting}`, "");
  if (!m.summary && m.notes) lines.push(m.notes, "");
  if (businessName) lines.push(`Regards,\n${businessName}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const __test = { findLinks, timeIn, toDate, MOM_SCHEMA };
