import { groundInSource } from "./honesty";
import { RulesResumeParser } from "./rulesParser";
import type { ParsedResume, ReadHints, ResumeParser } from "./types";

export * from "./types";
export * from "./dates";
export * from "./rulesParser";
export * from "./honesty";
export * from "./pii";
export * from "./extract";
export * from "./linkedin";
export { ClaudeResumeParser, unplacedLines, type ReadTrace } from "./claudeParser";

/**
 * Reads resume text with the configured reader, falls back to the rule reader
 * if the AI reader fails, then applies the honesty check (F1) to the result.
 */
export async function readResume(text: string, parser: ResumeParser = new RulesResumeParser(),
  opts: { hints?: ReadHints; fallbackText?: string } = {}): Promise<ParsedResume> {
  let parsed: ParsedResume;
  try {
    parsed = await parser.parse(text, opts.hints);
  } catch {
    // The built-in reader needs its own headings; the caller gives the text with them.
    parsed = await new RulesResumeParser().parse(opts.fallbackText ?? text);
    parsed.notes.push("Read with the built-in reader.");
  }
  return groundInSource(parsed, text);
}
export * from "./digest";
export * from "./linkedinLink";
export * from "./readerPrompt";
