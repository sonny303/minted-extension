interface MockNanoErrors {
  currentAvailability?: Error;
  legacyCapabilities?: Error;
  currentCreate?: Error;
  legacyCreate?: Error;
  prompt?: Error;
}

interface MockNanoHangs {
  availability?: boolean;
  capabilities?: boolean;
  create?: boolean;
  prompt?: boolean;
}

export interface MockNanoModelOptions {
  availability?: ChromeLanguageModelAvailability;
  legacyAvailable?: LegacyAILanguageModelCapabilities['available'];
  outputs?: string[];
  errors?: MockNanoErrors;
  hangs?: MockNanoHangs;
}

export interface MockNanoCalls {
  currentAvailability: number;
  legacyCapabilities: number;
  currentCreate: number;
  legacyCreate: number;
  prompt: number;
  destroy: number;
}

class MockNanoSession implements ChromeLanguageModelSession {
  destroyed = false;

  constructor(
    private readonly model: MockNanoModel,
    private readonly response: string,
  ) {}

  async prompt(
    input: string | ChromeLanguageModelMessage[],
    options?: ChromeLanguageModelPromptOptions,
  ): Promise<string> {
    if (this.destroyed) throw new Error('Mock session destroyed');
    return this.model.prompt(this.response, options?.signal, input);
  }

  promptStreaming(
    _input: string | ChromeLanguageModelMessage[],
    options?: ChromeLanguageModelPromptOptions,
  ): ReadableStream<string> {
    if (this.destroyed) throw new Error('Mock session destroyed');
    if (options?.signal?.aborted) throw new Error('Mock prompt aborted');
    const response = this.response;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(response);
        controller.close();
      },
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.model.recordDestroy();
  }
}

export class MockNanoModel {
  readonly calls: MockNanoCalls = {
    currentAvailability: 0,
    legacyCapabilities: 0,
    currentCreate: 0,
    legacyCreate: 0,
    prompt: 0,
    destroy: 0,
  };

  readonly sessions: MockNanoSession[] = [];
  readonly promptInputs: Array<string | ChromeLanguageModelMessage[]> = [];

  readonly current: ChromeLanguageModelAPI;
  readonly legacy: LegacyAILanguageModelAPI;

  private readonly outputs: string[];
  private readonly errors: MockNanoErrors;
  private readonly hangs: MockNanoHangs;
  private readonly availability: ChromeLanguageModelAvailability;
  private readonly legacyAvailable: LegacyAILanguageModelCapabilities['available'];
  private pendingCreateResolvers: Array<(session: MockNanoSession) => void> = [];

  constructor(options: MockNanoModelOptions = {}) {
    this.outputs = options.outputs?.slice() ?? ['[]'];
    this.errors = options.errors ?? {};
    this.hangs = options.hangs ?? {};
    this.availability = options.availability ?? 'available';
    this.legacyAvailable = options.legacyAvailable ?? 'readily';

    this.current = {
      availability: () => this.getAvailability(),
      create: (createOptions) => this.createCurrent(createOptions),
    };
    this.legacy = {
      capabilities: () => this.getCapabilities(),
      create: (createOptions) => this.createLegacy(createOptions),
    };
  }

  async getAvailability(): Promise<ChromeLanguageModelAvailability> {
    this.calls.currentAvailability += 1;
    if (this.errors.currentAvailability) throw this.errors.currentAvailability;
    if (this.hangs.availability) return new Promise(() => undefined);
    return this.availability;
  }

  async getCapabilities(): Promise<LegacyAILanguageModelCapabilities> {
    this.calls.legacyCapabilities += 1;
    if (this.errors.legacyCapabilities) throw this.errors.legacyCapabilities;
    if (this.hangs.capabilities) return new Promise(() => undefined);
    return { available: this.legacyAvailable };
  }

  async createCurrent(
    _options?: ChromeLanguageModelCreateOptions,
  ): Promise<MockNanoSession> {
    void _options;
    this.calls.currentCreate += 1;
    if (this.errors.currentCreate) throw this.errors.currentCreate;
    if (this.hangs.create) {
      return new Promise((resolve) => this.pendingCreateResolvers.push(resolve));
    }
    return this.createSession();
  }

  async createLegacy(
    _options?: LegacyAILanguageModelCreateOptions,
  ): Promise<MockNanoSession> {
    void _options;
    this.calls.legacyCreate += 1;
    if (this.errors.legacyCreate) throw this.errors.legacyCreate;
    if (this.hangs.create) {
      return new Promise((resolve) => this.pendingCreateResolvers.push(resolve));
    }
    return this.createSession();
  }

  async prompt(
    response: string,
    signal?: AbortSignal,
    input: string | ChromeLanguageModelMessage[] = '',
  ): Promise<string> {
    this.calls.prompt += 1;
    this.promptInputs.push(input);
    if (this.errors.prompt) throw this.errors.prompt;
    if (!this.hangs.prompt) return response;
    if (signal?.aborted) throw new Error('Mock prompt aborted');
    if (!signal) return new Promise(() => undefined);
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Mock prompt aborted')), {
        once: true,
      });
    });
  }

  releasePendingCreates(): void {
    const resolvers = this.pendingCreateResolvers;
    this.pendingCreateResolvers = [];
    for (const resolve of resolvers) resolve(this.createSession());
  }

  recordDestroy(): void {
    this.calls.destroy += 1;
  }

  private createSession(): MockNanoSession {
    const response = this.outputs.shift() ?? '[]';
    const session = new MockNanoSession(this, response);
    this.sessions.push(session);
    return session;
  }
}
