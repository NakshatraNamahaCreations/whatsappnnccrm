import Client from "../models/Client.js";
import Message from "../models/Message.js";
import Meeting from "../models/Meeting.js";
import { env } from "../config/env.js";
import { getIO } from "../sockets/index.js";
import { sendText, sendTemplate } from "./whatsapp/whatsapp.service.js";
import * as wa from "./whatsapp/baileys.service.js";
import ApiError from "../utils/ApiError.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const emit = (event, payload) => getIO()?.emit(event, payload);

const withinServiceWindow = async (clientId) => {
  const lastInbound = await Message.findOne({ client: clientId, from: "client" }).sort("-sentAt");
  return lastInbound && Date.now() - lastInbound.sentAt.getTime() < DAY_MS;
};

/**
 * Sends a message from us to a client and stores it.
 * - Real mode: goes out through the WhatsApp Cloud API. Outside the 24h window, invites use the approved template.
 * - Demo mode: ticks go sent -> delivered -> read, like the prototype.
 */
export async function sendToClient(client, { text, invite = false, templateParams }) {
  // Demo clients have made-up numbers that may belong to real people: never message them for real.
  if (!env.demoMode && client.source === "demo") {
    throw new ApiError(400, "This is a demo client. Messages to demo clients are not sent on real WhatsApp.");
  }

  if (env.provider === "baileys") {
    const waMessageId = wa.newMessageId(); // saved before sending, so WhatsApp's echo is recognised as the same message
    const message = await Message.create({ client: client._id, from: "me", kind: "text", text, invite, status: "sent", waMessageId });
    await Client.updateOne({ _id: client._id }, { lastMessageAt: message.sentAt, unread: 0 });
    emit("message:new", message);
    try {
      await wa.sendText(client, text, waMessageId); // ticks arrive later through messages.update
    } catch (err) {
      message.status = "failed";
      message.error = err.message;
      await message.save();
      emit("message:status", { id: message._id, client: client._id, status: "failed" });
    }
    return message;
  }

  const message = await Message.create({ client: client._id, from: "me", kind: "text", text, invite, status: "sent" });
  await Client.updateOne({ _id: client._id }, { lastMessageAt: message.sentAt, unread: 0 });
  emit("message:new", message);

  if (env.demoMode) {
    setTimeout(() => setStatus(message._id, "delivered"), 1000);
    setTimeout(() => setStatus(message._id, "read"), 2200);
    return message;
  }

  try {
    const useTemplate = invite && templateParams && !(await withinServiceWindow(client._id));
    message.waMessageId = useTemplate
      ? await sendTemplate(client.phone, env.wa.inviteTemplate, templateParams)
      : await sendText(client.phone, text);
  } catch (err) {
    message.status = "failed";
    message.error = err.response?.data?.error?.message || err.message;
    emit("message:status", { id: message._id, client: client._id, status: "failed" });
  }
  await message.save();
  return message;
}

export async function setStatus(messageId, status) {
  const message = await Message.findByIdAndUpdate(messageId, { status }, { new: true });
  if (message) emit("message:status", { id: message._id, client: message.client, status });
}

/** Stores a message received from a client (webhook or demo). */
export async function receiveFromClient(client, data) {
  const message = await Message.create({ client: client._id, from: "client", status: "received", ...data });
  await Client.updateOne({ _id: client._id }, { lastMessageAt: message.sentAt, $inc: { unread: 1 } });
  emit("message:new", message);
  return message;
}

/** Marks the client's oldest "Awaiting reply" meeting as confirmed and fills the next undated timeline step. */
export async function confirmPendingMeeting(clientId) {
  const meeting = await Meeting.findOne({ client: clientId, status: "Awaiting reply" }).sort("createdAt");
  if (!meeting) return null;
  meeting.status = "Confirmed";
  await meeting.save();

  const client = await Client.findById(clientId);
  const step = client.timeline.find((t) => !t.done && !t.date);
  if (step) {
    step.date = meeting.date;
    await client.save();
    emit("client:updated", client);
  }
  emit("meeting:updated", meeting);
  return meeting;
}

/** Demo only: the client replies YES a few seconds after an invite, which confirms the meeting. */
export function simulateConfirmation(client, meeting) {
  if (!env.demoMode) return;
  setTimeout(async () => {
    const days = (new Date(meeting.date) - new Date(new Date().toDateString())) / DAY_MS;
    const weekday = new Date(`${meeting.date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long" });
    const text = days >= 0 && days < 7 ? `Yes, confirmed. See you on ${weekday} 👍` : "Yes, confirmed. See you then 👍";
    await receiveFromClient(client, { kind: "text", text });
    await Client.updateOne({ _id: client._id }, { unread: 0 }); // the chat is open on screen in the demo
    await confirmPendingMeeting(client._id);
  }, 4600);
}
