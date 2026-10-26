/**
 * Pure helpers for passing a profile through a game's Steam launch options
 * instead of editing its script: `PROFILE=2 /path/script.sh %command%`.
 *
 * Only a leading `VAR=value` assignment in front of `%command%` is ever read
 * or changed: that's the one token this plugin owns. Everything else in the
 * launch options is left exactly as the person wrote it.
 */

const COMMAND = "%command%";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LEADING_ASSIGNMENT = /^\s*([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"']*)(?=\s|$)/;

/** The run of `NAME=value` tokens at the very start, and everything after it. */
function splitLeadingAssignments(options: string) {
  const assignments: { name: string; text: string }[] = [];
  let rest = options;
  for (;;) {
    const match = LEADING_ASSIGNMENT.exec(rest);
    if (!match) break;
    assignments.push({ name: match[1], text: match[0].trim() });
    rest = rest.slice(match[0].length);
  }
  return { assignments, rest: rest.trim() };
}

/**
 * The launch options with `variable=value` as the leading assignment.
 *
 * Steam only treats a leading `NAME=value` as an environment variable when
 * `%command%` is present. Without it, whatever is in the field is passed to the
 * game as arguments, so it's kept as arguments, after a `%command%` we add.
 */
export function withProfileEnv(options: string, variable: string, value: string | number): string {
  if (!IDENTIFIER.test(variable)) {
    throw new Error(`"${variable}" isn't a valid shell variable name`);
  }
  const own = `${variable}=${value}`;
  const trimmed = options.trim();

  if (!trimmed.includes(COMMAND)) {
    return [own, COMMAND, trimmed].filter(Boolean).join(" ");
  }

  const { assignments, rest } = splitLeadingAssignments(trimmed);
  // Already exactly what we'd write: leave the person's text untouched.
  if (assignments.some((a) => a.text === own)) return options;

  const others = assignments.filter((a) => a.name !== variable).map((a) => a.text);
  return [own, ...others, rest].filter(Boolean).join(" ");
}

/**
 * The launch options with any leading `variable=value` removed: undoing
 * withProfileEnv for a game that has moved back to file editing. Returns the
 * input unchanged when there's nothing of ours to remove.
 */
export function withoutProfileEnv(options: string, variable: string): string {
  const trimmed = options.trim();
  if (!trimmed.includes(COMMAND)) return options;

  const { assignments, rest } = splitLeadingAssignments(trimmed);
  if (!assignments.some((a) => a.name === variable)) return options;

  const cleaned = [...assignments.filter((a) => a.name !== variable).map((a) => a.text), rest]
    .filter(Boolean)
    .join(" ");
  // A bare %command% is the same as an empty field.
  return cleaned === COMMAND ? "" : cleaned;
}
