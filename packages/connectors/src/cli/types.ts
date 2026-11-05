export interface CliIO {
  cwd: string;
  stdout(message: string): void;
  stderr(message: string): void;
  fetch?: typeof fetch;
  admissionFetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  now?: () => Date;
  onServe?: (url: string, close: () => Promise<void>) => Promise<void>;
  checkRepository?: (cwd: string) => void;
  ci?: boolean;
}

export class CliExit extends Error {
  constructor(public exitCode: 0 | 1 | 2 | 3) {
    super(`CLI command ended with status ${exitCode}`);
  }
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
