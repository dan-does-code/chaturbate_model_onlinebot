// bot-logic.ts
//
// This module contains all the logic for handling user commands from Telegram.
// It uses the database module to manage subscriptions and keeps the main
// server file clean.

import { type Bot, InlineKeyboard, Keyboard } from "https://deno.land/x/grammy@v1.24.0/mod.ts"
import * as db from "./database.ts"
import { escapeHTML, sanitizeModelName, parseAdminIds } from "./utils.ts"

const BOT_USERNAME = Deno.env.get("BOT_USERNAME") || "your_bot"
const ADMIN_IDS = parseAdminIds(Deno.env.get("ADMIN_IDS"))

console.log(`🔧 Bot configuration:`)
console.log(`   Username: ${BOT_USERNAME}`)
console.log(`   Admin IDs: ${ADMIN_IDS.join(", ") || "None"}`)

// Create main keyboard for regular users
const mainKeyboard = new Keyboard().text("➕ Add Model").text("➖ Remove Model").row().text("📋 My List").resized()

// Create admin keyboard
const adminKeyboard = new Keyboard()
  .text("➕ Add Model")
  .text("➖ Remove Model")
  .row()
  .text("📋 My List")
  .text("👑 Admin Panel")
  .resized()

// Admin panel keyboard
const adminPanelKeyboard = new Keyboard().text("📢 Broadcast").text("📊 Stats").row().text("🔙 Back to Main").resized()

// User state management for conversations
const userStates = new Map<number, { action: string; data?: any }>()

function isAdmin(userId: number): boolean {
  return ADMIN_IDS.includes(userId)
}

