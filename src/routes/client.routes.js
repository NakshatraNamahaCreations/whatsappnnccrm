import { Router } from "express";
import {
  listClients, getClient, createClient, updateClient, markRead, sendMessage, verifyPayment, refreshSummary,
  updatePayment, addPayment, getMedia,
} from "../controllers/client.controller.js";

// NOTE: open for now to match the prototype (no login screen). Add `protect` from middlewares/auth.js before going live.
const router = Router();
router.route("/").get(listClients).post(createClient);
router.get("/media/:messageId", getMedia);
router.route("/:id").get(getClient).patch(updateClient);
router.post("/:id/read", markRead);
router.post("/:id/messages", sendMessage);
router.post("/:id/summary", refreshSummary);
router.patch("/:id/payments/:paymentId/verify", verifyPayment);
router.patch("/:id/payments/:paymentId", updatePayment);
router.post("/:id/payments", addPayment);
export default router;
