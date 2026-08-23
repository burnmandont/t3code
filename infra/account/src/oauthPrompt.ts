export function hasOauthPrompt(oauthQuery: string | undefined, expectedPrompt: string): boolean {
  if (!oauthQuery) return false;
  const prompt = new URLSearchParams(oauthQuery).get("prompt");
  return prompt?.split(/\s+/u).includes(expectedPrompt) ?? false;
}
