import mongoose from "mongoose";

export const STAGES = ["New lead", "Negotiation", "In development", "UAT and testing", "Active retainer", "Completed"];

const paymentSchema = new mongoose.Schema({
  date: { type: String, required: true }, // YYYY-MM-DD
  time: String, // "4:37 PM"
  at: Date, // exact date and time of the message it came from
  amount: { type: Number, required: true }, // rupees
  direction: { type: String, enum: ["in", "out"], default: "in" }, // in = received from the client, out = paid by us
  kind: { type: String, enum: ["payment", "mention"], default: "payment" }, // mention = an amount to review (quote, price...)
  status: { type: String, enum: ["detected", "verified", "ignored"], default: "detected" },
  mode: { type: String, default: "UPI" }, // UPI, GPay, PhonePe, NEFT, Cash...
  ref: String, // UTR / UPI reference / transaction id
  source: { type: String, default: "Client message" }, // what in the chat shows it
  detectedBy: { type: String, enum: ["text", "screenshot", "ai", "manual"], default: "manual" },
  note: String, // the message text (or text read from the screenshot)
  message: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
  messages: [{ type: mongoose.Schema.Types.ObjectId, ref: "Message" }], // every message that refers to this payment
  verified: { type: Boolean, default: false }, // kept in sync with status === "verified"
});

const timelineSchema = new mongoose.Schema(
  {
    date: { type: String, default: "" }, // YYYY-MM-DD, empty = upcoming without a date
    label: { type: String, required: true },
    done: { type: Boolean, default: false },
  },
  { _id: false }
);

const clientSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameRank: { type: Number, default: 0 }, // 3 saved contact name, 2 verified business, 1 WhatsApp profile name, 0 number only
    company: { type: String, trim: true },
    city: String,
    phone: { type: String, default: "" }, // display format, e.g. +91 98450 21734 (empty if WhatsApp hides the number)
    waId: { type: String, index: true }, // digits only, e.g. 919845021734
    jid: { type: String, unique: true, sparse: true }, // WhatsApp chat id used for sending, e.g. 919845021734@s.whatsapp.net
    lid: { type: String, index: true, sparse: true }, // WhatsApp's hidden id (@lid) when it uses one for this contact
    source: { type: String, enum: ["demo", "whatsapp", "manual"], default: "manual" },
    color: { type: String, default: "#1E6FD9" },
    stage: { type: String, enum: STAGES, default: "New lead" },
    service: String,
    since: String, // YYYY-MM-DD
    value: { type: Number, default: 0 }, // contract value incl. GST (0 = not won yet)
    quoted: { type: Number, default: 0 },
    sentiment: String,
    unread: { type: Number, default: 0 },

    // AI generated insight
    summary: String,
    next: String, // next best action
    agenda: String, // default agenda for the next meeting
    pending: [String],
    timeline: [timelineSchema],
    alert: {
      order: Number,
      icon: String,
      title: String,
      text: String,
    },
    meetingDefaults: {
      type: { type: String },
      date: String,
      time: String,
      dur: Number,
    },

    payments: [paymentSchema],
    lastMessageAt: Date,

    // ---- AI insight about the conversation (filled by services/ai.service.js) ----
    category: { type: String, enum: ["client", "lead", "vendor", "team", "personal", "other", ""], default: "" },
    project: {
      title: String, // e.g. "Real estate website + lead CRM"
      description: String,
      services: [String],
    },
    projectStatus: String, // one line: where the project stands right now
    startDate: String, // YYYY-MM-DD the project / enquiry started
    duration: String, // e.g. "10 weeks (agreed)", "Monthly retainer since Jun"
    deadline: String, // YYYY-MM-DD or text
    keyFacts: [String],
    ai: {
      summarizedAt: Date,
      messageCount: Number, // messages in the chat when it was summarised
      model: String,
      error: String,
    },

    // ---- Conversation statistics (computed from messages, services/analytics.service.js) ----
    stats: {
      firstMessageAt: Date,
      lastMessageAt: Date,
      lastInboundAt: Date,
      lastOutboundAt: Date,
      total: Number,
      inbound: Number,
      outbound: Number,
      documents: Number,
      activeDays: Number, // days with at least one message
      spanDays: Number, // first to last message
      perWeek: Number, // average messages per week over the span
      avgReplyMinutes: Number, // our average time to reply to the client
      awaitingReply: Boolean, // last message is from the client and unanswered
    },
  },
  { timestamps: true }
);

clientSchema.pre("save", function (next) {
  if (this.isModified("phone") && this.phone) {
    this.waId = this.phone.replace(/\D/g, "");
    if (!this.jid) this.jid = `${this.waId}@s.whatsapp.net`;
  }
  next();
});

export default mongoose.model("Client", clientSchema);
