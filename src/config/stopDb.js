// npm run db:stop  -> cleanly shuts down the embedded MongoDB background process
import mongoose from "mongoose";
import { EMBEDDED_URI } from "./db.js";

try {
  const conn = await mongoose.createConnection(EMBEDDED_URI, { serverSelectionTimeoutMS: 1500 }).asPromise();
  await conn.db.admin().command({ shutdown: 1 }).catch(() => {}); // the connection drops as the server stops
  console.log("Embedded MongoDB stopped.");
} catch {
  console.log("Embedded MongoDB is not running.");
}
process.exit(0);
