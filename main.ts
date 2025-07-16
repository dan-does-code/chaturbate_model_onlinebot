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

    // Process models in smaller batches to reduce memory usage
    const BATCH_SIZE = 10
    const totalBatches = Math.ceil(queue.length / BATCH_SIZE)
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * BATCH_SIZE
      const batchEnd = Math.min(batchStart + BATCH_SIZE, queue.length)
      const batch = queue.slice(batchStart, batchEnd)
      
      console.log(`📦 Processing batch ${batchIndex + 1}/${totalBatches} (${batch.length} models)`)
      
      // Process batch with some parallelization (but not too much to avoid rate limits)
      const batchPromises = batch.map(async (model, index) => {
        try {
          // Stagger requests to avoid overwhelming the API
          await sleep(index * 100)
          
          const currentStatus = await fetchModelStatus(model)
          if (currentStatus === "unknown") {
            console.warn(`⚠️ Unknown status for ${model}, skipping...`)
            return
          }

          const storedStatus = await db.getStoredModelStatus(model)
          const prevStatus = storedStatus?.status ?? "offline"

          if (currentStatus !== prevStatus) {
            await processStatusChange(model, currentStatus, prevStatus, storedStatus)
          }
          
          processedCount++
          
        } catch (error) {
          errorCount++
          console.error(`❌ Error processing ${model}:`, error)
        }
      })
      
      await Promise.all(batchPromises)
      
      // Break if too many errors
      if (errorCount > 5) {
        console.error("🚨 Too many errors, stopping cron job")
        break
      }
      
      // Short pause between batches
      if (batchIndex < totalBatches - 1) {
        await sleep(1000)
      }
    }
    
    const executionTime = Date.now() - startTime
    const cacheStats = db.getCacheStats()
    
    console.log(`✅ Cron job completed: ${processedCount} models processed, ${errorCount} errors`)
    console.log(`⏱️ Execution time: ${executionTime}ms`)
    console.log(`💾 Cache: ${cacheStats.size} items`)
    
    // Log warning if execution took too long
    if (executionTime > 45000) { // 45 seconds
      console.warn(`⚠️ Cron job execution took ${executionTime}ms - consider optimizing`)
    }
    
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

// Helper function to process status changes with debouncing
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
  const now = Date.now()

  if (currentStatus === "online") {
    // Model came online - use debounce logic
    if (prevStatus === "offline") {
      // First time online - start grace period
      const newStatusData: db.ModelStatus = {
        status: "online",
        online_since: now,
        notified_users: [],
        last_notification_time: null
      }
      await db.updateModelStatus(model, newStatusData)
      console.log(`⏰ ${model} online - starting 2-minute grace period`)
      return
    } else if (prevStatus === "online") {
      // Model has been online - check if grace period has passed
      const GRACE_PERIOD_MS = 2 * 60 * 1000 // 2 minutes
      const timeOnline = now - (storedStatus?.online_since || now)
      
      if (timeOnline < GRACE_PERIOD_MS) {
        // Still in grace period
        return
      }
      
      // Grace period passed - check if we need to notify new subscribers
      const notifiedUsers = storedStatus?.notified_users || []
      const newSubscribers = subscribers.filter(id => !notifiedUsers.includes(id))
      
      if (newSubscribers.length > 0) {
        console.log(`📢 Notifying ${newSubscribers.length} new subscribers for ${model}`)
        
        const message = `✅ <a href="${modelLink}">${safeModelName}</a> is now <b>ONLINE</b>! 🎭`
        await sendNotifications(newSubscribers, message, model, "online")
        
        // Update notification tracking
        const updatedStatus: db.ModelStatus = {
          ...storedStatus,
          notified_users: subscribers, // Mark all current subscribers as notified
          last_notification_time: now
        }
        await db.updateModelStatus(model, updatedStatus)
      }
      return
    }
  } else {
    // Model went offline - always notify immediately
    const newStatusData: db.ModelStatus = {
      status: "offline",
      online_since: null,
      notified_users: [],
      last_notification_time: null
    }

    let durationText = ""
    if (storedStatus?.online_since) {
      const duration = now - storedStatus.online_since
      durationText = ` (Online for ${formatDuration(duration)})`
    }

    const message = `❌ <a href="${modelLink}">${safeModelName}</a> is now <b>OFFLINE</b>.${durationText}`
    
    // Update status first
    await db.updateModelStatus(model, newStatusData)
    
    // Send notifications to all subscribers
    console.log(`📢 Notifying ${subscribers.length} subscribers about ${model} going offline`)
    await sendNotifications(subscribers, message, model, "offline")
  }
}

// Helper function to send notifications with error handling and deduplication
async function sendNotifications(userIds: number[], message: string, modelName: string, notificationType: "online" | "offline") {
  let notificationErrors = 0
  let sentCount = 0
  let skippedCount = 0
  
  for (const chatId of userIds) {
    try {
      // Check for recent notification to prevent spam
      const isRecent = await db.isRecentNotification(chatId, modelName, notificationType)
      if (isRecent) {
        skippedCount++
        continue
      }
      
      await bot.api.sendMessage(chatId, message, {
        parse_mode: "HTML",
        disable_web_page_preview: false,
      })
      
      // Record successful notification
      await db.recordNotification(chatId, modelName, notificationType)
      sentCount++
      
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
        console.warn(`⚠️ Too many notification errors for ${modelName}, stopping notifications`)
        break
      }
    }
  }
  
  if (skippedCount > 0) {
    console.log(`📊 ${modelName}: Sent ${sentCount}, skipped ${skippedCount} (recent notifications)`)
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

// --- MIGRATE DATABASE ON STARTUP ---
console.log("🔄 Running database migration on startup...")
await db.migrateDatabase()

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
