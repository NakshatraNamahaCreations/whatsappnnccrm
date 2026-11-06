import { Router } from "express";
import { getStatus, connect, logout, reimport, resyncContacts } from "../controllers/whatsapp.controller.js";

const router = Router();
router.post("/reimport", reimport);
router.post("/resync-contacts", resyncContacts);
router.get("/status", getStatus);
router.post("/connect", connect);
router.post("/logout", logout);
router.post("/disconnect", logout); // old name, kept for compatibility
export default router;
