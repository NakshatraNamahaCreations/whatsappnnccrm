import { Router } from "express";
import authRoutes from "./auth.routes.js";
import clientRoutes from "./client.routes.js";
import meetingRoutes from "./meeting.routes.js";
import whatsappRoutes from "./whatsapp.routes.js";
import webhookRoutes from "./webhook.routes.js";
import insightsRoutes from "./insights.routes.js";

const router = Router();
router.use("/insights", insightsRoutes);
router.use("/auth", authRoutes);
router.use("/clients", clientRoutes);
router.use("/meetings", meetingRoutes);
router.use("/whatsapp", whatsappRoutes);
router.use("/webhook", webhookRoutes);
export default router;
