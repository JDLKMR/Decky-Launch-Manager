import { callable } from "@decky/api";
import { setCache } from "./store";
import type {
  DirListing,
  GameKind,
  GameProfile,
  Profile,
  ScriptFile,
  ScriptInfo,
  Settings,
  Source,
  WriteResult,
} from "./types";

/** A backend call that returns the settings; the result is also stored for the launch hook (see store.ts). */
function settingsCall<A extends any[]>(name: string) {
  const fn = callable<A, Settings>(name);
  return async (...args: A): Promise<Settings> => {
    const s = await fn(...args);
    setCache(s);
    return s;
  };
}

export const getSettings = settingsCall<[]>("get_settings");
export const setBrowserDir = settingsCall<[path: string]>("set_browser_dir");
export const setShowGameButton = settingsCall<[value: boolean]>("set_show_game_button");
export const setPromptOptions = settingsCall<[patch: Partial<Pick<Settings, "variable" | "askByDefault" | "backup">>]>(
  "set_prompt_options",
);

export const saveProfile = settingsCall<[profile: Partial<Profile>]>("save_profile");
export const deleteProfile = settingsCall<[profileId: string]>("delete_profile");

export const addDirectory = settingsCall<[path: string]>("add_directory");
export const removeDirectory = settingsCall<[path: string]>("remove_directory");
export const setDirectorySubdirs = settingsCall<[path: string, value: boolean]>("set_directory_subdirs");
export const setExclusions = settingsCall<[exclusions: string[]]>("set_exclusions");

export const listDir = callable<[path: string], DirListing>("list_dir");
export const listScripts = callable<[], ScriptFile[]>("list_scripts");

export const setScriptGame = settingsCall<
  [appid: number, name: string, script: string, kind: GameKind, source: Source]
>("set_script_game");
export const setRomGame = settingsCall<
  [appid: number, name: string, profileId: string, profileName: string, rom: string, source: Source]
>("set_rom_game");
export const removeGame = settingsCall<[appid: number]>("remove_game");
export const applyScan = settingsCall<
  [romAdd: unknown[], romRemove: number[], scriptAdd: unknown[], scriptRemove: number[]]
>("apply_scan");

/** Create or update one game's launch prompt settings (only the fields in `patch` change). */
export const setGameProfile = settingsCall<[appid: number, patch: Partial<GameProfile>]>("set_game_profile");
export const forgetGameProfile = settingsCall<[appid: number]>("forget_game_profile");

/** Find the .sh a game's Target / Launch Options point at and read its PROFILE_NAMES table. */
export const resolveScript = callable<[exe: string, launchOptions: string], ScriptInfo>("resolve_script");
export const writeProfile = callable<[path: string, value: number], WriteResult>("write_profile");
