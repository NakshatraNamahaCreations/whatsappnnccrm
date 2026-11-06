// npm run seed  -> wipes clients, messages, meetings and settings, then loads the demo data
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { seedDatabase } from "./seed.js";

await connectDB();
const result = await seedDatabase();
console.log(`Seeded ${result.clients} clients and ${result.meetings} meetings.`);
await mongoose.disconnect();
process.exit(0);
