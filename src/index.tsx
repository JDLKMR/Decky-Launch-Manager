import { definePlugin, routerHook } from "@decky/api";
import { useEffect, useRef, useState } from "react";
import { FaChevronDown, FaChevronRight, FaEdit, FaEye, FaEyeSlash, FaTerminal, FaTrash, FaUserCog } from "react-icons/fa";
import {
  addDirectory,
  applyScan,
  getSettings,
  removeDirectory,
  setBrowserDir,
  setDirectorySubdirs,
  setPromptOptions,
  setRomCollections,
  setSgdbArt,
  setSgdbKey,
  setShowGameButton,
} from "./api";
import { confirmClear, confirmRemoveProfiles, startNewRomFlow, startRomFlow, startScriptFlow } from "./flow";
import { setGameButtonEnabled, GameButtonHost } from "./GameButton";
import { GameSettingsModal } from "./GameSettingsModal";
import { registerLaunchInterceptor } from "./interceptor";
import {
  AddRomModal,
  DirectoryBrowserModal,
  ExclusionsModal,
  GamePickerModal,
  NewGameModal,
  ProfileEditorModal,
  subStyle,
} from "./modals";
import {
  type ListKind,
  onGameSettingsClosed,
  pendingReturnTarget,
  rememberGameSettingsOpened,
} from "./panelMemory";
import { describeFileTypes, groupLabels } from "./profiles";
import { scanLibrary } from "./scan";
import { basename, getGameByAppId, getInstalledGames, liveName } from "./steam";
import { subscribe } from "./store";
import { toast } from "./toast";
import type { Game, GameKind, Profile, Settings } from "./types";
import {
  ButtonItem,
  DialogButton,
  Focusable,
  PanelSection,
  PanelSectionRow,
  TextField,
  ToggleField,
  showModal,
  staticClasses,
} from "./ui";

const GLOBAL_NAME = "LaunchManagerGameButton";

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const };

// The row buttons are square so three of them fit beside a game's name in the narrow menu.
const rowButton = {
  width: "32px",
  height: "32px",
  minWidth: 0,
  padding: 0,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

function Chevron({ open, children }: { open: boolean; children: any }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      {open ? <FaChevronDown /> : <FaChevronRight />}
      <span>{children}</span>
    </div>
  );
}

/** One game in a games list. */
interface Row {
  appid: number;
  name: string;
  /** The second line: the ROM / script file, and/or how many shortcut profiles it has. */
  sub: string;
  kind: GameKind;
  list: ListKind;
  /** ROM games: the ROM profile group it sits under. */
  group?: string;
  /** In the script list only because it has shortcut profiles (no script of its own). */
  linkOnly?: boolean;
}

/**
 * One game in a games list: its name, a second line, and three square buttons:
 * Game Settings (the launch prompt), Change (pick another ROM / script) and Remove.
 */
function GameRow({
  row,
  settingsRef,
  onSettings,
  onChange,
  onRemove,
}: {
  row: Row;
  settingsRef: (el: HTMLDivElement | null) => void;
  onSettings: () => void;
  onChange: () => void;
  onRemove: () => void;
}) {
  return (
    <PanelSectionRow>
      <Focusable
        style={{ display: "flex", alignItems: "center", gap: "6px", width: "100%" }}
        // @ts-ignore
        flow-children="row"
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={ellipsis}>{row.name}</div>
          <div style={{ ...subStyle, ...ellipsis, wordBreak: undefined }}>{row.sub}</div>
        </div>
        <div ref={settingsRef} style={{ display: "contents" }}>
          <DialogButton style={rowButton} onClick={onSettings}>
            <FaUserCog size={14} />
          </DialogButton>
        </div>
        <DialogButton style={rowButton} onClick={onChange}>
          <FaEdit size={14} />
        </DialogButton>
        <DialogButton style={rowButton} onClick={onRemove}>
          <FaTrash size={13} />
        </DialogButton>
      </Focusable>
    </PanelSectionRow>
  );
}

