import { Router } from "express";
import {
  listMeetings, createMeeting, updateMeeting, deleteMeeting, remindMeeting,
  createMinutes, updateMinutes, shareMinutes, detectMeetings,
} from "../controllers/meeting.controller.js";

const router = Router();
router.route("/").get(listMeetings).post(createMeeting);
router.post("/detect", detectMeetings);
router.route("/:id").patch(updateMeeting).delete(deleteMeeting);
router.post("/:id/remind", remindMeeting);
router.route("/:id/mom").post(createMinutes).patch(updateMinutes);
router.post("/:id/mom/share", shareMinutes);
export default router;
