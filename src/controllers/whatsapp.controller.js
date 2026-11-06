import Client from "../models/Client.js";
import Message from "../models/Message.js";
import Meeting from "../models/Meeting.js";
import Setting from "../models/Setting.js";
import { env } from "../config/env.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getIO } from "../sockets/index.js";
import * as wa from "../services/whatsapp/baileys.service.js";
import WaContact from "../models/WaContact.js";
import ApiError from "../utils/ApiError.js";
import { aiStatus } from "../services/ai.service.js";

// POST /api/whatsapp/resync-contacts -> fetch the names saved in the phone's contacts
export const resyncContacts = asyncHandler(async (req, res) => {
  try {
    res.json(await wa.resyncContacts());
  } catch (e) {
    throw new ApiError(400, e.message);
  }
});

/**
 * POST /api/whatsapp/reimport
 * Rebuilds every WhatsApp chat from the saved copy of the history (no new QR scan needed).
 */
export const reimport = asyncHandler(async (req, res) => {
  if (env.provider !== "baileys") throw new ApiError(400, "Re-import is only for the QR (linked device) mode");
  try {
    const result = await wa.reimportFromRaw();
    res.json(result);
  } catch (e) {
    throw new ApiError(400, e.message);
  }
});

const counts = async () => {
  const [clients, messages, meetings, pay] = await Promise.all([
    Client.countDocuments(),
    Message.countDocuments(),
    Meeting.countDocuments(),
    Client.aggregate([{ $project: { n: { $size: "$payments" } } }, { $group: { _id: null, n: { $sum: "$n" } } }]),
  ]);
  return { clients, messages, meetings, payments: pay[0]?.n || 0 };
};

async function statusPayload() {
  const s = await Setting.get();
  const base = { provider: env.provider, demoMode: env.demoMode, owner: s.owner, businessName: s.whatsapp.businessName, stats: await counts(), ai: aiStatus() };
  if (env.provider === "baileys") {
    const live = wa.getState();
    const connected = ["connected", "syncing"].includes(live.status);
    return { ...base, ...live, connected, number: live.number || s.whatsapp.number, businessName: live.name || s.whatsapp.businessName };
  }
  return { ...base, status: s.whatsapp.connected ? "connected" : "idle", connected: s.whatsapp.connected, number: s.whatsapp.number };
}

// GET /api/whatsapp/status
export const getStatus = asyncHandler(async (req, res) => res.json(await statusPayload()));

/**
 * POST /api/whatsapp/connect
 * Linked device: starts a WhatsApp session. The QR arrives over the socket ("wa:state") and in /status.
 * Demo / Cloud API: marks the number as connected.
 */
export const connect = asyncHandler(async (req, res) => {
  if (env.provider === "baileys") {
    await wa.start();
    return res.json(await statusPayload());
  }
  const s = await Setting.get();
  s.whatsapp.connected = true;
  s.whatsapp.connectedAt = new Date();
  await s.save();
  res.json(await statusPayload());
});

/**
 * POST /api/whatsapp/logout  { wipe?: boolean }
 * Unlinks the device from the phone (it disappears from WhatsApp > Linked devices).
 * With wipe=true, the chats and clients imported from WhatsApp are also deleted from the CRM.
 */
export const logout = asyncHandler(async (req, res) => {
  if (env.provider === "baileys") await wa.logout();
  await Setting.updateOne({ key: "workspace" }, { "whatsapp.connected": false });

  if (req.body?.wipe) {
    const ids = (await Client.find({ source: "whatsapp" }, "_id")).map((c) => c._id);
    await Promise.all([
      Message.deleteMany({ client: { $in: ids } }),
      Meeting.deleteMany({ client: { $in: ids } }),
      Client.deleteMany({ _id: { $in: ids } }),
      WaContact.deleteMany({}),
    ]);
    wa.deleteRaw(); // the saved copy of the WhatsApp history goes too
  }
  const payload = await statusPayload();
  getIO()?.emit("wa:state", payload);
  getIO()?.emit("clients:refresh");
  res.json(payload);
});
