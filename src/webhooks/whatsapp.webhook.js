import Client from "../models/Client.js";
import { env } from "../config/env.js";
import { receiveFromClient, setStatus, confirmPendingMeeting } from "../services/messaging.service.js";
import Message from "../models/Message.js";

// GET /api/webhook/whatsapp -> Meta verification handshake
export const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === env.wa.verifyToken) return res.status(200).send(challenge);
  res.sendStatus(403);
};

// Formats a WhatsApp id (919845021734) as "+91 98450 21734" for new Indian numbers.
const displayPhone = (waId) =>
  waId.startsWith("91") && waId.length === 12 ? `+91 ${waId.slice(2, 7)} ${waId.slice(7)}` : `+${waId}`;

const toMessageData = (msg) => {
  if (msg.type === "text") return { kind: "text", text: msg.text.body };
  if (msg.type === "document") return { kind: "doc", doc: { name: msg.document.filename || "Document", size: "" }, text: msg.document.caption };
  // Images (e.g. UPI screenshots) arrive here. Payment detection from the image is a TODO for the AI step.
  return { kind: "text", text: msg[msg.type]?.caption || `[${msg.type}]` };
};

// POST /api/webhook/whatsapp -> incoming messages and delivery status updates
export const receiveWebhook = async (req, res) => {
  res.sendStatus(200); // acknowledge quickly, then process
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    for (const msg of value.messages || []) {
      let client = await Client.findOne({ waId: msg.from });
      if (!client) {
        client = await Client.create({
          name: value.contacts?.[0]?.profile?.name || displayPhone(msg.from),
          phone: displayPhone(msg.from),
          stage: "New lead",
          since: new Date().toISOString().slice(0, 10),
          summary: "New enquiry received on WhatsApp.",
        });
      }
      const data = toMessageData(msg);
      await receiveFromClient(client, { ...data, waMessageId: msg.id, sentAt: new Date(Number(msg.timestamp) * 1000) });

      // A "yes" reply confirms the meeting invite that is waiting for this client.
      if (data.kind === "text" && /^\s*(yes|confirmed?|ok)\b/i.test(data.text || "")) {
        await confirmPendingMeeting(client._id);
      }
    }

    for (const st of value.statuses || []) {
      const message = await Message.findOne({ waMessageId: st.id });
      if (message) await setStatus(message._id, st.status);
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
};
