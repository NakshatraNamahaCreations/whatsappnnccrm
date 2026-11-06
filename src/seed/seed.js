import Client from "../models/Client.js";
import Message from "../models/Message.js";
import Meeting from "../models/Meeting.js";
import Setting from "../models/Setting.js";
import { clients, meetings } from "./seedData.js";

// "2026-05-12" + "10:42 AM" -> Date (server local time)
const toDate = (d, t) => {
  const [y, m, day] = d.split("-").map(Number);
  const [hm, ap] = t.split(" ");
  let [h, min] = hm.split(":").map(Number);
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return new Date(y, m - 1, day, h, min);
};

const toMessage = (clientId, [d, t, f, x]) => {
  const base = { client: clientId, from: f === "c" ? "client" : "me", sentAt: toDate(d, t), status: f === "c" ? "received" : "read" };
  if (typeof x === "string") return { ...base, kind: "text", text: x };
  if (x.doc) return { ...base, kind: "doc", doc: { name: x.doc, size: x.size } };
  return { ...base, kind: "pay", pay: { amount: x.pay, mode: x.mode }, text: x.text };
};

export async function seedDatabase({ reset = true } = {}) {
  if (reset) {
    await Promise.all([Client.deleteMany({}), Message.deleteMany({}), Meeting.deleteMany({}), Setting.deleteMany({})]);
  }

  const idByKey = {};
  for (const { key, msgs, timeline, ...data } of clients) {
    const client = new Client({
      ...data,
      source: "demo",
      timeline: timeline.map(([date, label, done]) => ({ date, label, done: !!done })),
    });
    const messages = msgs.map((row) => toMessage(client._id, row));
    client.lastMessageAt = messages[messages.length - 1].sentAt;
    await client.save();
    await Message.insertMany(messages);
    idByKey[key] = client._id;
  }

  await Meeting.insertMany(meetings.map(({ cid, ...m }) => ({ ...m, client: idByKey[cid] })));
  await Setting.create({ key: "workspace" }); // starts disconnected, like the prototype

  return { clients: clients.length, meetings: meetings.length };
}
