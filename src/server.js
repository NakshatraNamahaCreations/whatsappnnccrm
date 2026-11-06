import http from "http";
import app from "./app.js";
import { env } from "./config/env.js";
import { connectDB } from "./config/db.js";
import { initSocket } from "./sockets/index.js";
import * as wa from "./services/whatsapp/baileys.service.js";

// Log unexpected async errors instead of letting one bad event take the whole CRM down.
process.on("unhandledRejection", (e) => console.error("Unhandled error:", e?.message || e));

const start = async () => {
  await connectDB();
  const server = http.createServer(app);
  initSocket(server, env.allowOrigin);
  server.listen(env.port, () => {
    console.log(`Server running on http://localhost:${env.port}`);
    console.log(`WhatsApp mode: ${env.provider}`);
  });

  // Fill in conversation statistics for chats imported before statistics existed.
  const { default: Client } = await import("./models/Client.js");
  if (await Client.exists({ "stats.total": { $exists: false } })) {
    const { recomputeAll } = await import("./services/analytics.service.js");
    recomputeAll().then((n) => console.log(`Conversation statistics computed for ${n} chats`));
  }
  // AI server (your GPU server): the AI turns itself on as soon as the server is reachable.
  const { startAiWatcher } = await import("./services/ai.service.js");
  startAiWatcher();

  // Meetings: Google Meet / Zoom / Teams links in chats become calendar entries; past meetings are marked completed.
  const { startMeetingWatcher } = await import("./services/meetings.service.js");
  startMeetingWatcher();

  // Payments: amounts in existing messages are recorded once (new messages are checked as they arrive).
  const { scanAllText } = await import("./services/payments.service.js");
  scanAllText().then((n) => n && console.log(`[payments] ${n} payments / amounts found in existing messages`)).catch((e) => console.error("[payments] scan error:", e.message));

  // Reconnect the saved WhatsApp session (if someone scanned before) without needing a new QR.
  if (env.provider === "baileys" && wa.hasSession()) {
    wa.start().then(() => console.log("Reconnecting saved WhatsApp session...")).catch((e) => console.error("WhatsApp start failed:", e.message));
  }
};

start();
