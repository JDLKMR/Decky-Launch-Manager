// Per-game launch prompt settings, opened from a games list row's settings button.
import { useEffect, useState } from "react";
import { FaPen, FaTrash, FaUndo } from "react-icons/fa";
import { resolveScript, setGameProfile } from "./api";
import { promptLinkName, promptPickGame } from "./LinkModals";
import { DEFAULT_LABEL, buildPromptEntries, minLinkPosition, newLinkId } from "./links";
import { noteGameSettingsClosed } from "./panelMemory";
import { basename, getLaunchInfo, getOverview } from "./steam";
import { gameProfile, snapshot } from "./store";
import type { GameProfile, ShortcutLink, TableProfile } from "./types";
import { DialogButton, DropdownItem, Focusable, ModalRoot, ToggleField } from "./ui";

const iconButtonStyle = {
  padding: "0",
  minWidth: "0",
  width: "32px",
  height: "32px",
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

/**
 * A game's script profiles (their names and order) come from its own script,
 * re-read fresh every time this opens (same as every launch), so there's
 * nothing to edit for those; this shows the prompt as it will appear. What's
 * configurable here: whether prompting happens at all, and this game's
 * shortcut profiles.
 */
export function GameSettingsModal({
  appId,
  fallbackName,
  closeModal,
}: {
  appId: string;
  fallbackName?: string;
  closeModal?: () => void;
}) {
  const numeric = Number(appId);
  const initial = gameProfile(appId);
  // ROM games only ever offer shortcut profiles: their Target may itself be a .sh (the 3DS profile) that isn't a profile script.
  const isRom = !!snapshot()?.romGames.some((g) => g.appid === numeric);

  const [config, setConfig] = useState<GameProfile | undefined>(initial);
  const [ready, setReady] = useState(false);
  const [scriptPath, setScriptPath] = useState("");
  const [profiles, setProfiles] = useState<TableProfile[]>([]);
  const [name, setName] = useState(initial?.name || fallbackName || `App ${appId}`);

  // Tell the games list when this closes, so it can reopen where you were.
  useEffect(() => () => noteGameSettingsClosed(numeric), [numeric]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const info = await getLaunchInfo(numeric);
        if (cancelled) return;
        if (info.name) setName(info.name);

        if (!isRom) {
          const script = await resolveScript(info.exe, info.launchOptions);
          if (cancelled) return;
          setScriptPath(script.path);
          setProfiles(script.profiles);
        }
      } catch (e) {
        console.error("[Launch Manager] game lookup failed", e);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [appId]);

  const links = config?.links ?? [];
  const entries = buildPromptEntries(profiles, links, config?.defaultName);
  const hasCustomDefaultName = !!config?.defaultName?.trim();
  const minPosition = minLinkPosition(profiles);

  const update = async (patch: Partial<GameProfile>) => {
    const next = await setGameProfile(numeric, { ...(gameProfile(appId) ? {} : { name }), ...patch });
    setConfig(next.gameProfiles[appId]);
  };

  // Read the latest links from the cache rather than a render's closure, so
  // two quick edits in a row can't overwrite each other.
  const latestLinks = (): ShortcutLink[] => gameProfile(appId)?.links ?? [];
  const saveLinks = (next: ShortcutLink[]) => update({ links: next });

  const addLink = async () => {
    const picked = await promptPickGame({
      title: "Add shortcut profile",
      description: "Pick a game for this one's launch prompt to open. It will show up alongside the other profiles.",
      confirmLabel: "Add",
      askName: true,
      excludeAppId: numeric,
    });
    if (!picked) return;
    await saveLinks([...latestLinks(), { id: newLinkId(), targetAppId: picked.appId, name: picked.name }]);
  };

  const renameLink = async (link: ShortcutLink) => {
    const next = await promptLinkName(link.name);
    if (next === null) return;
    await saveLinks(latestLinks().map((l) => (l.id === link.id ? { ...l, name: next } : l)));
  };

  // The Default entry (opens this game normally when it has no script
  // profiles) can be given this game's own name; empty means "Default".
  const renameDefault = async (current: string) => {
    const next = await promptLinkName(current, "Rename default profile");
    if (next === null) return;
    await update({ defaultName: next === DEFAULT_LABEL ? "" : next });
  };

  const removeLink = (link: ShortcutLink) => saveLinks(latestLinks().filter((l) => l.id !== link.id));

  const setPosition = (link: ShortcutLink, position: number) =>
    saveLinks(
      latestLinks().map((l) => {
        if (l.id !== link.id) return l;
        const { position: _drop, ...rest } = l;
        return position > 0 ? { ...rest, position } : rest;
      }),
    );

  // Numbers a shortcut profile can take. With no script profiles, Default
  // holds number 1, so they start at 2.
  const positionOptions = [
    { data: 0, label: "Last (default)" },
    ...Array.from({ length: Math.max(0, entries.length - minPosition + 1) }, (_, i) => ({
      data: minPosition + i,
      label: String(minPosition + i),
    })),
  ];

  return (
    <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={{ fontSize: "1.4em", fontWeight: "bold" }}>Game Settings</div>
        <div style={{ opacity: 0.7, fontSize: "0.9em" }}>
          {name}
          {scriptPath ? ` · ${basename(scriptPath)}` : ""}
        </div>
      </div>

      {!ready && <div style={{ marginTop: "16px", opacity: 0.7 }}>Looking up launch options…</div>}

      {ready && (
        <>
          <div style={{ marginTop: "16px" }}>
            <ToggleField
              label="Prompt for a profile on launch"
              checked={config?.enabled ?? snapshot()?.askByDefault ?? true}
              onChange={(enabled: boolean) => update({ enabled })}
            />
          </div>

          <div style={{ marginTop: "16px", marginBottom: "4px", opacity: 0.7 }}>Launch prompt as it will appear</div>

          {entries.length > 0 ? (
            <Focusable style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
              {entries.map((entry, index) =>
                entry.kind === "default" ? (
                  <Focusable key={entry.key} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                    <div style={{ flexGrow: 1, minWidth: 0, padding: "6px 0", opacity: 0.9 }}>
                      {index + 1}. {entry.label}
                      <span style={{ opacity: 0.5, fontSize: "0.85em", marginLeft: "8px" }}>this game</span>
                    </div>
                    <DialogButton onClick={() => void renameDefault(entry.label)} style={iconButtonStyle}>
                      <FaPen size={11} />
                    </DialogButton>
                    {hasCustomDefaultName && (
                      <DialogButton onClick={() => void update({ defaultName: "" })} style={iconButtonStyle}>
                        <FaUndo size={11} />
                      </DialogButton>
                    )}
                  </Focusable>
                ) : (
                  <div key={entry.key} style={{ padding: "6px 0", opacity: 0.9 }}>
                    {index + 1}. {entry.label}
                    {entry.kind === "link" && (
                      <span style={{ opacity: 0.5, fontSize: "0.85em", marginLeft: "8px" }}>shortcut</span>
                    )}
                  </div>
                ),
              )}
            </Focusable>
          ) : (
            <div style={{ opacity: 0.8 }}>
              {scriptPath
                ? "No PROFILE_NAMES table found yet. Add one to this script, or add a shortcut profile below, to enable the launch prompt."
                : "This game doesn't use a profile script. Add a shortcut profile below and its launch prompt will offer the game itself first, then your shortcut profiles."}
            </div>
          )}

          <div style={{ marginTop: "16px", marginBottom: "4px", opacity: 0.7 }}>Shortcut profiles</div>

          {links.map((link) => {
            const target = getOverview(link.targetAppId);
            const shownPosition = link.position ? Math.max(link.position, minPosition) : 0;
            return (
              <div key={link.id} style={{ marginBottom: "8px" }}>
                <Focusable style={{ display: "flex", alignItems: "center", gap: "2px" }}>
                  <div style={{ flexGrow: 1, minWidth: 0, padding: "4px 0" }}>
                    <div>{link.name}</div>
                    <div style={{ opacity: 0.6, fontSize: "0.85em" }}>
                      {target ? `Opens ${target.display_name}` : "Game not found in your library"}
                    </div>
                  </div>
                  <DialogButton onClick={() => void renameLink(link)} style={iconButtonStyle}>
                    <FaPen size={11} />
                  </DialogButton>
                  <DialogButton onClick={() => void removeLink(link)} style={iconButtonStyle}>
                    <FaTrash size={11} />
                  </DialogButton>
                </Focusable>
                <DropdownItem
                  label="Number in launch prompt"
                  rgOptions={positionOptions}
                  selectedOption={shownPosition}
                  strDefaultLabel={shownPosition ? String(shownPosition) : "Last (default)"}
                  onChange={(option: { data: number }) => void setPosition(link, option.data)}
                />
              </div>
            );
          })}

          <DialogButton onClick={() => void addLink()}>Add shortcut profile...</DialogButton>
        </>
      )}

      <Focusable style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
        <DialogButton onClick={closeModal}>Close</DialogButton>
      </Focusable>
    </ModalRoot>
  );
}
