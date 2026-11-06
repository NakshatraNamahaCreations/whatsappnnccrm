import mongoose from "mongoose";

export const MEETING_TYPES = ["meet", "zoom", "office", "site", "call", "teams"];

const actionSchema = new mongoose.Schema(
  {
    task: String,
    owner: String, // "Us", "Client", or a name
    due: String, // YYYY-MM-DD or text
    done: { type: Boolean, default: false },
  },
  { _id: false }
);

// Minutes of meeting
const momSchema = new mongoose.Schema(
  {
    notes: String, // what was pasted: your notes, the Google Meet transcript or Gemini notes
    summary: String,
    discussed: [String],
    decisions: [String],
    actionItems: [actionSchema],
    nextMeeting: String,
    by: { type: String, enum: ["ai", "manual"], default: "manual" },
    model: String,
    sharedAt: Date, // when it was sent to the client on WhatsApp
    createdAt: Date,
    updatedAt: Date,
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    title: { type: String, required: true },
    type: { type: String, enum: MEETING_TYPES, required: true },
    office: { type: String, default: "blr" }, // used when type === "office"
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    time: { type: String, required: true }, // e.g. "11:00 AM"
    dur: { type: Number, default: 30 }, // minutes
    status: { type: String, enum: ["Awaiting reply", "Confirmed", "Completed"], default: "Confirmed" },
    code: String, // meet / zoom join code
    reminder: { type: Boolean, default: true },

    // Meetings found in WhatsApp chats (a Google Meet / Zoom / Teams link was shared)
    source: { type: String, enum: ["crm", "chat"], default: "crm" },
    link: String, // full join link
    message: { type: mongoose.Schema.Types.ObjectId, ref: "Message", index: true }, // the message the link came from
    timeFrom: { type: String, enum: ["crm", "message-text", "link-sent"], default: "crm" }, // how the time was worked out

    mom: momSchema,
  },
  { timestamps: true }
);

export default mongoose.model("Meeting", meetingSchema);
