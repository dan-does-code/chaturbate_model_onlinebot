// main.ts (FIXED)
// Fixed import paths and database schema issues

import { Bot, webhookCallback } from "https://deno.land/x/grammy@v1.24.0/mod.ts"
import { registerMessageHandlers } from "./bot-logic.ts" // ✅ Fixed path
import * as db from "./database.ts"
import { fetchModelStatus } from "./api-fetcher.ts" // ✅ Fixed path
import { sleep, escapeHTML, formatDuration, isUserBlocked } from "./utils.ts"

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

// --- POLLING CRON JOB WITH RECOVERY ---
Deno.cron("Check Model Statuses", "*/1 * * * *", async () => {
  console.log("🔍 Checking model statuses...")

  const lockKey = ["cron_lock"]
  const startTime = Date.now()
  
  // Try to acquire lock
  const { ok } = await db.kv
    .atomic()
    .check({ key: lockKey, versionstamp: null })
    .set(lockKey, { locked: true, startTime }, { expireIn: 55_000 })
    .commit()
    
  if (!ok) {
    console.log("⏭️ Cron job already running, skipping...")
    return
  }

  let processedCount = 0
  let errorCount = 0
  
  try {
    const queue = await db.getModelQueue()
    console.log(`📋 Checking ${queue.length} models...`)

    if (queue.length === 0) {
      console.log("📋 No models to check")
      return
    }

    for (const model of queue) {
      try {
        const currentStatus = await fetchModelStatus(model)
        if (currentStatus === "unknown") {
          console.warn(`⚠️ Unknown status for ${model}, skipping...`)
          await sleep(500)
          continue
        }

        const storedStatus = await db.getStoredModelStatus(model)
        const prevStatus = storedStatus?.status ?? "offline"

        if (currentStatus !== prevStatus) {
          await processStatusChange(model, currentStatus, prevStatus, storedStatus)
        }
        
        processedCount++
        await sleep(500) // Rate limiting
        
      } catch (error) {
        errorCount++
        console.error(`❌ Error processing ${model}:`, error)
        
        // Continue processing other models even if one fails
        if (errorCount > 5) {
          console.error("🚨 Too many errors, stopping cron job")
          break
        }
      }
    }
    
    console.log(`✅ Cron job completed: ${processedCount} models processed, ${errorCount} errors`)
    
  } catch (error) {
    console.error("🚨 Critical error in cron job:", error)
  } finally {
    // Always release the lock
    try {
      await db.kv.delete(lockKey)
    } catch (error) {
      console.error("Failed to release cron lock:", error)
    }
  }
})

// Helper function to process status changes
async function processStatusChange(
  model: string, 
  currentStatus: string, 
  prevStatus: string, 
  storedStatus: db.ModelStatus | null
) {
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

  // Update status in database
  await db.updateModelStatus(model, newStatusData)

  // Send notifications to all subscribers with cleanup
  console.log(`📢 Notifying ${subscribers.length} subscribers about ${model}`)
  let notificationErrors = 0
  
  for (const chatId of subscribers) {
    try {
      await bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: false,
      })
    } catch (error) {
      notificationErrors++
      console.error(`Failed to notify ${chatId}:`, error)
      
      // Clean up blocked users
      if (isUserBlocked(error)) {
        console.log(`🧹 Removing blocked user ${chatId}`)
        await db.removeUserAndAllSubscriptions(chatId)
      }
      
      // Don't let notification errors stop the entire process
      if (notificationErrors > 10) {
        console.warn(`⚠️ Too many notification errors for ${model}, stopping notifications`)
        break
      }
    }
  }
}

// --- CLEANUP EXPIRED STATES CRON JOB ---
Deno.cron("Cleanup Expired States", "0 */6 * * *", async () => {
  console.log("🧹 Cleaning up expired user states...")
  try {
    const cleanedCount = await db.cleanupExpiredStates()
    console.log(`✅ Cleaned up ${cleanedCount} expired states`)
  } catch (error) {
    console.error("❌ Error cleaning up expired states:", error)
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
