// main.ts (REVISED - v2)
// This version uses a "lazy" token provider to be more resilient
// in serverless environments like Deno Deploy.

import { Bot, webhookCallback } from "https://deno.land/x/grammy@v1.24.0/mod.ts";
import { registerMessageHandlers } from "./bot_logic.ts";
import * as db from "./database.ts";
import { fetchModelStatus } from "./api_fetcher.ts";
import { sleep, escapeHTML } from "./utils.ts";

// --- LAZY TOKEN PROVIDER ---
// This is the key change. Instead of reading the token immediately,
// we provide a function that reads it when grammy needs it.
// This bypasses startup race conditions.
function getToken(): string {
  const token = Deno.env.get("TELEGRAM_TOKEN");
  if (!token) {
    throw new Error("FATAL: TELEGRAM_TOKEN is not set in environment!");
  }
  return token;
}

const bot = new Bot(getToken);

// --- REGISTER BOT LOGIC & ERROR HANDLER ---
registerMessageHandlers(bot);
bot.catch((err) => console.error("Bot handler error:", err.error));


// --- POLLING CRON JOB ---
// (This section remains unchanged)
Deno.cron("Check Model Statuses", "*/1 * * * *", async () => {
  const lockKey = ["cron_lock"];
  const { ok } = await db.kv.atomic()
    .check({ key: lockKey, versionstamp: null })
    .set(lockKey, "locked", { expireIn: 55_000 })
    .commit();
  if (!ok) return;

  const queue = await db.getModelQueue();
  if (queue.length === 0) return;

  for (const model of queue) {
    const current = await fetchModelStatus(model);
    if (current === "unknown") {
      await sleep(500); continue;
    }

    const prev = (await db.getStoredModelStatus(model))?.status ?? "offline";
    if (current !== prev) {
      console.log(`[STATUS CHANGE] ${model}: ${prev} → ${current}`);
      await db.updateModelStatus(model, current);

      const subscribers = await db.getModelSubscribers(model);
      const safeModelName = escapeHTML(model);
      const msg = current === "online"
        ? `✅ <code>${safeModelName}</code> is now <b>ONLINE</b>!`
        : `❌ <code>${safeModelName}</code> is now <b>OFFLINE</b>.`;

      for (const chatId of subscribers) {
        bot.api.sendMessage(chatId, msg, { parse_mode: "HTML" }).catch(console.error);
      }
    }
    await sleep(500);
  }
});


// --- HTTP SERVER ---
const handleUpdate = webhookCallback(bot, "std/http");

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    // Important: We use the function here as well to check the path.
    if (url.pathname.slice(1) === getToken()) {
      return await handleUpdate(req);
    }
    return new Response("Not Found", { status: 404 });
  } catch (err) {
    console.error("Server error:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
});

console.log("Bot deployed with lazy token loading. All systems should be operational.");