function Content() {
  const [s, setS] = useState<Settings | null>(null);
  // Coming back from a game's settings, the list that row was in starts open.
  const [romOpen, setRomOpen] = useState(() => pendingReturnTarget()?.list === "rom");
  const [scriptOpen, setScriptOpen] = useState(() => pendingReturnTarget()?.list === "script");
  const [profilesOpen, setProfilesOpen] = useState(false);
  // ROM profile groups under "ROM Games" that are expanded (all start collapsed).
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const t = pendingReturnTarget();
    return new Set(t?.list === "rom" && t.group ? [t.group] : []);
  });
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState("");
  const [restoreFocusId, setRestoreFocusId] = useState<number | null>(null);
  const settingsButtons = useRef(new Map<number, HTMLDivElement>());
  // What's typed in the script variable box (null = show the saved value).
  const [varText, setVarText] = useState<string | null>(null);
  // Same for the SteamGridDB API key, which is hidden unless the eye button is pressed (and always starts hidden).
  const [keyText, setKeyText] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const keyBox = useRef<HTMLDivElement>(null);
  const eyeBox = useRef<HTMLDivElement>(null);
  const keySeparator = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getSettings().then(setS);
    // Anything else that changes the settings (a launch prompt, the game page button) refreshes the lists too.
    return subscribe(setS);
  }, []);

  // Coming back from a game's settings: reopen the list and refocus that row.
  // Steam rebuilds this panel when the modal closes, so this handles a panel that
  // was rebuilt in the meantime (checked on mount) and one that stayed mounted
  // (told when the modal closes).
  useEffect(() => {
    const restore = () => {
      const t = pendingReturnTarget();
      if (!t) return;
      if (t.list === "rom") {
        setRomOpen(true);
        const group = t.group;
        if (group) setOpenGroups((prev) => new Set(prev).add(group));
      } else {
        setScriptOpen(true);
      }
      setRestoreFocusId(t.appid);
    };
    restore();
    return onGameSettingsClosed(restore);
  }, []);

  // The API key row. Runs after every render, because Steam can rebuild the field at any time.
  useEffect(() => {
    const input = keyBox.current?.querySelector("input");
    // Steam's text field takes no password option here, so the characters are hidden on the input itself.
    input?.style.setProperty("-webkit-text-security", showKey ? "none" : "disc");

    // Line the eye button up with the input box itself (the field's label and description sit above it,
    // so centring on the whole block would put the button too low).
    const align = () => {
      const eye = eyeBox.current;
      if (!input || !eye) return;
      const inputRect = input.getBoundingClientRect();
      const eyeRect = eye.getBoundingClientRect();
      if (!inputRect.height || !eyeRect.height) return;
      const current = parseFloat(eye.style.marginTop || "0") || 0;
      const delta = inputRect.top + inputRect.height / 2 - (eyeRect.top + eyeRect.height / 2);
      eye.style.marginTop = `${Math.max(0, current + delta)}px`;
    };
    align();
    const later = setTimeout(align, 100); // once more after Steam has finished laying the field out

    // The divider under the row: the same shade as Steam's own, when that can be read.
    try {
      const line = keySeparator.current;
      const doc = keyBox.current?.ownerDocument;
      const native = doc?.querySelector('[class*="WithBottomSeparatorStandard"]');
      const shade = native ? getComputedStyle(native, "::after").backgroundColor : "";
      if (line && shade && shade !== "rgba(0, 0, 0, 0)" && shade !== "transparent") line.style.backgroundColor = shade;
    } catch {
      /* the default shade stays */
    }

    return () => clearTimeout(later);
  });

  useEffect(() => {
    if (restoreFocusId === null) return;
    const focusRow = () => {
      const row = settingsButtons.current.get(restoreFocusId);
      const target =
        row?.querySelector<HTMLElement>("button") ??
        row?.querySelector<HTMLElement>("[role='button']") ??
        row?.querySelector<HTMLElement>("[tabindex]");
      if (!target) return;
      target.focus();
      target.scrollIntoView?.({ block: "center" });
    };
    // Steam sets its own initial focus as the panel appears; go after it, and
    // once more in case it was late.
    const timers = [
      setTimeout(focusRow, 150),
      setTimeout(focusRow, 600),
      setTimeout(() => setRestoreFocusId(null), 800),
    ];
    return () => timers.forEach(clearTimeout);
  }, [restoreFocusId, romOpen, scriptOpen]);

  if (!s) return <PanelSection>Loading…</PanelSection>;

  const nameOf = (a: { appid: number; name: string }) => liveName(a.appid) ?? a.name;
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

  const linkCount = (appid: number) => s.gameProfiles[String(appid)]?.links?.length ?? 0;
  const describe = (base: string, appid: number) => {
    const n = linkCount(appid);
    if (!n) return base;
    const links = `${n} shortcut profile${n === 1 ? "" : "s"}`;
    return base ? `${base} · ${links}` : links;
  };

  // ROM games grouped under their ROM profile's name; profiles the scan can't tell apart share one group.
  const profileGroups = groupLabels(s.profiles);
  const groups = new Map<string, Row[]>();
  for (const g of s.romGames) {
    const key = profileGroups.get(g.profileId) ?? (g.profileName || "Unknown profile");
    const row: Row = {
      appid: g.appid,
      name: nameOf(g),
      sub: describe(basename(g.rom), g.appid),
      kind: "shortcut",
      list: "rom",
      group: key,
    };
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const groupNames = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));

  // Script games, plus games that are only here for their shortcut profiles.
  const listed = new Set<number>([...s.romGames.map((g) => g.appid), ...s.scriptGames.map((g) => g.appid)]);
  const scriptRows: Row[] = s.scriptGames.map((a) => ({
    appid: a.appid,
    name: nameOf(a),
    sub: describe(basename(a.script), a.appid),
    kind: a.kind,
    list: "script",
  }));
  for (const [key, cfg] of Object.entries(s.gameProfiles)) {
    const appid = Number(key);
    if (listed.has(appid) || !cfg.links?.length) continue;
    scriptRows.push({
      appid,
      name: liveName(appid) ?? (cfg.name || `App ${appid}`),
      sub: describe("", appid),
      kind: getGameByAppId(appid)?.kind ?? "steam",
      list: "script",
      linkOnly: true,
    });
  }
  scriptRows.sort(byName);

  const toggleGroup = (group: string) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(group)) next.add(group);
      return next;
    });

  /* ---- Row buttons ----------------------------------------------------- */
  const gameOf = (row: Row): Game => ({ appid: row.appid, name: row.name, kind: row.kind });

  const openGameSettings = (row: Row) => {
    rememberGameSettingsOpened({ appid: row.appid, list: row.list, group: row.group });
    showModal(<GameSettingsModal appId={String(row.appid)} fallbackName={row.name} />, window);
  };

  // Change: pick another ROM (ROM games) or script (script games).
  const changeGame = (row: Row) => (row.list === "rom" ? startRomFlow(gameOf(row), setS) : startScriptFlow(gameOf(row), setS));

  const removeGame = (row: Row) =>
    row.linkOnly ? confirmRemoveProfiles(gameOf(row), setS) : confirmClear(gameOf(row), setS);

  const renderRow = (row: Row) => (
    <GameRow
      key={row.appid}
      row={row}
      settingsRef={(el) => {
        if (el) settingsButtons.current.set(row.appid, el);
        else settingsButtons.current.delete(row.appid);
      }}
      onSettings={() => openGameSettings(row)}
      onChange={() => changeGame(row)}
      onRemove={() => removeGame(row)}
    />
  );

  /* ---- Add ROM: a new Steam game, or an existing non-Steam one --------- */
  // ROM profiles write a shortcut's Target / Start In / Launch Options, so only
  // non-Steam games can take one (the game page's action menu applies the same rule).
  const startNewRom = () => showModal(<NewGameModal onSubmit={(name, sgdb) => startNewRomFlow(name, setS, sgdb)} />, window);

  const startExistingRom = () => {
    const games = getInstalledGames().filter((g) => g.kind === "shortcut");
    if (games.length === 0) {
      toast("No non-Steam games found.");
      return;
    }
    const currentRoms: Record<number, string> = {};
    for (const a of s.romGames) currentRoms[a.appid] = basename(a.rom);
    showModal(
      <GamePickerModal kind="rom" games={games} current={currentRoms} onPick={(game) => startRomFlow(game, setS)} />,
      window,
    );
  };

  const startAddRom = () => {
    if (s.profiles.length === 0) {
      toast("Add a ROM profile first (ROM profiles, below).");
      return;
    }
    showModal(<AddRomModal onNew={startNewRom} onExisting={startExistingRom} />, window);
  };

  /* ---- Add Script (any game) ------------------------------------------ */
  const startAddScript = () => {
    if (s.scriptDirs.length === 0) {
      toast("Add a scripts directory first (Script directories, below).");
      return;
    }
    const games = getInstalledGames();
    if (games.length === 0) {
      toast("No installed games found.");
      return;
    }
    const currentScripts: Record<number, string> = {};
    for (const a of s.scriptGames) currentScripts[a.appid] = basename(a.script);
    showModal(
      <GamePickerModal kind="script" games={games} current={currentScripts} onPick={(game) => startScriptFlow(game, setS)} />,
      window,
    );
  };

  /* ---- Add Shortcut Profile (any game): opens that game's settings ------ */
  const startAddProfile = () => {
    const games = getInstalledGames();
    if (games.length === 0) {
      toast("No installed games found.");
      return;
    }
    showModal(
      <GamePickerModal
        kind="profile"
        games={games}
        current={{}}
        onPick={(game) => showModal(<GameSettingsModal appId={String(game.appid)} fallbackName={game.name} />, window)}
      />,
      window,
    );
  };

  /* ---- Scan (never touches launch options) ----------------------------- */
  const doScan = async () => {
    setScanning(true);
    setScanMsg("Scanning…");
    try {
      const plan = await scanLibrary(s);
      if (plan.romAdd.length || plan.romRemove.length || plan.scriptAdd.length || plan.scriptRemove.length) {
        setS(await applyScan(plan.romAdd, plan.romRemove, plan.scriptAdd, plan.scriptRemove));
      }
      const parts: string[] = [];
      if (plan.added > 0) parts.push(`${plan.added} added`);
      if (plan.removed > 0) parts.push(`${plan.removed} removed`);
      setScanMsg(parts.length ? `Done — ${parts.join(", ")}` : "Done — no changes");
    } catch (e) {
      console.error("[Launch Manager] scan failed", e);
      setScanMsg("Scan failed.");
    } finally {
      setScanning(false);
    }
    setTimeout(() => setScanMsg(""), 5000);
  };

  /* ---- Settings ---------------------------------------------------------- */
  const pickRomDir = () =>
    showModal(
      <DirectoryBrowserModal
        title="ROM Starting Directory"
        startPath={s.browserDir}
        onSelect={async (p: string) => setS(await setBrowserDir(p))}
      />,
    );
  const addDir = () =>
    showModal(
      <DirectoryBrowserModal
        title="Scripts Directory"
        startPath={s.scriptDirs[s.scriptDirs.length - 1]?.path || "/home/deck"}
        onSelect={async (p: string) => setS(await addDirectory(p))}
      />,
    );
  const editExclusions = () => showModal(<ExclusionsModal initial={s.exclusions} onChange={setS} />);
  const editProfile = (profile: Profile | null) =>
    showModal(<ProfileEditorModal profile={profile} profiles={s.profiles} onChange={setS} />);

  return (
    <>
      <PanelSection title="Games">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={startAddRom}>
            Add ROM
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={startAddScript}>
            Add Script
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={startAddProfile}>
            Add Shortcut Profile
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={scanning} onClick={doScan}>
            {scanMsg || "Scan Library"}
          </ButtonItem>
        </PanelSectionRow>

        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setRomOpen(!romOpen)}>
            <Chevron open={romOpen}>ROM Games ({s.romGames.length})</Chevron>
          </ButtonItem>
        </PanelSectionRow>
        {romOpen && s.romGames.length === 0 && (
          <PanelSectionRow>
            <div style={{ opacity: 0.7 }}>No ROM games yet. Use Add ROM, a game's page button, or Scan.</div>
          </PanelSectionRow>
        )}
        {romOpen &&
          groupNames.map((group) => {
            const groupOpen = openGroups.has(group);
            const groupGames = groups.get(group)!;
            return (
              <div key={group}>
                <PanelSectionRow>
                  <ButtonItem layout="below" onClick={() => toggleGroup(group)}>
                    <div style={{ paddingLeft: "14px" }}>
                      <Chevron open={groupOpen}>
                        {group} ({groupGames.length})
                      </Chevron>
                    </div>
                  </ButtonItem>
                </PanelSectionRow>
                {groupOpen && [...groupGames].sort(byName).map(renderRow)}
              </div>
            );
          })}

        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setScriptOpen(!scriptOpen)}>
            <Chevron open={scriptOpen}>Script Games ({scriptRows.length})</Chevron>
          </ButtonItem>
        </PanelSectionRow>
        {scriptOpen && scriptRows.length === 0 && (
          <PanelSectionRow>
            <div style={{ opacity: 0.7 }}>No script games yet. Use Add Script, Add Shortcut Profile or Scan.</div>
          </PanelSectionRow>
        )}
        {scriptOpen && scriptRows.map(renderRow)}
      </PanelSection>

      <PanelSection title="ROM profiles">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => editProfile(null)}>
            Add Profile
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setProfilesOpen(!profilesOpen)}>
            <Chevron open={profilesOpen}>Profiles ({s.profiles.length})</Chevron>
          </ButtonItem>
        </PanelSectionRow>
        {profilesOpen && s.profiles.length === 0 && (
          <PanelSectionRow>
            <div style={{ opacity: 0.7 }}>No profiles yet. Use Add Profile.</div>
          </PanelSectionRow>
        )}
        {profilesOpen &&
          s.profiles.map((p) => (
            <PanelSectionRow key={p.id}>
              <ButtonItem layout="below" onClick={() => editProfile(p)} description={describeFileTypes(p)}>
                {p.name}
              </ButtonItem>
            </PanelSectionRow>
          ))}
      </PanelSection>

      <PanelSection title="Script directories">
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={addDir} description={s.scriptDirs.length === 0 ? "None set" : undefined}>
            Add Directory
          </ButtonItem>
        </PanelSectionRow>
        {s.scriptDirs.map((d) => (
          <div key={d.path}>
            <PanelSectionRow>
              <div style={{ wordBreak: "break-all", paddingTop: "8px" }}>{d.path}</div>
            </PanelSectionRow>
            <PanelSectionRow>
              <ToggleField
                label="Include subdirectories"
                checked={d.subdirs}
                onChange={async (v: boolean) => setS(await setDirectorySubdirs(d.path, v))}
              />
            </PanelSectionRow>
            <PanelSectionRow>
              <ButtonItem layout="below" onClick={async () => setS(await removeDirectory(d.path))}>
                Remove
              </ButtonItem>
            </PanelSectionRow>
          </div>
        ))}
      </PanelSection>

      <PanelSection title="Launch prompt">
        <PanelSectionRow>
          <TextField
            label="Script variable"
            description="The variable set for profiles if rewritten inside the .sh file (ignored by scripts that read from the environment via launch options)."
            value={varText ?? s.variable}
            onChange={async (e: any) => {
              setVarText(e.target.value);
              setS(await setPromptOptions({ variable: e.target.value }));
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Prompt for newly detected games"
            checked={s.askByDefault}
            onChange={async (v: boolean) => setS(await setPromptOptions({ askByDefault: v }))}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Back up scripts"
            description="Makes a backup for a script file the first time it is edited by this plugin."
            checked={s.backup}
            onChange={async (v: boolean) => setS(await setPromptOptions({ backup: v }))}
          />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Settings">
        <PanelSectionRow>
          <ToggleField
            label="Add button to game page"
            description="Adds a shortcut next to the Controller button that can configure launch options."
            checked={s.showGameButton}
            onChange={async (v: boolean) => {
              setGameButtonEnabled(v);
              setS(await setShowGameButton(v));
            }}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={pickRomDir} description={s.browserDir}>
            ROM Starting Directory
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Apply SteamGridDB art"
            bottomSeparator={s.sgdbArt ? "none" : "standard"}
            description="Applies the first Capsule, Wide Capsule, Hero, Logo, and Icon available to a new ROM."
            checked={s.sgdbArt}
            onChange={async (v: boolean) => setS(await setSgdbArt(v))}
          />
        </PanelSectionRow>
        {s.sgdbArt && (
          <PanelSectionRow>
            <Focusable
              style={{ display: "flex", alignItems: "flex-start", gap: "8px", paddingTop: "8px", width: "100%" }}
              // @ts-ignore
              flow-children="row"
            >
              <div ref={keyBox} style={{ flex: 1, minWidth: 0 }}>
                <TextField
                  label="SteamGridDB API key"
                  description="Found on steamgriddb.com under Preferences in the API tab."
                  value={keyText ?? s.sgdbKey}
                  onChange={async (e: any) => {
                    setKeyText(e.target.value);
                    setS(await setSgdbKey(e.target.value));
                  }}
                />
              </div>
              <div ref={eyeBox} style={{ flexShrink: 0 }}>
                <DialogButton style={rowButton} onClick={() => setShowKey(!showKey)}>
                  {showKey ? <FaEyeSlash size={14} /> : <FaEye size={14} />}
                </DialogButton>
              </div>
            </Focusable>
            <div
              ref={keySeparator}
              style={{ height: "1px", marginTop: "8px", backgroundColor: "rgba(255, 255, 255, 0.1)" }}
            />
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <ToggleField
            label="Add ROMs to collections"
            bottomSeparator="standard"
            description="Adds a new ROM to a new or matching collection."
            checked={s.romCollections}
            onChange={async (v: boolean) => setS(await setRomCollections(v))}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            bottomSeparator="none"
            onClick={editExclusions}
            description={s.exclusions.length > 0 ? s.exclusions.join(", ") : "Script file keywords/patterns to ignore on scan and launch"}
          >
            Script Exclusions
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  // Also primes the settings cache the launch prompt reads, before the first launch.
  getSettings()
    .then((st) => setGameButtonEnabled(st.showGameButton !== false))
    .catch(() => {});
  routerHook.addGlobalComponent(GLOBAL_NAME, GameButtonHost);
  const unregister = registerLaunchInterceptor();

  return {
    name: "Launch Manager",
    titleView: <div className={staticClasses.Title}>Launch Manager</div>,
    content: <Content />,
    icon: <FaTerminal />,
    onDismount() {
      unregister();
      routerHook.removeGlobalComponent(GLOBAL_NAME);
    },
  };
});
