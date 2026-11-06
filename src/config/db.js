import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import mongoose from "mongoose";
import { env } from "./env.js";

export const EMBEDDED_PORT = 27027;
export const EMBEDDED_URI = `mongodb://127.0.0.1:${EMBEDDED_PORT}/whatsapp_crm`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function canConnect(uri) {
  const conn = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 800 });
  try {
    await conn.asPromise();
    return true;
  } catch {
    return false;
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * "embedded": runs MongoDB as a separate background process with data in backend/data/db.
 * It keeps running when the backend restarts (nodemon), and the next start simply reuses it.
 * Stop it with `npm run db:stop`.
 */
async function ensureEmbedded() {
  if (await canConnect(EMBEDDED_URI)) return EMBEDDED_URI;

  const { MongoBinary } = await import("mongodb-memory-server");
  const bin = await MongoBinary.getPath(); // downloads the MongoDB binary the first time
  const dbPath = path.resolve("data/db");
  fs.mkdirSync(dbPath, { recursive: true });
  const args = ["--dbpath", dbPath, "--port", String(EMBEDDED_PORT), "--bind_ip", "127.0.0.1", "--logpath", path.resolve("data/mongod.log"), "--logappend"];

  if (process.platform === "win32") {
    // Start-Process gives mongod no living parent, so nodemon's restarts (which kill the whole process tree) leave it running.
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argList = args.map((a) => (a.includes(" ") ? q(`"${a}"`) : q(a))).join(",");
    spawn("powershell.exe", ["-NoProfile", "-Command", `Start-Process -FilePath ${q(bin)} -ArgumentList ${argList} -WindowStyle Hidden`], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  }
  console.log(`Starting embedded MongoDB (data in ${dbPath})`);

  for (let i = 0; i < 40; i++) {
    await wait(500);
    if (await canConnect(EMBEDDED_URI)) return EMBEDDED_URI;
  }
  throw new Error("Embedded MongoDB did not start. See backend/data/mongod.log");
}

/**
 * MONGO_URI options:
 *  - "embedded": MongoDB saved in backend/data (nothing to install, survives restarts)
 *  - "memory":   throwaway MongoDB filled with the demo data, wiped on restart
 *  - anything else: a normal connection string (local MongoDB or Atlas)
 */
export const connectDB = async () => {
  try {
    let uri = env.mongoUri;
    let seedDemo = false;

    if (uri === "embedded") {
      uri = await ensureEmbedded();
    } else if (uri === "memory") {
      const { MongoMemoryServer } = await import("mongodb-memory-server");
      const server = await MongoMemoryServer.create();
      uri = server.getUri("whatsapp_crm");
      seedDemo = true;
      console.log("Using in-memory MongoDB (data resets on restart)");
    }

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log("MongoDB connected");

    if (seedDemo) {
      const { seedDatabase } = await import("../seed/seed.js");
      await seedDatabase();
      console.log("Demo data seeded");
    }
  } catch (err) {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  }
};
