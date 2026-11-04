import type { ParsedArgs } from "./types.js";

export function parseArgs(
  args: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
): ParsedArgs {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  const positional: string[] = [];
  const allowedValues = new Set(valueOptions);
  const allowedFlags = new Set(flagOptions);
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    if (allowedFlags.has(name)) {
      if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
      flags.add(name);
      continue;
    }
    if (!allowedValues.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for --${name}`);
    values.set(name, [...(values.get(name) ?? []), value]);
    index += 1;
  }
  return { positional, values, flags };
}

export function singleOption(
  values: Map<string, string[]>,
  name: string,
  required = false,
): string | undefined {
  const entries = values.get(name) ?? [];
  if (entries.length > 1) throw new Error(`Use --${name} only once`);
  const value = entries[0];
  if (required && !value) throw new Error(`Missing required option --${name}`);
  return value;
}
