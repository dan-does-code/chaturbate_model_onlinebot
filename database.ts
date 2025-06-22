// database.ts
//
// This module manages all interactions with the Deno KV database.
// It provides a clean API for the rest of the application to use
// without needing to know the underlying key structure.

import { sanitizeModelName } from "./utils.ts"

const kv = await Deno.openKv()

export interface ModelStatus {
  status: "online" | "offline"
  online_since: number | null
}

export async function addUserSubscription(chatId: number, rawName: string): Promise<void> {
  const modelName = sanitizeModelName(rawName)
  if (!modelName) return

  const op = kv
    .atomic()
    .set(["subscriptions", chatId, modelName], true)
    .set(["subscribers", modelName, chatId], true)
    .set(["users", chatId], true) // Track all users for broadcasting

  const queueKey = ["models_queue"]
  const queue = (await kv.get<string[]>(queueKey)).value || []
  if (!queue.includes(modelName)) {
    queue.push(modelName)
    op.set(queueKey, queue)
  }
  await op.commit()
}

export async function removeUserSubscription(chatId: number, rawName: string): Promise<void> {
  const modelName = sanitizeModelName(rawName)
  if (!modelName) return

  await kv.atomic().delete(["subscriptions", chatId, modelName]).delete(["subscribers", modelName, chatId]).commit()

  const others = []
  for await (const entry of kv.list({ prefix: ["subscribers", modelName] })) {
    others.push(entry)
    if (others.length > 0) break
  }

  if (others.length === 0) {
    const queueKey = ["models_queue"]
    const queue = (await kv.get<string[]>(queueKey)).value || []
    await kv.set(
      queueKey,
      queue.filter((m) => m !== modelName),
    )
    await kv.delete(["statuses", modelName])
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

// Export kv for the cron lock in main.ts
export { kv }
