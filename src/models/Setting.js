import mongoose from "mongoose";

// Single document holding workspace-level settings.
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "workspace", unique: true },
    whatsapp: {
      connected: { type: Boolean, default: false },
      number: { type: String, default: "+91 99005 66466" },
      businessName: { type: String, default: "NNC Business" },
      connectedAt: Date,
      lastSyncAt: Date,
    },
    owner: {
      name: { type: String, default: "Harish Kashyap" },
      initials: { type: String, default: "HK" },
    },
  },
  { timestamps: true }
);

// Atomic find-or-create, so parallel callers (e.g. several AI summaries at once) never create two records.
settingSchema.statics.get = async function () {
  try {
    return await this.findOneAndUpdate({ key: "workspace" }, { $setOnInsert: { key: "workspace" } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  } catch (e) {
    if (e.code === 11000) return this.findOne({ key: "workspace" }); // another caller created it a moment ago
    throw e;
  }
};

export default mongoose.model("Setting", settingSchema);
