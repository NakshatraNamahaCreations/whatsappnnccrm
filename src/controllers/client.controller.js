import fs from "fs";
import path from "path";
import Client, { STAGES } from "../models/Client.js";
import Message from "../models/Message.js";
import ApiError from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { sendToClient } from "../services/messaging.service.js";
import { aiEnabled, aiStatus, checkOllama, summarizeClient } from "../services/ai.service.js";
import { computeStats } from "../services/analytics.service.js";

const findClient = async (id) => {
  const client = await Client.findById(id);
  if (!client) throw new ApiError(404, "Client not found");
  return client;
};

const RECENT = 60; // messages per client in the list; the full chat loads when it is opened

// GET /api/clients -> every client with its latest messages and total message count
export const listClients = asyncHandler(async (req, res) => {
  const [clients, recent] = await Promise.all([
    Client.find().sort("-lastMessageAt").lean(),
    Message.aggregate([
      { $sort: { sentAt: -1 } },
      { $project: { mediaRaw: 0, "ocr.text": 0 } }, // photo download details stay on the server
      { $group: { _id: "$client", count: { $sum: 1 }, msgs: { $firstN: { input: "$$ROOT", n: RECENT } } } },
    ]),
  ]);
  const byClient = Object.fromEntries(recent.map((r) => [String(r._id), r]));
  res.json(
    clients.map((c) => {
      const r = byClient[String(c._id)];
      return { ...c, messages: r ? r.msgs.reverse() : [], messageCount: r?.count || 0 };
    })
  );
});

// GET /api/clients/:id -> client with its full message history
export const getClient = asyncHandler(async (req, res) => {
  const client = await findClient(req.params.id);
  const messages = await Message.find({ client: client._id }).sort("sentAt");
  res.json({ ...client.toObject(), messages, messageCount: messages.length });
});

// POST /api/clients
export const createClient = asyncHandler(async (req, res) => {
  res.status(201).json(await Client.create(req.body));
});

// PATCH /api/clients/:id  (stage, notes, AI fields...)
export const updateClient = asyncHandler(async (req, res) => {
  if (req.body.stage && !STAGES.includes(req.body.stage)) throw new ApiError(400, "Invalid stage");
  const patch = { ...req.body };
  if (typeof patch.name === "string") {
    patch.name = patch.name.trim();
    if (!patch.name) throw new ApiError(400, "Name cannot be empty");
    patch.nameRank = 4; // typed by you: WhatsApp sync and AI never overwrite it
  }
  const client = await Client.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
  if (!client) throw new ApiError(404, "Client not found");
  res.json(client);
});

// POST /api/clients/:id/read
export const markRead = asyncHandler(async (req, res) => {
  await Client.updateOne({ _id: req.params.id }, { unread: 0 });
  res.json({ ok: true });
});

// POST /api/clients/:id/messages  { text }
export const sendMessage = asyncHandler(async (req, res) => {
  const text = req.body.text?.trim();
  if (!text) throw new ApiError(400, "Message text is required");
  const client = await findClient(req.params.id);
  res.status(201).json(await sendToClient(client, { text }));
});

// PATCH /api/clients/:id/payments/:paymentId/verify
export const verifyPayment = asyncHandler(async (req, res) => {
  const client = await findClient(req.params.id);
  const payment = client.payments.id(req.params.paymentId);
  if (!payment) throw new ApiError(404, "Payment not found");
  Object.assign(payment, { verified: true, status: "verified", kind: "payment" });
  await client.save();
  res.json(client);
});

/**
 * PATCH /api/clients/:id/payments/:paymentId  { status, kind, direction, amount, mode, ref }
 * e.g. mark an amount to review as a payment, ignore a wrong one, switch received <-> paid out, fix the amount.
 */
export const updatePayment = asyncHandler(async (req, res) => {
  const client = await findClient(req.params.id);
  const payment = client.payments.id(req.params.paymentId);
  if (!payment) throw new ApiError(404, "Payment not found");
  const b = req.body || {};
  if (b.status && !["detected", "verified", "ignored"].includes(b.status)) throw new ApiError(400, "Invalid status");
  if (b.kind && !["payment", "mention"].includes(b.kind)) throw new ApiError(400, "Invalid kind");
  if (b.direction && !["in", "out"].includes(b.direction)) throw new ApiError(400, "Invalid direction");
  if (b.amount != null && !(Number(b.amount) > 0)) throw new ApiError(400, "Amount must be more than 0");
  for (const k of ["status", "kind", "direction", "mode", "ref"]) if (b[k] != null) payment[k] = b[k];
  if (b.amount != null) payment.amount = Math.round(Number(b.amount));
  payment.verified = payment.status === "verified";
  await client.save();
  res.json(client);
});

// POST /api/clients/:id/payments  { amount, direction, date, time, mode, ref, note } -> add a payment by hand
export const addPayment = asyncHandler(async (req, res) => {
  const client = await findClient(req.params.id);
  const { amount, direction = "in", date, time, mode = "", ref = "", note = "" } = req.body || {};
  if (!(Number(amount) > 0)) throw new ApiError(400, "Amount must be more than 0");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new ApiError(400, "Date must be YYYY-MM-DD");
  client.payments.push({
    date, time, at: new Date(`${date}T12:00:00`), amount: Math.round(Number(amount)), direction, kind: "payment",
    status: "verified", verified: true, mode, ref, note, source: "Added by you", detectedBy: "manual",
  });
  await client.save();
  res.status(201).json(client);
});

// GET /api/clients/media/:messageId -> the saved photo of a message (e.g. a payment screenshot)
export const getMedia = asyncHandler(async (req, res) => {
  const msg = await Message.findById(req.params.messageId).lean();
  if (!msg?.media?.path || !fs.existsSync(msg.media.path)) throw new ApiError(404, "Photo not downloaded yet");
  res.type(msg.media.mime || "image/jpeg").sendFile(path.resolve(msg.media.path));
});

// POST /api/clients/:id/summary -> re-reads the whole chat with AI and updates project, status, timeline, etc.
export const refreshSummary = asyncHandler(async (req, res) => {
  await findClient(req.params.id);
  if (!aiEnabled()) await checkOllama();
  if (!aiEnabled()) throw new ApiError(400, aiStatus().setupError);
  await computeStats(req.params.id);
  try {
    res.json(await summarizeClient(req.params.id));
  } catch (e) {
    throw new ApiError(502, `AI summary failed: ${e.message}`);
  }
});
