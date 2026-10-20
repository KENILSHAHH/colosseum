// Claude client for the direct calls of the server (guards, memory). The agent runs reach Claude through the LLM proxy instead.
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import { config, useBedrock, workspaceHeader } from "./config";

/** A Bedrock client when the Bedrock API key is set, else an Anthropic client. Both have the same messages API. */
export function claudeClient(opts: { timeout: number; maxRetries: number }): Anthropic {
  const c = config();
  if (useBedrock()) {
    return new AnthropicBedrock({ apiKey: c.AWS_BEARER_TOKEN_BEDROCK, awsRegion: c.AWS_REGION, ...opts }) as unknown as Anthropic;
  }
  return new Anthropic({ apiKey: c.ANTHROPIC_API_KEY, defaultHeaders: workspaceHeader(), ...opts });
}
