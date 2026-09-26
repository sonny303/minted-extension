// Pinned types for Chrome's built-in Prompt API and its legacy extension API.
// Current API reference: https://developer.chrome.com/docs/ai/prompt-api
// Legacy API shape is retained for window.ai.languageModel feature detection.
declare global {
  interface ChromeLanguageModelMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    prefix?: boolean;
  }

  type ChromeLanguageModelAvailability =
    | 'unavailable'
    | 'downloadable'
    | 'downloading'
    | 'available';

  interface ChromeLanguageModelPromptOptions {
    signal?: AbortSignal;
    responseConstraint?: Record<string, unknown> | RegExp;
    omitResponseConstraintInput?: boolean;
  }

  interface ChromeLanguageModelCoreOptions {
    // Chrome Extensions continue to support these legacy sampling parameters.
    temperature?: number;
    topK?: number;
  }

  interface ChromeLanguageModelCreateOptions extends ChromeLanguageModelCoreOptions {
    initialPrompts?: ChromeLanguageModelMessage[];
    signal?: AbortSignal;
  }

  interface ChromeLanguageModelSession {
    prompt(
      input: string | ChromeLanguageModelMessage[],
      options?: ChromeLanguageModelPromptOptions,
    ): Promise<string>;
    promptStreaming(
      input: string | ChromeLanguageModelMessage[],
      options?: ChromeLanguageModelPromptOptions,
    ): ReadableStream<string>;
    destroy(): void;
    contextUsage?: number;
    contextWindow?: number;
  }

  interface ChromeLanguageModelAPI {
    availability(
      options?: ChromeLanguageModelCoreOptions,
    ): Promise<ChromeLanguageModelAvailability>;
    create(options?: ChromeLanguageModelCreateOptions): Promise<ChromeLanguageModelSession>;
  }

  interface LegacyAILanguageModelCapabilities {
    available: 'no' | 'readily' | 'after-download';
    defaultTemperature?: number;
    maxTemperature?: number;
    defaultTopK?: number;
    maxTopK?: number;
  }

  interface LegacyAILanguageModelCreateOptions {
    systemPrompt?: string;
    temperature?: number;
    topK?: number;
    signal?: AbortSignal;
  }

  interface LegacyAILanguageModelSession {
    prompt(input: string): Promise<string>;
    promptStreaming(input: string): ReadableStream<string>;
    destroy(): void;
    tokensSoFar?: number;
    maxTokens?: number;
  }

  interface LegacyAILanguageModelAPI {
    capabilities(): Promise<LegacyAILanguageModelCapabilities>;
    create(options?: LegacyAILanguageModelCreateOptions): Promise<LegacyAILanguageModelSession>;
  }

  interface Window {
    LanguageModel?: ChromeLanguageModelAPI;
    ai?: {
      languageModel?: LegacyAILanguageModelAPI;
    };
  }
}

export {};
