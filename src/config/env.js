import dotenv from "dotenv";
dotenv.config();

const wa = {
  apiVersion: process.env.WA_API_VERSION || "v21.0",
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID,
  businessAccountId: process.env.WA_BUSINESS_ACCOUNT_ID,
  accessToken: process.env.WA_ACCESS_TOKEN,
  verifyToken: process.env.WA_WEBHOOK_VERIFY_TOKEN,
  inviteTemplate: process.env.WA_INVITE_TEMPLATE || "meeting_invite",
};

/**
 * WA_PROVIDER decides how WhatsApp is connected:
 *  - "baileys" (default): real linked-device QR, like WhatsApp Web. Uses your WhatsApp / WhatsApp Business app.
 *  - "cloud": official Meta WhatsApp Cloud API (needs the WA_* keys above).
 *  - "demo": no WhatsApp at all. Simulates ticks and client replies, like the prototype.
 */
const provider = (process.env.WA_PROVIDER || "baileys").toLowerCase();

export const env = {
  port: process.env.PORT || 5001,
  nodeEnv: process.env.NODE_ENV || "development",
  // one or more allowed site addresses, comma separated (e.g. http://localhost:5173,https://mysite.netlify.app)
  clientUrl: (process.env.CLIENT_URL || "http://localhost:5173").split(",").map((u) => u.trim().replace(/\/$/, "")).filter(Boolean),
  // "embedded" = MongoDB stored in backend/data (no install), "memory" = throwaway demo DB, or a real mongodb:// URI
  mongoUri: process.env.MONGO_URI || "embedded",
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "7d",
  provider,
  demoMode: provider === "demo",
  sessionDir: process.env.WA_SESSION_DIR || "wa-session",
  historyDays: Number(process.env.WA_HISTORY_DAYS || 0), // 0 = keep everything WhatsApp shares
  wa,
};
