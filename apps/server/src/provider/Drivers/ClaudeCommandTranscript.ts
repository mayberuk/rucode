const CLAUDE_RECORD_TAG =
  /<(command-(?:message|name|args)|local-command-(?:stdout|stderr))>(.*?)<\/\1>\s*/gsy;

/** Restores the prompt text that RuCode stores before dispatching a Claude command. */
export function claudeTranscriptUserText(text: string): string | null {
  const record = text.trim();
  if (!record.startsWith("<")) return text;

  const values = new Map<string, string>();
  let end = 0;
  for (const match of record.matchAll(CLAUDE_RECORD_TAG)) {
    const tag = match[1]!;
    if (tag.startsWith("local-command-")) {
      return match[0].length === record.length ? null : text;
    }
    if (values.has(tag)) return text;
    values.set(tag, match[2]!);
    end += match[0].length;
  }

  const commandName = values.get("command-name");
  if (end !== record.length || commandName === undefined) return text;
  const name = commandName.replace(/^\//, "");
  const args = values.get("command-args")?.trim();
  const sigil =
    record.startsWith("<command-message>") && /^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/.test(name) ? "$" : "/";
  return args ? `${sigil}${name} ${args}` : `${sigil}${name}`;
}
