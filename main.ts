// main.ts (FIXED)
// Fixed import paths and database schema issues

import { Bot, webhookCallback } from "https://deno.land/x/grammy@v1.24.0/mod.ts"
import { registerMessageHandlers } from "./bot-logic.ts" // ✅ Fixed path
import * as db from "./database.ts"
import { fetchModelStatus } from "./api-fetcher.ts" // ✅ Fixed path
import { sleep, escapeHTML, formatDuration } from "./utils.ts"

// --- CONFIGURATION & SETUP ---
const BOT_TOKEN = Deno.env.get("TELEGRAM_TOKEN")
if (!BOT_TOKEN) {
  throw new Error("TELEGRAM_TOKEN environment variable is not set!")
}

console.log("🤖 Initializing bot...")
const bot = new Bot(BOT_TOKEN)

// --- REGISTER BOT LOGIC ---
registerMessageHandlers(bot)
bot.catch((err) => console.error("Bot handler error:", err.error))

// --- POLLING CRON JOB ---
Deno.cron("Check Model Statuses", "*/1 * * * *", async () => {
  console.log("🔍 Checking model statuses...")

  const lockKey = ["cron_lock"]
  const { ok } = await db.kv
    .atomic()
    .check({ key: lockKey, versionstamp: null })
    .set(lockKey, "locked", { expireIn: 55_000 })
    .commit()
  if (!ok) {
    console.log("⏭️ Cron job already running, skipping...")
    return
  }

  const queue = await db.getModelQueue()
  console.log(`📋 Checking ${queue.length} models...`)

  if (queue.length === 0) return

  for (const model of queue) {
    const currentStatus = await fetchModelStatus(model)
    if (currentStatus === "unknown") {
      await sleep(500)
      continue
    }

    const storedStatus = await db.getStoredModelStatus(model)
    const prevStatus = storedStatus?.status ?? "offline"

    if (currentStatus !== prevStatus) {
      console.log(`[STATUS CHANGE] ${model}: ${prevStatus} → ${currentStatus}`)

      const subscribers = await db.getModelSubscribers(model)
      const safeModelName = escapeHTML(model)
      const modelLink = `https://chaturbate.com/${model}/`

      let message: string
      let newStatusData: db.ModelStatus

      if (currentStatus === "online") {
        // Model came online
        newStatusData = {
          status: "online",
          online_since: Date.now(),
        }
        message = `✅ <a href="${modelLink}">${safeModelName}</a> is now <b>ONLINE</b>! 🎭`
      } else {
        // Model went offline
        newStatusData = {
          status: "offline",
          online_since: null,
        }

        let durationText = ""
        if (storedStatus?.online_since) {
          const duration = Date.now() - storedStatus.online_since
          durationText = ` (Online for ${formatDuration(duration)})`
        }

        message = `❌ <a href="${modelLink}">${safeModelName}</a> is now <b>OFFLINE</b>.${durationText}`
      }

      // ✅ Fixed: Pass proper ModelStatus object
      await db.updateModelStatus(model, newStatusData)

      // Send notifications to all subscribers
      console.log(`📢 Notifying ${subscribers.length} subscribers about ${model}`)
      for (const chatId of subscribers) {
        try {
          await bot.api.sendMessage(chatId, message, {
            parse_mode: "HTML",
            disable_web_page_preview: false,
          })
        } catch (error) {
          console.error(`Failed to notify ${chatId}:`, error)
        }
      }
    }
    await sleep(500)
  }
})

// --- START THE BOT WITH LONG POLLING ---
// This command tells the bot to actively fetch updates from Telegram
// instead of waiting for a web server. This bypasses all webhook issues.
bot.start()

// We update the console log to reflect the new running mode.
console.log("🚀 Bot started with Long Polling!")
console.log("📊 All features active:")
console.log("  ✅ Model status monitoring")
console.log("  ✅ User subscriptions")
console.log("  ✅ Interactive button interface")
console.log("  ✅ Deep linking & sharing")
console.log("  ✅ Admin panel & broadcasting")
console.log("  ✅ Session duration tracking")
