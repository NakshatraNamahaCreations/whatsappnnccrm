// npm run ai:test  -> checks the AI server in backend/.env and summarises a sample mixed-language chat.
import "dotenv/config";

const { checkLLM, llmComplete, MODEL, SERVER_LABEL, NUM_CTX } = await import("../src/services/llm.service.js");
const { __test } = await import("../src/services/ai.service.js");

console.log(`AI server: ${SERVER_LABEL || "(LLM_URL not set)"}\nModel:     ${MODEL}\nContext:   ${NUM_CTX} tokens\n`);
const h = await checkLLM();
if (!h.reachable || !h.modelReady) {
  console.log(`NOT READY: ${h.error}`);
  process.exit(1);
}
console.log("Server reachable, key accepted, model is being served.\nSummarising a sample chat...\n");

const chat = [
  "[2026-10-02 11:05] Contact: Hi sir, namaskara. Nimma website portfolio nodide. Namma bakery ge ondu website beku, online order jothe.",
  "[2026-10-02 11:20] Us: Namaskara! Sure, website with online ordering and payment gateway. Starts at Rs. 45,000 + GST, 4 weeks.",
  "[2026-10-03 18:40] Contact: 45k thoda zyada hai sir, 38 mein ho jayega kya? Diwali se pehle chahiye.",
  "[2026-10-04 10:15] Us: We can do Rs. 40,000 + GST if you confirm this week, delivery before 25 Oct.",
  "[2026-10-04 12:02] Contact: Ok done. Advance 50% kal bhej deta hoon.",
  "[2026-10-05 09:30] Contact: Sent 23,600 via UPI. Screenshot attached.",
  "[2026-10-05 09:45] Us: Received with thanks. Design draft by 10 Oct.",
  "[2026-10-21 16:10] Contact: Sir menu photos innu baaki ide, naale kalisthini. Site live yavaga?",
].join("\n");

const started = Date.now();
const out = await llmComplete({
  messages: [
    { role: "system", content: "You turn a WhatsApp chat into a CRM record as JSON. The chat may mix English, Hindi and Kannada; write every field in English. Only use facts from the chat." },
    { role: "user", content: `Our business: a web agency. Today: 2026-10-22.\n\nCHAT:\n${chat}` },
  ],
  schema: __test.SCHEMA,
});
const secs = ((Date.now() - started) / 1000).toFixed(1);
const r = JSON.parse(out);
console.log(`Done in ${secs}s.\n`);
console.log(`Category:   ${r.category}`);
console.log(`Project:    ${r.project.title}`);
console.log(`Stage:      ${r.stage}`);
console.log(`Status:     ${r.projectStatus}`);
console.log(`Started:    ${r.startDate}   Duration: ${r.duration}   Deadline: ${r.deadline}`);
console.log(`Quoted:     Rs. ${r.quoted}   Agreed: Rs. ${r.value}`);
console.log(`Payments:   ${r.payments.map((p) => `${p.date} Rs. ${p.amount} ${p.mode}`).join("; ") || "none"}`);
console.log(`Pending:    ${r.pending.join("; ")}`);
console.log(`Next step:  ${r.next}`);
console.log(`\nSummary:    ${r.summary}`);
console.log("\nExpected roughly: bakery website with online ordering, agreed Rs. 40,000 + GST, 23,600 paid by UPI on 2026-10-05, due before 25 Oct, waiting for menu photos.");
