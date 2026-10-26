// The prompt shown when a game with script profiles and/or shortcut profiles is launched.
import { useRef, useState } from "react";
import type { PromptEntry } from "./links";
import { DialogButton, Focusable, ModalRoot, ToggleField, showModal } from "./ui";

export interface ProfileChoice {
  /** What was picked, or null if the launch was cancelled. */
  entry: PromptEntry | null;
  /** false = stop prompting for this game from now on. */
  keepAsking: boolean;
}

interface Props {
  /** Script profiles and shortcut profiles, already merged and ordered. */
  entries: PromptEntry[];
  /** Key of the entry to pre-select, or null if none applies. */
  defaultKey: string | null;
  onResult: (choice: ProfileChoice) => void;
  closeModal?: () => void;
}

function PromptModal({ entries, defaultKey, onResult, closeModal }: Props) {
  const [keepAsking, setKeepAsking] = useState(true);
  const settled = useRef(false);

  const settle = (choice: ProfileChoice) => {
    if (settled.current) return;
    settled.current = true;
    onResult(choice);
    closeModal?.();
  };

  return (
    <ModalRoot
      onCancel={() => settle({ entry: null, keepAsking })}
      onEscKeypress={() => settle({ entry: null, keepAsking })}
    >
      <div style={{ fontSize: "1.4em", fontWeight: "bold" }}>Select Profile</div>

      <Focusable style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "16px" }}>
        {entries.map((entry, index) => {
          const isDefault = entry.key === defaultKey;
          return (
            <DialogButton
              key={entry.key}
              // Steam's controller navigation on Deck follows native DOM focus, so
              // autoFocus genuinely gives the last-used profile initial gamepad focus.
              {...{ autoFocus: isDefault }}
              onClick={() => settle({ entry, keepAsking })}
              style={{ display: "flex", justifyContent: "space-between" }}
            >
              <span>
                {index + 1}. {entry.label}
              </span>
              {isDefault && <span style={{ opacity: 0.6, fontSize: "0.85em" }}>last used</span>}
            </DialogButton>
          );
        })}
      </Focusable>

      <div style={{ marginTop: "16px" }}>
        <ToggleField label="Always ask for this game" checked={keepAsking} onChange={setKeepAsking} />
      </div>

      <Focusable style={{ display: "flex", gap: "8px", marginTop: "8px" }} flow-children="horizontal">
        <DialogButton onClick={() => settle({ entry: null, keepAsking })}>Cancel</DialogButton>
      </Focusable>
    </ModalRoot>
  );
}

export function promptForProfile(props: Omit<Props, "onResult" | "closeModal">): Promise<ProfileChoice> {
  return new Promise((resolve) => {
    showModal(<PromptModal {...props} onResult={resolve} />, window);
  });
}
