// database.ts
//
// This module manages all interactions with the Deno KV database.
// It provides a clean API for the rest of the application to use
// without needing to know the underlying key structure.

import { sanitizeModelName, sleep } from "./utils.ts"

const kv = await Deno.openKv()

export interface ModelStatus {
  status: "online" | "offline"
  online_since: number | null
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
    .set(["subscribers", modelName, chatId], true)
    .commit()

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
    .delete(["subscribers", modelName, chatId])
    .commit()

  // Check if model has other subscribers with atomic cleanup
  let cleanupSuccess = false
  let attempts = 0
  const maxAttempts = 5

  while (!cleanupSuccess && attempts < maxAttempts) {
    // Check if any other subscribers exist
    const subscribers = []
    for await (const entry of kv.list({ prefix: ["subscribers", modelName] })) {
      subscribers.push(entry)
      if (subscribers.length > 0) break // Early exit if we find any
    }

    if (subscribers.length === 0) {
      // No other subscribers, remove from queue atomically
      const queueKey = ["models_queue"]
      const queueResult = await kv.get<string[]>(queueKey)
      const queue = queueResult.value || []
      
      const commitResult = await kv.atomic()
        .check(queueResult)
        .set(queueKey, queue.filter((m) => m !== modelName))
        .delete(["statuses", modelName])
        .commit()
      
      cleanupSuccess = commitResult.ok
    } else {
      cleanupSuccess = true // Other subscribers exist, no cleanup needed
    }
    
    attempts++
    if (!cleanupSuccess && attempts < maxAttempts) {
      await sleep(Math.random() * 100)
    }
  }

  if (!cleanupSuccess) {
    console.error(`Failed to cleanup ${modelName} after ${maxAttempts} attempts`)
  }
}

export async function getUserSubscriptions(chatId: number): Promise<string[]> {
  const result: string[] = []
  for await (const entry of kv.list<boolean>({ prefix: ["subscriptions", chatId] })) {
    result.push(entry.key[2] as string)
  }
  return result
}

export async function getModelSubscribers(modelName: string): Promise<number[]> {
  const result: number[] = []
  for await (const entry of kv.list<boolean>({ prefix: ["subscribers", modelName] })) {
    result.push(entry.key[2] as number)
  }
  return result
}

export async function getStoredModelStatus(modelName: string): Promise<ModelStatus | null> {
  const result = await kv.get<ModelStatus>(["statuses", modelName])
  return result.value
}

export async function updateModelStatus(modelName: string, status: ModelStatus): Promise<void> {
  await kv.set(["statuses", modelName], status)
}

export async function getModelQueue(): Promise<string[]> {
  return (await kv.get<string[]>(["models_queue"])).value || []
}

export async function getAllUserIds(): Promise<number[]> {
  const result: number[] = []
  for await (const entry of kv.list<boolean>({ prefix: ["users"] })) {
    result.push(entry.key[1] as number)
  }
  return result
}

export async function addUser(chatId: number): Promise<void> {
  await kv.set(["users", chatId], true)
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
  
  // Remove user from global users list
  await kv.delete(["users", chatId])
  
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

// Export kv for the cron lock in main.ts
export { kv }
