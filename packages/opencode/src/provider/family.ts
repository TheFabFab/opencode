// DocuMentor's credential proxy registers the OpenAI and Anthropic providers under
// their own ids. They behave exactly like the upstream providers, so every place
// that keys behaviour on a literal provider id asks for the family instead.
const FAMILIES: Record<string, string> = {
  "documentor-openai": "openai",
  "documentor-anthropic": "anthropic",
}

export function providerFamily(id: string): string {
  return FAMILIES[id] ?? id
}

export const isOpenAIFamily = (id: string) => providerFamily(id) === "openai"

export const isAnthropicFamily = (id: string) => providerFamily(id) === "anthropic"
