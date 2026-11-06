import axios from "axios";
import { env } from "../../config/env.js";

const client = axios.create({
  baseURL: `https://graph.facebook.com/${env.wa.apiVersion}/${env.wa.phoneNumberId}`,
  headers: { Authorization: `Bearer ${env.wa.accessToken}` },
});

const waId = (phone) => phone.replace(/\D/g, "");

export const sendText = async (phone, body) => {
  const { data } = await client.post("/messages", {
    messaging_product: "whatsapp",
    to: waId(phone),
    type: "text",
    text: { body },
  });
  return data.messages?.[0]?.id;
};

// Template messages are required when the client has not messaged in the last 24 hours.
export const sendTemplate = async (phone, name, params = [], language = "en") => {
  const { data } = await client.post("/messages", {
    messaging_product: "whatsapp",
    to: waId(phone),
    type: "template",
    template: {
      name,
      language: { code: language },
      components: params.length ? [{ type: "body", parameters: params.map((text) => ({ type: "text", text: String(text) })) }] : [],
    },
  });
  return data.messages?.[0]?.id;
};
