const CHALLENGE_PATH = "/cdn-cgi/challenge-platform/";

export function detectChallenge(
  body: string,
  options: { passiveAssets?: readonly string[] } = {},
): boolean {
  if (
    /<title[^>]*>\s*(?:just a moment|access denied|attention required|verify (?:you are|that you are) human)|\bid=["']challenge-form["']/i.test(
      body,
    )
  )
    return true;
  const lower = body.toLowerCase();
  let index = 0;
  while ((index = lower.indexOf(CHALLENGE_PATH, index)) !== -1) {
    const allowed = options.passiveAssets?.some((asset) => {
      const match = asset.toLowerCase();
      if (!lower.startsWith(match, index)) return false;
      const next = body[index + match.length];
      return next === undefined || next === "?" || next === "'" || next === '"';
    });
    if (!allowed) return true;
    index += CHALLENGE_PATH.length;
  }
  return false;
}
