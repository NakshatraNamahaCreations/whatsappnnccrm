import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, index: true },
    from: { type: String, enum: ["client", "me"], required: true },
    kind: { type: String, enum: ["text", "doc", "pay"], default: "text" },
    text: String,
    doc: { name: String, size: String },
    pay: { amount: Number, mode: String },
    invite: { type: Boolean, default: false }, // meeting invite or reminder
    status: { type: String, enum: ["sent", "delivered", "read", "failed", "received"], default: "sent" },
    waMessageId: { type: String, unique: true, sparse: true }, // WhatsApp message id, used to avoid duplicates
    error: String,
    sentAt: { type: Date, default: Date.now, index: true },

    // Photos: what is needed to download them from WhatsApp, the saved copy, and the text read from them (OCR)
    mediaRaw: { type: String, select: false },
    media: { path: String, mime: String },
    ocr: { done: Boolean, text: String, at: Date, error: String },
  },
  { timestamps: true }
);

export default mongoose.model("Message", messageSchema);
