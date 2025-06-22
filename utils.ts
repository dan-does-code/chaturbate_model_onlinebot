// utils.ts
//
// This module contains simple, reusable utility functions that are used
// across the entire application.

/**
 * A promise-based sleep function to pause execution.
 * @param ms The number of milliseconds to wait.
 */
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sanitizes a model name by removing potentially harmful characters and
 * normalizing it to lowercase.
 * @param name The raw input string from the user.
 */
export function sanitizeModelName(name: string): string {
  if (!name) return ""
  return name.replace(/[<>]/g, "").trim().toLowerCase()
}

/**
 * Escapes special HTML characters in a string to prevent parsing errors
 * and injection vulnerabilities when using Telegram's HTML parse_mode.
 * @param str The string to escape.
 */
export function escapeHTML(str: string): string {
  if (!str) return ""
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Formats a duration in milliseconds into a human-readable string.
 * @param ms The duration in milliseconds.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) return "0 minutes"

  const minutes = Math.floor(ms / (1000 * 60))
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    const remainingHours = hours % 24
    return remainingHours > 0 ? `${days}d ${remainingHours}hrs` : `${days}d`
  } else if (hours > 0) {
    const remainingMinutes = minutes % 60
    return remainingMinutes > 0 ? `${hours}hr ${remainingMinutes}m` : `${hours}hr`
  } else {
    return `${minutes} minutes`
  }
}

/**
 * Parses admin IDs from environment variable into array of numbers.
 * @param envVar The comma-separated string of admin IDs.
 */
export function parseAdminIds(envVar: string | undefined): number[] {
  if (!envVar) return []
  return envVar
    .split(",")
    .map((id) => Number.parseInt(id.trim()))
    .filter((id) => !isNaN(id))
}
