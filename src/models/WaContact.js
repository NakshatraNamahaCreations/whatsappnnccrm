import mongoose from "mongoose";

// Everything WhatsApp tells us about a contact. A person can appear under a phone-number id (@s.whatsapp.net)
// and a hidden id (@lid); both are kept here so chats can always be matched to a name and number.
const waContactSchema = new mongoose.Schema(
  {
    lid: { type: String, index: true, sparse: true }, // 1234@lid
    pn: { type: String, index: true, sparse: true }, // 919845021734@s.whatsapp.net
    name: String, // the name saved in your phone's contacts
    notify: String, // the name the person set on their WhatsApp profile
    verifiedName: String, // business name for verified business accounts
  },
  { timestamps: true }
);

export const bestName = (c) => c?.name || c?.verifiedName || c?.notify || "";

export default mongoose.model("WaContact", waContactSchema);
