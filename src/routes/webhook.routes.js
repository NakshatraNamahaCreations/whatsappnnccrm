import { Router } from "express";
import { verifyWebhook, receiveWebhook } from "../webhooks/whatsapp.webhook.js";

const router = Router();
router.get("/whatsapp", verifyWebhook);
router.post("/whatsapp", receiveWebhook);
export default router;
