import type { TextModelClient } from './textClient.ts';

export interface TextClientSettings { apiKey: string; endpoint: string; model: string }

/** One client per settings key (config version + key version). A new key replaces the old client. */
export class TextClientCache {
  private entry: { key: string; client: TextModelClient } | null = null;

  constructor(private readonly make: (settings: TextClientSettings) => TextModelClient) {}

  get(key: string, settings: TextClientSettings): TextModelClient {
    if (this.entry?.key !== key) this.entry = { key, client: this.make(settings) };
    return this.entry.client;
  }
}

/** For long-lived callers (the memory worker): picks the current client on every call. */
export function switchingTextClient(resolve: () => TextModelClient): TextModelClient {
  return { complete: (input) => resolve().complete(input) };
}
