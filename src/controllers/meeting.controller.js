import Client from "../models/Client.js";
import Meeting, { MEETING_TYPES } from "../models/Meeting.js";
import ApiError from "../utils/ApiError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { env } from "../config/env.js";
import { sendToClient, simulateConfirmation } from "../services/messaging.service.js";
import { createMom, detectAll, markPastCompleted, momText } from "../services/meetings.service.js";
import Setting from "../models/Setting.js";

// GET /api/meetings?from=YYYY-MM-DD&to=YYYY-MM-DD
export const listMeetings = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = req.query.from;
    if (req.query.to) filter.date.$lte = req.query.to;
  }
  res.json(await Meeting.find(filter).sort("date"));
});

/**
 * POST /api/meetings
 * { client, title, type, office, date, time, dur, code, reminder, sendInvite, inviteText, templateParams }
 * With sendInvite the meeting starts as "Awaiting reply" and the invite goes to the client's WhatsApp.
 */
export const createMeeting = asyncHandler(async (req, res) => {
  const { client: clientId, title, type, office, date, time, dur, code, reminder, sendInvite, inviteText, templateParams } = req.body;
  if (!MEETING_TYPES.includes(type)) throw new ApiError(400, "Invalid meeting type");
  if (!title || !date || !time) throw new ApiError(400, "Title, date and time are required");
  if (sendInvite && !inviteText) throw new ApiError(400, "inviteText is required to send an invite");

  const client = await Client.findById(clientId);
  if (!client) throw new ApiError(404, "Client not found");
  if (sendInvite && !env.demoMode && client.source === "demo") {
    throw new ApiError(400, "This is a demo client. Untick 'Send invite' to only add it to the calendar.");
  }

  const meeting = await Meeting.create({
    client: client._id, title, type, office, date, time, dur, code, reminder,
    status: sendInvite ? "Awaiting reply" : "Confirmed",
  });

  let message = null;
  if (sendInvite) {
    message = await sendToClient(client, { text: inviteText, invite: true, templateParams });
    simulateConfirmation(client, meeting);
  }
  res.status(201).json({ meeting, message });
});

// PATCH /api/meetings/:id
export const updateMeeting = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!meeting) throw new ApiError(404, "Meeting not found");
  res.json(meeting);
});

// DELETE /api/meetings/:id
export const deleteMeeting = asyncHandler(async (req, res) => {
  await Meeting.findByIdAndDelete(req.params.id);
  res.status(204).end();
});

// POST /api/meetings/:id/mom  { notes } -> writes the minutes from your notes / the transcript (AI if available)
export const createMinutes = asyncHandler(async (req, res) => {
  try {
    const { meeting, ai } = await createMom(req.params.id, req.body?.notes);
    res.json({ meeting, ai });
  } catch (e) {
    throw new ApiError(e.message === "Meeting not found" ? 404 : 400, e.message);
  }
});

// PATCH /api/meetings/:id/mom  { summary, discussed, decisions, actionItems, nextMeeting } -> manual edits (e.g. tick an action item)
export const updateMinutes = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findById(req.params.id);
  if (!meeting) throw new ApiError(404, "Meeting not found");
  if (!meeting.mom) throw new ApiError(400, "This meeting has no minutes yet");
  for (const k of ["summary", "discussed", "decisions", "actionItems", "nextMeeting"]) if (k in req.body) meeting.mom[k] = req.body[k];
  meeting.mom.updatedAt = new Date();
  await meeting.save();
  res.json(meeting);
});

// POST /api/meetings/:id/mom/share -> sends the minutes to the client on WhatsApp
export const shareMinutes = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findById(req.params.id);
  if (!meeting?.mom) throw new ApiError(400, "This meeting has no minutes yet");
  const client = await Client.findById(meeting.client);
  const s = await Setting.get();
  const message = await sendToClient(client, { text: momText(meeting, s.whatsapp.businessName), invite: false });
  meeting.mom.sharedAt = new Date();
  await meeting.save();
  res.json({ meeting, message });
});

// POST /api/meetings/detect -> scans all chats again for meeting links
export const detectMeetings = asyncHandler(async (req, res) => {
  const found = await detectAll();
  const completed = await markPastCompleted();
  res.json({ found, completed });
});

// POST /api/meetings/:id/remind  { text }
export const remindMeeting = asyncHandler(async (req, res) => {
  const meeting = await Meeting.findById(req.params.id);
  if (!meeting) throw new ApiError(404, "Meeting not found");
  if (!req.body.text) throw new ApiError(400, "Reminder text is required");
  const client = await Client.findById(meeting.client);
  res.status(201).json(await sendToClient(client, { text: req.body.text, invite: true }));
});
