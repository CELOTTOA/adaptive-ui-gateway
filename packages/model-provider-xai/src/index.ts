import type { ModelProvider, ModelRequest } from "@aug/ui-planner";

export interface XaiModelProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** xAI (Grok) adapter for the vendor-neutral ModelProvider interface. */
export class XaiModelProvider implements ModelProvider {
  readonly id: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XaiModelProviderOptions) {
    if (!options.apiKey) {
      throw new Error("An xAI API key is required");
    }
    if (!options.model) {
      throw new Error("An xAI model is required");
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.endpoint = `${(options.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "")}/chat/completions`;
    this.fetchImpl = options.fetch ?? fetch;
    this.id = `xai:${options.model}`;
  }

  async complete(request: ModelRequest, options: { signal: AbortSignal }): Promise<string> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      signal: options.signal,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.input },
        ],
        max_tokens: request.maxOutputTokens,
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: { name: "ui_layout_proposal", schema: request.responseSchema },
        },
      }),
    });
    if (!response.ok) {
      // Never surface the provider body: it may echo request details or credentials.
      throw new Error(`xAI request failed with status ${response.status}`);
    }
    const payload = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("xAI response did not contain text content");
    }
    return content;
  }
}