export function registerMessageHandlers(bot: Bot) {
  console.log("🔧 Registering message handlers...")

  // Handle /start command with deep linking
  bot.command("start", async (ctx) => {
    console.log(`📥 /start command from user ${ctx.from.id}`)

    try {
      await db.addUser(ctx.from.id)
      console.log(`✅ User ${ctx.from.id} added to database`)

      const payload = ctx.match
      if (payload) {
        console.log(`🔗 Deep link payload: ${payload}`)
        // Deep link subscription
        const modelName = sanitizeModelName(payload)
        if (modelName) {
          await db.addUserSubscription(ctx.from.id, modelName)
          await ctx.reply(
            `✅ Welcome! You've been automatically subscribed to <code>${escapeHTML(modelName)}</code>.\n\nYou'll receive notifications when they come online!`,
            {
              parse_mode: "HTML",
              reply_markup: isAdmin(ctx.from.id) ? adminKeyboard : mainKeyboard,
            },
          )
          console.log(`✅ Auto-subscribed user ${ctx.from.id} to ${modelName}`)
          return
        }
      }

      // Regular start message
      await ctx.reply(
        [
          "🎭 Welcome to the Chaturbate Status Bot!",
          "",
          "I'll notify you when your favorite models come online.",
          "",
          "Use the buttons below to manage your subscriptions:",
        ].join("\n"),
        {
          reply_markup: isAdmin(ctx.from.id) ? adminKeyboard : mainKeyboard,
        },
      )
      console.log(`✅ Sent welcome message to user ${ctx.from.id}`)
    } catch (error) {
      console.error(`❌ Error in /start handler:`, error)
      await ctx.reply("❌ An error occurred. Please try again.")
    }
  })

  // Handle /admin command
  bot.command("admin", async (ctx) => {
    console.log(`📥 /admin command from user ${ctx.from.id}`)

    if (!isAdmin(ctx.from.id)) {
      console.log(`❌ User ${ctx.from.id} is not an admin`)
      return // Silently ignore for non-admins
    }

    await ctx.reply("👑 Admin Panel\n\nChoose an action:", { reply_markup: adminPanelKeyboard })
    console.log(`✅ Sent admin panel to user ${ctx.from.id}`)
  })

  // Add a test command for debugging
  bot.command("test", async (ctx) => {
    console.log(`📥 /test command from user ${ctx.from.id}`)
    await ctx.reply("🧪 Test successful! Bot is responding to commands.")
  })

  // Handle button presses
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text
    const userId = ctx.from.id

    console.log(`📥 Text message from user ${userId}: "${text}"`)

    // Skip if it's a command (already handled above)
    if (text.startsWith("/")) {
      console.log(`⏭️ Skipping command: ${text}`)
      return
    }

    const userState = userStates.get(userId)

    // Handle user states (conversations)
    if (userState) {
      console.log(`🔄 User ${userId} in state: ${userState.action}`)

      switch (userState.action) {
        case "waiting_for_model_to_add":
          const modelToAdd = sanitizeModelName(text)
          if (!modelToAdd) {
            await ctx.reply("❌ Invalid model name. Please try again or use the menu.")
            userStates.delete(userId)
            return
          }
          await db.addUserSubscription(userId, modelToAdd)
          await ctx.reply(`✅ Subscribed! You'll receive notifications for <code>${escapeHTML(modelToAdd)}</code>.`, {
            parse_mode: "HTML",
          })
          userStates.delete(userId)
          console.log(`✅ User ${userId} subscribed to ${modelToAdd}`)
          break

        case "waiting_for_model_to_remove":
          const modelToRemove = sanitizeModelName(text)
          if (!modelToRemove) {
            await ctx.reply("❌ Invalid model name. Please try again or use the menu.")
            userStates.delete(userId)
            return
          }
          await db.removeUserSubscription(userId, modelToRemove)
          await ctx.reply(`🗑️ Unsubscribed from <code>${escapeHTML(modelToRemove)}</code>.`, { parse_mode: "HTML" })
          userStates.delete(userId)
          console.log(`✅ User ${userId} unsubscribed from ${modelToRemove}`)
          break

        case "waiting_for_broadcast_message":
          if (!isAdmin(userId)) {
            userStates.delete(userId)
            return
          }
          // Store the message for confirmation
          userStates.set(userId, { action: "confirming_broadcast", data: ctx.message })

          // Create confirmation keyboard
          const confirmKeyboard = new InlineKeyboard()
            .text("✅ Confirm Broadcast", "confirm_broadcast")
            .text("❌ Cancel", "cancel_broadcast")

          await ctx.reply(
            "📢 Preview of your broadcast message:\n\n👆 This is exactly what users will receive.\n\nConfirm to send to all users:",
            { reply_markup: confirmKeyboard },
          )
          break
      }
      return
    }

    // Handle button text
    console.log(`🔘 Processing button: "${text}"`)

    try {
      switch (text) {
        case "➕ Add Model":
          console.log(`➕ Add Model button pressed by user ${userId}`)
          userStates.set(userId, { action: "waiting_for_model_to_add" })
          await ctx.reply("Please send me the username of the model you want to track:")
          break

        case "➖ Remove Model":
          console.log(`➖ Remove Model button pressed by user ${userId}`)
          userStates.set(userId, { action: "waiting_for_model_to_remove" })
          await ctx.reply("Please send me the username of the model you want to stop tracking:")
          break

        case "📋 My List":
          console.log(`📋 My List button pressed by user ${userId}`)
          const subs = await db.getUserSubscriptions(userId)
          console.log(`📋 User ${userId} has ${subs.length} subscriptions`)

          if (subs.length === 0) {
            await ctx.reply("You are not subscribed to any models yet.\n\nUse ➕ Add Model to get started!")
            return
          }

          let listText = "<b>Your subscriptions:</b>\n\n"
          const keyboard = new InlineKeyboard()

          for (const model of subs) {
            listText += `• <code>${escapeHTML(model)}</code>\n`
            keyboard.text(`Share ${model}`, `share_${model}`).row()
          }

          await ctx.reply(listText, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          })
          break

        case "👑 Admin Panel":
          if (!isAdmin(userId)) {
            console.log(`❌ Non-admin ${userId} tried to access admin panel`)
            return
          }
          await ctx.reply("👑 Admin Panel\n\nChoose an action:", { reply_markup: adminPanelKeyboard })
          break

        case "📢 Broadcast":
          if (!isAdmin(userId)) return
          userStates.set(userId, { action: "waiting_for_broadcast_message" })
          await ctx.reply(
            "📢 Broadcast Message\n\nSend me the message you want to broadcast to all users.\n\nYou can include text, photos, and formatting.",
          )
          break

        case "📊 Stats":
          if (!isAdmin(userId)) return
          const totalUsers = (await db.getAllUserIds()).length
          const totalModels = (await db.getModelQueue()).length
          await ctx.reply(`📊 Bot Statistics\n\n👥 Total Users: ${totalUsers}\n🎭 Tracked Models: ${totalModels}`)
          break

        case "🔙 Back to Main":
          await ctx.reply("🎭 Main Menu", { reply_markup: isAdmin(userId) ? adminKeyboard : mainKeyboard })
          break

        default:
          console.log(`❓ Unknown button text: "${text}"`)
          // Don't respond to unknown text to avoid spam
          break
      }
    } catch (error) {
      console.error(`❌ Error handling button "${text}":`, error)
      await ctx.reply("❌ An error occurred. Please try again.")
    }
  })

  // Handle inline button callbacks
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data
    const userId = ctx.from.id

    console.log(`📥 Callback query from user ${userId}: ${data}`)

    try {
      if (data.startsWith("share_")) {
        const modelName = data.replace("share_", "")
        const shareLink = `https://t.me/${BOT_USERNAME}?start=${modelName}`
        await ctx.answerCallbackQuery()
        await ctx.reply(
          `🔗 Share link for <code>${escapeHTML(modelName)}</code>:\n\n<code>${shareLink}</code>\n\nAnyone who clicks this link will be automatically subscribed to ${escapeHTML(modelName)}!`,
          { parse_mode: "HTML" },
        )
      } else if (data === "confirm_broadcast") {
        if (!isAdmin(userId)) {
          await ctx.answerCallbackQuery("❌ Access denied")
          return
        }

        const userState = userStates.get(userId)
        if (userState?.action === "confirming_broadcast" && userState.data) {
          await ctx.answerCallbackQuery("✅ Broadcasting...")
          await ctx.editMessageText("📢 Broadcasting message to all users...")

          const allUsers = await db.getAllUserIds()
          let successCount = 0

          for (const chatId of allUsers) {
            try {
              await ctx.api.copyMessage(chatId, userState.data.chat.id, userState.data.message_id)
              successCount++
              await new Promise((resolve) => setTimeout(resolve, 100)) // Rate limiting
            } catch (error) {
              console.error(`Failed to send to ${chatId}:`, error)
            }
          }

          await ctx.editMessageText(`✅ Broadcast completed!\n\nSent to ${successCount}/${allUsers.length} users.`)
          userStates.delete(userId)
        }
      } else if (data === "cancel_broadcast") {
        if (!isAdmin(userId)) {
          await ctx.answerCallbackQuery("❌ Access denied")
          return
        }

        await ctx.answerCallbackQuery("❌ Cancelled")
        await ctx.editMessageText("❌ Broadcast cancelled.")
        userStates.delete(userId)
      }
    } catch (error) {
      console.error(`❌ Error handling callback query:`, error)
      await ctx.answerCallbackQuery("❌ An error occurred")
    }
  })

  console.log("✅ Message handlers registered successfully")
}
