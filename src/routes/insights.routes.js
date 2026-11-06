import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import ApiError from "../utils/ApiError.js";
import { dashboard, recomputeAll } from "../services/analytics.service.js";
import { aiEnabled, aiStatus, checkOllama, summarizeAll } from "../services/ai.service.js";
import { ask, buildContext } from "../services/ask.service.js";

const router = Router();

// GET /api/insights/dashboard -> business overview (activity, pipeline, money, chats waiting for a reply)
router.get("/dashboard", asyncHandler(async (req, res) => res.json(await dashboard({ weeks: Number(req.query.weeks) || 12 }))));

// POST /api/insights/recompute -> recalculates conversation statistics for every chat
router.post("/recompute", asyncHandler(async (req, res) => res.json({ clients: await recomputeAll() })));

// GET /api/insights/ai -> AI server status (reachable, key accepted, model served, queue progress)
router.get("/ai", asyncHandler(async (req, res) => {
  await checkOllama();
  res.json(aiStatus());
}));

// POST /api/insights/ai/summarize-all { force } -> queue AI summaries for every chat that needs one
router.post(
  "/ai/summarize-all",
  asyncHandler(async (req, res) => {
    const queued = await summarizeAll({ force: !!req.body?.force });
    if (!aiEnabled()) throw new ApiError(400, aiStatus().setupError);
    res.json({ queued, ...aiStatus() });
  })
);

// GET /api/insights/ask/context?q=... -> the exact briefing the AI reads (for transparency / debugging)
router.get("/ask/context", asyncHandler(async (req, res) => res.type("text/plain").send((await buildContext(req.query.q || "")).text)));

// POST /api/insights/ask { question, history } -> streams the answer as plain text
router.post("/ask", async (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ message: "Ask a question" });
  await checkOllama();
  const controller = new AbortController();
  res.on("close", () => controller.abort()); // stop generating if the user leaves
  try {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      // "ai" = answered by the AI server, "quick" = answered straight from the database (AI server off)
      "X-Answer-Mode": aiEnabled() ? "ai" : "quick",
      "Access-Control-Expose-Headers": "X-Answer-Mode",
    });
    await ask({ question, history: req.body?.history || [], onToken: (t) => res.write(t), signal: controller.signal });
    res.end();
  } catch (e) {
    if (controller.signal.aborted) return;
    if (!res.headersSent) return res.status(503).json({ message: e.message });
    res.write(`\n\n[Error: ${e.message}]`);
    res.end();
  }
});

// POST /api/insights/photos/retry -> tries again to download and read photos that failed (asks the phone to re-upload)
router.post("/photos/retry", asyncHandler(async (req, res) => {
  const { queueUnreadPhotos } = await import("../services/payments.service.js");
  res.json({ queued: await queueUnreadPhotos({ retryFailed: true }) });
}));

export default router;
