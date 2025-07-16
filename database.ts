// database.ts
//
// This module manages all interactions with the Deno KV database.
// It provides a clean API for the rest of the application to use
// without needing to know the underlying key structure.

import { sanitizeModelName, sleep } from "./utils.ts"

const kv = await Deno.openKv()

// Simple in-memory cache for model statuses
class ModelStatusCache {
  private cache = new Map<string, { status: ModelStatus; timestamp: number }>()
  private readonly CACHE_TTL_MS = 30 * 1000 // 30 seconds

  get(modelName: string): ModelStatus | null {
    const entry = this.cache.get(modelName)
    if (!entry) return null
    
    const now = Date.now()
    if (now - entry.timestamp > this.CACHE_TTL_MS) {
      this.cache.delete(modelName)
      return null
    }
    
    return entry.status
  }

  set(modelName: string, status: ModelStatus): void {
    this.cache.set(modelName, {
      status: { ...status }, // Deep copy to avoid reference issues
      timestamp: Date.now()
    })
  }

  delete(modelName: string): void {
    this.cache.delete(modelName)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

const statusCache = new ModelStatusCache()

export interface ModelStatus {
  status: "online" | "offline"
  online_since: number | null
  notified_users: number[] // Track who has been notified for this session
  last_notification_time: number | null // For debouncing
}

export interface UserState {
  action: string
  data?: any
  expires: number
}

export async function addUserSubscription(chatId: number, rawName: string): Promise<void> {
  const modelName = sanitizeModelName(rawName)
  if (!modelName) return

  // First, ensure user exists
  await kv.set(["users", chatId], true)

  // Add subscription with atomic operation
  await kv.atomic()
    .set(["subscriptions", chatId, modelName], true)
    .commit()
  
  // Add to model's subscriber array
  await addSubscriberToModel(modelName, chatId)

  // Add to queue atomically with retry logic
  let queueSuccess = false
  let attempts = 0
  const maxAttempts = 5

  while (!queueSuccess && attempts < maxAttempts) {
    const queueKey = ["models_queue"]
    const queueResult = await kv.get<string[]>(queueKey)
    const queue = queueResult.value || []
    
    if (!queue.includes(modelName)) {
      const commitResult = await kv.atomic()
        .check(queueResult)
        .set(queueKey, [...queue, modelName])
        .commit()
      queueSuccess = commitResult.ok
    } else {
      queueSuccess = true // Already in queue
    }
    
    attempts++
    if (!queueSuccess && attempts < maxAttempts) {
      await sleep(Math.random() * 100) // Random delay to reduce contention
    }
  }

  if (!queueSuccess) {
    console.error(`Failed to add ${modelName} to queue after ${maxAttempts} attempts`)
  }
}

export async function removeUserSubscription(chatId: number, rawName: string): Promise<void> {
  const modelName = sanitizeModelName(rawName)
  if (!modelName) return

  // Remove subscription atomically
  await kv.atomic()
    .delete(["subscriptions", chatId, modelName])
    .commit()

  // Remove from model's subscriber array (this handles queue cleanup too)
  await removeSubscriberFromModel(modelName, chatId)
}

export async function getUserSubscriptions(chatId: number): Promise<string[]> {
  const result: string[] = []
  for await (const entry of kv.list<boolean>({ prefix: ["subscriptions", chatId] })) {
    result.push(entry.key[2] as string)
  }
  return result
}

export async function getModelSubscribers(modelName: string): Promise<number[]> {
  const result = await kv.get<number[]>(["model_subscribers", modelName])
  return result.value || []
}

// Internal function to add subscriber to model's array
async function addSubscriberToModel(modelName: string, chatId: number): Promise<void> {
  let success = false
  let attempts = 0
  const maxAttempts = 3

  while (!success && attempts < maxAttempts) {
    const subscribersResult = await kv.get<number[]>(["model_subscribers", modelName])
    const subscribers = subscribersResult.value || []
    
    if (!subscribers.includes(chatId)) {
      const commitResult = await kv.atomic()
        .check(subscribersResult)
        .set(["model_subscribers", modelName], [...subscribers, chatId])
        .commit()
      success = commitResult.ok
    } else {
      success = true // Already subscribed
    }
    
    attempts++
    if (!success && attempts < maxAttempts) {
      await sleep(Math.random() * 50)
    }
  }
}

// Internal function to remove subscriber from model's array
async function removeSubscriberFromModel(modelName: string, chatId: number): Promise<void> {
  let success = false
  let attempts = 0
  const maxAttempts = 3

  while (!success && attempts < maxAttempts) {
    const subscribersResult = await kv.get<number[]>(["model_subscribers", modelName])
    const subscribers = subscribersResult.value || []
    
    if (subscribers.includes(chatId)) {
      const filteredSubscribers = subscribers.filter(id => id !== chatId)
      const commitResult = await kv.atomic()
        .check(subscribersResult)
        .set(["model_subscribers", modelName], filteredSubscribers)
        .commit()
      success = commitResult.ok
      
      // If no more subscribers, remove model from queue
      if (success && filteredSubscribers.length === 0) {
        await removeModelFromQueue(modelName)
      }
    } else {
      success = true // Not subscribed anyway
    }
    
    attempts++
    if (!success && attempts < maxAttempts) {
      await sleep(Math.random() * 50)
    }
  }
}

export async function getStoredModelStatus(modelName: string): Promise<ModelStatus | null> {
  // Check cache first
  const cached = statusCache.get(modelName)
  if (cached) {
    return cached
  }
  
  // Cache miss - fetch from database
  const result = await kv.get<ModelStatus>(["statuses", modelName])
  if (result.value) {
    statusCache.set(modelName, result.value)
  }
  
  return result.value
}

export async function updateModelStatus(modelName: string, status: ModelStatus): Promise<void> {
  await kv.set(["statuses", modelName], status)
  // Update cache
  statusCache.set(modelName, status)
}

export async function getModelQueue(): Promise<string[]> {
  return (await kv.get<string[]>(["models_queue"])).value || []
}

// Remove model from queue and clean up related data
async function removeModelFromQueue(modelName: string): Promise<void> {
  console.log(`🧹 Model ${modelName} has no subscribers, removing from queue`)
  
  let success = false
  let attempts = 0
  const maxAttempts = 3

  while (!success && attempts < maxAttempts) {
    const queueResult = await kv.get<string[]>(["models_queue"])
    const queue = queueResult.value || []
    
    if (queue.includes(modelName)) {
      const filteredQueue = queue.filter(m => m !== modelName)
      const commitResult = await kv.atomic()
        .check(queueResult)
        .set(["models_queue"], filteredQueue)
        .delete(["statuses", modelName])
        .delete(["model_subscribers", modelName])
        .commit()
      success = commitResult.ok
      
      // Clear from cache
      if (success) {
        statusCache.delete(modelName)
      }
    } else {
      success = true // Not in queue anyway
    }
    
    attempts++
    if (!success && attempts < maxAttempts) {
      await sleep(Math.random() * 50)
    }
  }
}

// Store user IDs in an array for efficient broadcast operations
export async function getAllUserIds(): Promise<number[]> {
  const result = await kv.get<number[]>(["user_ids_array"])
  return result.value || []
}

// Internal function to add user to the array
async function addUserToArray(chatId: number): Promise<void> {
  let success = false
  let attempts = 0
  const maxAttempts = 3

  while (!success && attempts < maxAttempts) {
    const userArrayResult = await kv.get<number[]>(["user_ids_array"])
    const userArray = userArrayResult.value || []
    
    if (!userArray.includes(chatId)) {
      const commitResult = await kv.atomic()
        .check(userArrayResult)
        .set(["user_ids_array"], [...userArray, chatId])
        .commit()
      success = commitResult.ok
    } else {
      success = true // Already in array
    }
    
    attempts++
    if (!success && attempts < maxAttempts) {
      await sleep(Math.random() * 50)
    }
  }
}

// Internal function to remove user from the array
async function removeUserFromArray(chatId: number): Promise<void> {
  let success = false
  let attempts = 0
  const maxAttempts = 3

  while (!success && attempts < maxAttempts) {
    const userArrayResult = await kv.get<number[]>(["user_ids_array"])
    const userArray = userArrayResult.value || []
    
    if (userArray.includes(chatId)) {
      const filteredArray = userArray.filter(id => id !== chatId)
      const commitResult = await kv.atomic()
        .check(userArrayResult)
        .set(["user_ids_array"], filteredArray)
        .commit()
      success = commitResult.ok
    } else {
      success = true // Not in array anyway
    }
    
    attempts++
    if (!success && attempts < maxAttempts) {
      await sleep(Math.random() * 50)
    }
  }
}

// Get total user count efficiently
export async function getTotalUserCount(): Promise<number> {
  const userArray = await getAllUserIds()
  return userArray.length
}

// Get cache statistics for monitoring
export function getCacheStats(): { size: number; hitRate?: number } {
  return {
    size: statusCache.size(),
    // Note: We could track hit rate if needed for monitoring
  }
}

export async function addUser(chatId: number): Promise<void> {
  // Check if user already exists to avoid duplicate work
  const userExists = await kv.get(["users", chatId])
  if (userExists.value) return
  
  // Add user to both individual record and array
  await kv.set(["users", chatId], true)
  await addUserToArray(chatId)
}

// Function to remove a user and all their subscriptions (for blocked users)
export async function removeUserAndAllSubscriptions(chatId: number): Promise<void> {
  console.log(`🧹 Cleaning up blocked user ${chatId}`)
  
  // Get all user's subscriptions first
  const userSubscriptions = await getUserSubscriptions(chatId)
  
  // Remove user from all model subscriber lists
  for (const modelName of userSubscriptions) {
    await removeUserSubscription(chatId, modelName)
  }
  
  // Remove user from global users list and array
  await kv.delete(["users", chatId])
  await removeUserFromArray(chatId)
  
  // Clean up any remaining user state
  await clearUserState(chatId)
  
  console.log(`✅ Cleaned up user ${chatId} and ${userSubscriptions.length} subscriptions`)
}

// User state management functions
export async function getUserState(chatId: number): Promise<UserState | null> {
  const result = await kv.get<UserState>(["user_states", chatId])
  if (result.value && result.value.expires < Date.now()) {
    // State expired, clean it up
    await kv.delete(["user_states", chatId])
    return null
  }
  return result.value
}

export async function setUserState(chatId: number, state: UserState | null): Promise<void> {
  const key = ["user_states", chatId]
  if (state === null) {
    await kv.delete(key)
  } else {
    // Add 24 hour expiry to prevent stale states
    state.expires = Date.now() + (24 * 60 * 60 * 1000)
    await kv.set(key, state)
  }
}

export async function clearUserState(chatId: number): Promise<void> {
  await kv.delete(["user_states", chatId])
}

// Function to clean up all expired states (can be called periodically)
export async function cleanupExpiredStates(): Promise<number> {
  let cleanedCount = 0
  const now = Date.now()
  
  for await (const entry of kv.list<UserState>({ prefix: ["user_states"] })) {
    if (entry.value && entry.value.expires < now) {
      await kv.delete(entry.key)
      cleanedCount++
    }
  }
  
  return cleanedCount
}

// Notification deduplication system
export async function isRecentNotification(chatId: number, modelName: string, type: "online" | "offline"): Promise<boolean> {
  const key = ["recent_notifications", chatId, modelName, type]
  const result = await kv.get<number>(key)
  
  if (!result.value) return false
  
  const DEDUP_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
  const timeSinceLastNotification = Date.now() - result.value
  
  return timeSinceLastNotification < DEDUP_WINDOW_MS
}

export async function recordNotification(chatId: number, modelName: string, type: "online" | "offline"): Promise<void> {
  const key = ["recent_notifications", chatId, modelName, type]
  const now = Date.now()
  
  // Store with 10-minute expiry
  await kv.set(key, now, { expireIn: 10 * 60 * 1000 })
}

// Export kv for the cron lock in main.ts
export { kv }
