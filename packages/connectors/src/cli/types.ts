export interface CliIO {
  cwd: string;
  stdout(message: string): void;
  stderr(message: string): void;
  fetch?: typeof fetch;
  now?: () => Date;
  onServe?: (url: string, close: () => Promise<void>) => Promise<void>;
  checkRepository?: (cwd: string) => void;
}

export interface ParsedArgs {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

export interface ReadOptions {
  platform: string;
  config: string;
  court: string;
  date: string;
  days: number;
  json: boolean;
  baseUrl?: string;
}
