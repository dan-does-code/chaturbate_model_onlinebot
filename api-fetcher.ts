// api_fetcher.ts
//
// This module is responsible for fetching the online status of a model
// from the unofficial Chaturbate API. It is self-contained and handles
// all network and API-specific error logic.

export async function fetchModelStatus(modelName: string): Promise<"online" | "offline" | "unknown"> {
  const apiUrl = `https://chaturbate.com/api/chatvideocontext/${modelName}/`
  try {
    const res = await fetch(apiUrl, { headers: { "User-Agent": "Deno-StatusBot/1.0" } })
    if (res.status === 404) return "offline" // Model doesn't exist
    if (!res.ok) return "unknown"
    const data = await res.json()
    return data.room_status === "offline" ? "offline" : "online"
  } catch {
    return "unknown"
  }
}
