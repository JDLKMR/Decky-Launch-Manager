import type { GameProfile, ShortcutLink, TableProfile } from "./types";

/** A profile straight from the script's PROFILE_NAMES table. */
export interface ScriptEntry {
  kind: "profile";
  key: string;
  /** The real profile number: what gets written into the script. */
  value: number;
  label: string;
}

/** A shortcut profile: picking it opens another game instead of running the script. */
export interface LinkEntry {
  kind: "link";
  key: string;
  linkId: string;
  targetAppId: number;
  label: string;
}

/**
 * The game itself, opened normally. Offered first (and only) for a game
 * that has shortcut profiles but no script profiles to stand in for it.
 */
export interface DefaultEntry {
  kind: "default";
  key: string;
  label: string;
}

/** One row in the launch prompt. Script profiles and shortcut profiles share one list. */
export type PromptEntry = ScriptEntry | LinkEntry | DefaultEntry;

/** What the Default entry is called until a game gives it its own name. */
export const DEFAULT_LABEL = "Default";

export const hasLinks = (config: Pick<GameProfile, "links"> | undefined): boolean => (config?.links?.length ?? 0) > 0;

export function newLinkId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Alphabetical by (renamed) name, case-insensitive; id only breaks exact ties. */
function compareLinks(a: ShortcutLink, b: ShortcutLink): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const isPinned = (link: ShortcutLink): boolean => Number.isInteger(link.position) && (link.position as number) >= 1;

function linkEntry(link: ShortcutLink): LinkEntry {
  return {
    kind: "link",
    key: `l:${link.id}`,
    linkId: link.id,
    targetAppId: link.targetAppId,
    label: link.name,
  };
}

/**
 * The lowest number a shortcut profile can take. A game with no script
 * profiles has the Default entry pinned at number 1, so they start at 2.
 */
export const minLinkPosition = (profiles: TableProfile[]): number => (profiles.length > 0 ? 1 : 2);

/**
 * Merge a script's profiles with a game's shortcut profiles into the single
 * list the launch prompt shows.
 *
 * - Script profiles keep the order they have in the script's table.
 * - With no script profiles, a Default entry (just launches the game, named
 *   `defaultLabel` if the game has renamed it) takes their place at the top,
 *   and stays there.
 * - Shortcut profiles with no number override go after everything above,
 *   sorted alphabetically by their current name.
 * - One with a number override is inserted so it shows up as that number,
 *   pushing everything below it down one (visually only; script profiles keep
 *   their real PROFILE values). A number past the end just means "as far down
 *   as it can go", and one that would land above Default lands just below it.
 *   If several ask for the same number they take consecutive numbers,
 *   alphabetically.
 */
export function buildPromptEntries(profiles: TableProfile[], links: ShortcutLink[], defaultLabel?: string): PromptEntry[] {
  // Default only exists to give a shortcut-profile-only game something at the top.
  const needsDefault = profiles.length === 0 && links.length > 0;

  const entries: PromptEntry[] = [
    ...(needsDefault
      ? [
          {
            kind: "default",
            key: "d:default",
            label: defaultLabel?.trim() || DEFAULT_LABEL,
          } as DefaultEntry,
        ]
      : []),
    ...profiles.map(
      (p): ScriptEntry => ({
        kind: "profile",
        key: `p:${p.value}`,
        value: p.value,
        label: p.label,
      }),
    ),
    ...links
      .filter((l) => !isPinned(l))
      .sort(compareLinks)
      .map(linkEntry),
  ];

  const pinned = links.filter(isPinned).sort((a, b) => (a.position as number) - (b.position as number) || compareLinks(a, b));

  let floor = needsDefault ? 1 : 0;
  for (const link of pinned) {
    const index = Math.min(Math.max((link.position as number) - 1, floor), entries.length);
    entries.splice(index, 0, linkEntry(link));
    floor = index + 1;
  }

  return entries;
}

/**
 * Which entry to highlight when the prompt opens: whatever was picked last
 * (a shortcut profile or a script profile), falling back to the first entry if
 * that's gone (removed from the table, or the shortcut profile deleted).
 */
export function pickDefaultKey(entries: PromptEntry[], config: GameProfile | undefined): string | null {
  const has = (key: string) => entries.some((e) => e.key === key);

  if (config?.lastLinkId && has(`l:${config.lastLinkId}`)) return `l:${config.lastLinkId}`;
  if (!config?.lastLinkId && config?.lastProfile != null && has(`p:${config.lastProfile}`)) {
    return `p:${config.lastProfile}`;
  }
  return entries[0]?.key ?? null;
}
