import type { Platform } from "../contract/types.js";
import { activeNetPlatform } from "../platforms/activenet/index.js";
import { civicRecPlatform } from "../platforms/civicrec/index.js";

const platforms: ReadonlyMap<string, Platform> = new Map([
  [activeNetPlatform.id, activeNetPlatform],
  [civicRecPlatform.id, civicRecPlatform],
]);

const fixturePaths: Readonly<Record<string, string>> = {
  activenet: "examples/activenet/fixtures/cases",
  civicrec: "platforms/civicrec/fixtures",
};

export function getPlatform(id: string): Platform {
  const platform = platforms.get(id);
  if (!platform) throw new Error(`Unsupported platform: ${id}`);
  return platform;
}

export function listPlatforms(): Platform[] {
  return [...platforms.values()];
}

export function conformanceFixturePath(id: string): string {
  return fixturePaths[id] ?? `examples/${id}/fixtures/cases`;
}
