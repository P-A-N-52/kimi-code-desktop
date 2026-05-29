import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

const THINK_BLOCK_REGEX = /<think>[\s\S]*?(?:<\/think>|$)/gi;

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function stripThinkMarkup(value: string | undefined | null): string {
  return String(value ?? "").replace(THINK_BLOCK_REGEX, " ");
}

/**
 * Normalize and shorten a title string.
 * - Replaces multiple whitespace with single space
 * - Trims leading/trailing whitespace
 * - Shortens to maxLength characters with ellipsis
 */
export function shortenTitle(
  title: string | undefined | null,
  maxLength = 50,
): string {
  if (!title) return "";

  // Normalize: collapse whitespace and trim
  const normalized = stripThinkMarkup(title).replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  // Shorten with ellipsis
  return `${normalized.slice(0, maxLength - 1)}…`;
}
