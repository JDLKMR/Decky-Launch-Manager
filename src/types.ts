export type GameKind = "steam" | "shortcut";
export type Source = "added" | "scan";

export interface Profile {
  id: string;
  name: string;
  /** Lower-case, leading dot, e.g. [".gb", ".gbc"]. Empty = always ask which profile. */
  fileTypes: string[];
  target: string;
  launchOptions: string;
}

export interface ScriptGame {
  appid: number;
  name: string;
  script: string;
  kind: GameKind;
  source: Source;
}

export interface RomGame {
  appid: number;
  name: string;
  profileId: string;
  /** Name when last seen; the live profile name is used while the profile exists. */
  profileName: string;
  rom: string;
  source: Source;
}

export interface ScriptDir {
  path: string;
  subdirs: boolean;
}

/**
 * A shortcut profile: an entry in a game's launch prompt that opens another
 * Steam or non-Steam game instead of running this game's script.
 */
export interface ShortcutLink {
  /** Stable identifier, so renaming or reordering never loses track of it. */
  id: string;
  /** AppID of the game this entry opens. */
  targetAppId: number;
  /** Name shown in the launch prompt: chosen when added, renameable later. */
  name: string;
  /** Optional 1-based number this entry takes in the launch prompt. Missing = after every script profile. */
  position?: number;
}

/** Per-game launch prompt settings. Kept apart from the games lists, so a game keeps them whichever list it is in. */
export interface GameProfile {
  name: string;
  /** Prompt for a profile when this game launches. */
  enabled: boolean;
  lastProfile: number;
  /** Set when the last thing picked was a shortcut profile rather than a script profile. */
  lastLinkId: string | null;
  links: ShortcutLink[];
  /** This game's own name for the Default entry (empty = "Default"). */
  defaultName: string;
}

export interface Settings {
  browserDir: string;
  showGameButton: boolean;
  /** Always alphabetical by name (the backend sorts them). */
  profiles: Profile[];
  romGames: RomGame[];
  scriptDirs: ScriptDir[];
  exclusions: string[];
  scriptGames: ScriptGame[];
  /** Name of the shell variable that gets rewritten inside a script (or passed through launch options). */
  variable: string;
  /** Whether a newly detected game prompts by default. */
  askByDefault: boolean;
  /** Keep a one-time .bak of each script the first time the plugin edits it. */
  backup: boolean;
  /** appid (as string) -> that game's launch prompt settings. */
  gameProfiles: Record<string, GameProfile>;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
  files: string[];
}

export interface ScriptFile {
  name: string;
  path: string;
  rel: string;
  dir: string;
}

export interface Game {
  appid: number;
  name: string;
  kind: GameKind;
}

/** One entry from a script's own PROFILE_NAMES table. */
export interface TableProfile {
  /** The real profile number: what gets written into the script. */
  value: number;
  label: string;
}

export interface ScriptInfo {
  path: string;
  exists: boolean;
  hasVariable: boolean;
  value: string | null;
  /** True when the script's variable line reads from the environment, so a profile can go through the launch options. */
  envAware?: boolean;
  /** True when a .sh was found but every candidate matched an exclusion. */
  excluded?: boolean;
  error?: string;
  /** Parsed fresh from the script's `declare -A PROFILE_NAMES=(...)` table, in file order. */
  profiles: TableProfile[];
}

export interface WriteResult {
  ok: boolean;
  value?: string;
  unchanged?: boolean;
  error?: string;
}
