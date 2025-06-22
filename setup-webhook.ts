// setup-webhook.ts
// Run this script once to set up your Telegram webhook

const BOT_TOKEN = Deno.env.get("TELEGRAM_TOKEN")
const WEBHOOK_URL = Deno.env.get("WEBHOOK_URL") // e.g., "https://your-app.deno.dev"

if (!BOT_TOKEN || !WEBHOOK_URL) {
  console.error("❌ Missing TELEGRAM_TOKEN or WEBHOOK_URL environment variables")
  Deno.exit(1)
}

const webhookEndpoint = `${WEBHOOK_URL}/${BOT_TOKEN}`

console.log(`🔧 Setting up webhook...`)
console.log(`📡 Webhook URL: ${webhookEndpoint}`)

try {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookEndpoint,
      allowed_updates: ["message", "callback_query"],
    }),
  })

  const result = await response.json()

  if (result.ok) {
    console.log("✅ Webhook set successfully!")
    console.log(`📋 Result:`, result)
  } else {
    console.error("❌ Failed to set webhook:", result)
  }
} catch (error) {
  console.error("❌ Error setting webhook:", error)
}

// Also get webhook info
try {
  const infoResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`)
  const info = await infoResponse.json()
  console.log("📊 Current webhook info:", info.result)
} catch (error) {
  console.error("❌ Error getting webhook info:", error)
}
