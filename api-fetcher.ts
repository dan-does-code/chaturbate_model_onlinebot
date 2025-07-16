// api-fetcher.ts
//
// This module is responsible for fetching the online status of a model
// from the unofficial Chaturbate API. It now includes rate limiting
// to prevent IP bans and proper error handling.

import { sleep } from "./utils.ts"

// Rate limiter class to prevent API abuse
class APIRateLimiter {
  private lastCall = 0
  private backoffMs = 1000
  private maxBackoff = 30000
  private minBackoff = 1000

  async callWithLimit<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    const timeSinceLastCall = now - this.lastCall
    
    if (timeSinceLastCall < this.backoffMs) {
      await sleep(this.backoffMs - timeSinceLastCall)
    }

    try {
      const result = await fn()
      // Success: gradually reduce backoff
      this.backoffMs = Math.max(this.minBackoff, this.backoffMs * 0.9)
      this.lastCall = Date.now()
      return result
    } catch (error) {
      // Failure: increase backoff exponentially
      this.backoffMs = Math.min(this.maxBackoff, this.backoffMs * 2)
      this.lastCall = Date.now()
      throw error
    }
  }
}

// Global rate limiter instance
const rateLimiter = new APIRateLimiter()

export async function fetchModelStatus(modelName: string): Promise<"online" | "offline" | "unknown"> {
  const apiUrl = `https://chaturbate.com/api/chatvideocontext/${modelName}/`
  
  try {
    const result = await rateLimiter.callWithLimit(async () => {
      const res = await fetch(apiUrl, { 
        headers: { "User-Agent": "Deno-StatusBot/2.0" },
        signal: AbortSignal.timeout(10000) // 10 second timeout
      })
      
      if (res.status === 404) return "offline" // Model doesn't exist
      if (res.status === 429) {
        // Rate limited, throw error to trigger backoff
        throw new Error(`Rate limited for ${modelName}`)
      }
      if (!res.ok) {
        console.warn(`API error for ${modelName}: ${res.status} ${res.statusText}`)
        return "unknown"
      }
      
      const data = await res.json()
      return data.room_status === "offline" ? "offline" : "online"
    })
    
    return result
  } catch (error) {
    console.error(`Failed to fetch status for ${modelName}:`, error.message)
    return "unknown"
  }
}
