// The latest settings the backend returned. The launch hook cannot afford a round
// trip before deciding whether to stop a launch, so it reads this synchronously;
// api.ts keeps it current (every call that returns the settings stores them here).
import type { GameProfile, Settings } from "./types";

let cache: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

export const snapshot = (): Settings | null => cache;

export function setCache(s: Settings) {
  cache = s;
  listeners.forEach((fn) => fn(s));
}

/** Calls `fn` with the current settings (if any) now, and again after every change. Returns the unsubscribe function. */
export function subscribe(fn: (s: Settings) => void): () => void {
  listeners.add(fn);
  if (cache) fn(cache);
  return () => {
    listeners.delete(fn);
  };
}

export const gameProfile = (appid: number | string): GameProfile | undefined => cache?.gameProfiles?.[String(appid)];
