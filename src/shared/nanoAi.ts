export type ControlType = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date';

export interface ControlSummary {
  selector: string;
  label?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  controlType: ControlType;
}

export interface FieldMatchResult {
  selector: string;
  token: string;
  confidence: number;
}

export interface NanoRequestOptions {
  signal?: AbortSignal;
}

export const NANO_LIMITS = {
  availabilityTimeoutMs: 2_000,
  createTimeoutMs: 12_000,
  promptTimeoutMs: 20_000,
  maxControls: 32,
  // The served Minted catalog is already >132 entries (and includes user/contact
  // families). Keep enough room for the complete current vocabulary.
  maxTokens: 512,
  maxPromptCharacters: 32_000,
  maxResponseCharacters: 16_000,
} as const;

const SYSTEM_PROMPT = [
  'You map visible form-control metadata to Minted catalog token identifiers.',
  'Return only a JSON array. Each item must have exactly selector, token, and confidence.',
  'Use only selectors and tokens supplied in the user message, and use each selector at most once.',
  'Do not infer, create, or return provider values or other form values.',
  'Omit controls when the mapping is uncertain. Confidence must be a number from 0 to 1.',
].join(' ');

const RESPONSE_CONSTRAINT: Record<string, unknown> = {
  type: 'array',
  maxItems: NANO_LIMITS.maxControls,
  items: {
    type: 'object',
    properties: {
      selector: { type: 'string' },
      token: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['selector', 'token', 'confidence'],
    additionalProperties: false,
  },
};

const SAFE_CONTROL_TYPES = new Set<ControlType>([
  'text',
  'textarea',
  'select',
  'radio',
  'checkbox',
]);

type NanoSession = ChromeLanguageModelSession | LegacyAILanguageModelSession;

function currentApi(): ChromeLanguageModelAPI | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.LanguageModel;
  } catch {
    return undefined;
  }
}

function legacyApi(): LegacyAILanguageModelAPI | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.ai?.languageModel;
  } catch {
    return undefined;
  }
}

function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  onLateResult?: (result: T) => void,
  onExpired?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let completed = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    };

    const expire = (reason: Error): void => {
      if (completed) return;
      completed = true;
      cleanup();
      controller.abort(reason);
      onExpired?.();
      reject(reason);
    };

    const finish = (result: T): void => {
      if (completed) {
        onLateResult?.(result);
        return;
      }
      completed = true;
      cleanup();
      resolve(result);
    };

    const onExternalAbort = (): void => {
      expire(new Error('Nano request cancelled'));
    };

    const timer = setTimeout(
      () => expire(new Error('Nano request timed out')),
      timeoutMs,
    );

    if (externalSignal?.aborted) {
      onExternalAbort();
      return;
    }
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

    void Promise.resolve()
      .then(() => {
        if (completed) throw new Error('Nano request cancelled');
        return operation(controller.signal);
      })
      .then(finish, (error: unknown) => {
        if (completed) return;
        expire(error instanceof Error ? error : new Error('Nano request failed'));
      });
  });
}

function projectControls(controls: ControlSummary[]): ControlSummary[] {
  const projected: ControlSummary[] = [];
  const seenSelectors = new Set<string>();

  for (const control of controls) {
    if (!control || typeof control !== 'object') continue;
    const selector = cleanIdentifier(control.selector, 128);
    const controlType = control.controlType;
    if (!selector || !SAFE_CONTROL_TYPES.has(controlType) || seenSelectors.has(selector)) {
      continue;
    }

    seenSelectors.add(selector);
    projected.push({
      selector,
      controlType,
      ...(cleanText(control.label, 80) ? { label: cleanText(control.label, 80) } : {}),
      ...(cleanText(control.placeholder, 80)
        ? { placeholder: cleanText(control.placeholder, 80) }
        : {}),
      ...(cleanText(control.name, 64) ? { name: cleanText(control.name, 64) } : {}),
      ...(cleanText(control.id, 64) ? { id: cleanText(control.id, 64) } : {}),
    });

    if (projected.length >= NANO_LIMITS.maxControls) break;
  }

  return projected;
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // These controls must be removed before form metadata enters the local prompt.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
  return cleaned.length ? cleaned : undefined;
}

function cleanIdentifier(value: unknown, maxLength: number): string | undefined {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > maxLength ||
    value !== value.trim() ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return undefined;
  }
  return value;
}

function projectTokens(tokenCatalog: string[]): string[] {
  const projected: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenCatalog) {
    const safeToken = cleanIdentifier(token, 80);
    if (!safeToken || seen.has(safeToken)) continue;
    seen.add(safeToken);
    projected.push(safeToken);
    if (projected.length >= NANO_LIMITS.maxTokens) break;
  }
  return projected;
}

function buildPrompt(controls: ControlSummary[], tokens: string[]): string | undefined {
  const prompt = [
    'Return a JSON array matching this shape:',
    '[{"selector":"#npi","token":"provider.npi","confidence":0.95}]',
    `Allowed catalog tokens: ${JSON.stringify(tokens)}`,
    `Unmapped controls: ${JSON.stringify(controls)}`,
  ].join('\n');
  return prompt.length <= NANO_LIMITS.maxPromptCharacters ? prompt : undefined;
}

function parseMatches(
  response: unknown,
  selectors: Set<string>,
  tokens: Set<string>,
): FieldMatchResult[] {
  if (typeof response !== 'string' || response.length > NANO_LIMITS.maxResponseCharacters) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length > NANO_LIMITS.maxControls) return [];

  const accepted: FieldMatchResult[] = [];
  const seenSelectors = new Set<string>();
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const keys = Object.keys(candidate);
    if (
      keys.length !== 3 ||
      !keys.includes('selector') ||
      !keys.includes('token') ||
      !keys.includes('confidence')
    ) {
      return [];
    }

    const record = candidate as Record<string, unknown>;
    const { selector, token, confidence } = record;
    if (
      typeof selector !== 'string' ||
      typeof token !== 'string' ||
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !selectors.has(selector) ||
      !tokens.has(token) ||
      seenSelectors.has(selector)
    ) {
      return [];
    }

    seenSelectors.add(selector);
    accepted.push({ selector, token, confidence });
  }

  return accepted;
}

function destroySession(session: NanoSession): void {
  try {
    session.destroy();
  } catch {
    // A failed destroy must not expose model output or change the fail-closed result.
  }
}

type AttemptResult = { completed: true; matches: FieldMatchResult[] } | null;

async function runCurrent(
  api: ChromeLanguageModelAPI,
  prompt: string,
  selectors: Set<string>,
  tokens: Set<string>,
  signal?: AbortSignal,
): Promise<AttemptResult> {
  try {
    const availability = await withDeadline(
      () => api.availability(),
      NANO_LIMITS.availabilityTimeoutMs,
      signal,
    );
    if (availability !== 'available') return null;

    let session: ChromeLanguageModelSession | undefined;
    try {
      session = await withDeadline(
        (createSignal) =>
          api.create({
            initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
            signal: createSignal,
          }),
        NANO_LIMITS.createTimeoutMs,
        signal,
        (lateSession) => destroySession(lateSession),
      );
    } catch {
      return null;
    }

    try {
      const response = await withDeadline(
        (promptSignal) =>
          session!.prompt(prompt, {
            signal: promptSignal,
            responseConstraint: RESPONSE_CONSTRAINT,
          }),
        NANO_LIMITS.promptTimeoutMs,
        signal,
      );
      return { completed: true, matches: parseMatches(response, selectors, tokens) };
    } catch {
      return null;
    } finally {
      destroySession(session);
    }
  } catch {
    return null;
  }
}

async function runLegacy(
  api: LegacyAILanguageModelAPI,
  prompt: string,
  selectors: Set<string>,
  tokens: Set<string>,
  signal?: AbortSignal,
): Promise<AttemptResult> {
  try {
    const capabilities = await withDeadline(
      () => api.capabilities(),
      NANO_LIMITS.availabilityTimeoutMs,
      signal,
    );
    if (capabilities.available !== 'readily') return null;

    let session: LegacyAILanguageModelSession | undefined;
    try {
      session = await withDeadline(
        (createSignal) => api.create({ systemPrompt: SYSTEM_PROMPT, signal: createSignal }),
        NANO_LIMITS.createTimeoutMs,
        signal,
        (lateSession) => destroySession(lateSession),
      );
    } catch {
      return null;
    }

    try {
      const response = await withDeadline(
        () => session!.prompt(prompt),
        NANO_LIMITS.promptTimeoutMs,
        signal,
      );
      return { completed: true, matches: parseMatches(response, selectors, tokens) };
    } catch {
      return null;
    } finally {
      destroySession(session);
    }
  } catch {
    return null;
  }
}

export async function canUseNano(options: NanoRequestOptions = {}): Promise<boolean> {
  const signal = options.signal;
  if (signal?.aborted) return false;

  const current = currentApi();
  if (current) {
    try {
      const availability = await withDeadline(
        () => current.availability(),
        NANO_LIMITS.availabilityTimeoutMs,
        signal,
      );
      if (availability === 'available') return true;
    } catch {
      if (signal?.aborted) return false;
    }
  }

  const legacy = legacyApi();
  if (!legacy || signal?.aborted) return false;
  try {
    const capabilities = await withDeadline(
      () => legacy.capabilities(),
      NANO_LIMITS.availabilityTimeoutMs,
      signal,
    );
    return capabilities.available === 'readily';
  } catch {
    return false;
  }
}

export async function matchUnmappedFields(
  controls: ControlSummary[],
  tokenCatalog: string[],
  options: NanoRequestOptions = {},
): Promise<FieldMatchResult[]> {
  if (options.signal?.aborted || !Array.isArray(controls) || !Array.isArray(tokenCatalog)) {
    return [];
  }

  const projectedControls = projectControls(controls);
  const projectedTokens = projectTokens(tokenCatalog);
  if (!projectedControls.length || !projectedTokens.length) return [];

  const prompt = buildPrompt(projectedControls, projectedTokens);
  if (!prompt) return [];
  const selectors = new Set(projectedControls.map((control) => control.selector));
  const tokens = new Set(projectedTokens);

  const current = currentApi();
  if (current) {
    const result = await runCurrent(current, prompt, selectors, tokens, options.signal);
    if (result) return result.matches;
    if (options.signal?.aborted) return [];
  }

  const legacy = legacyApi();
  if (!legacy) return [];
  const result = await runLegacy(legacy, prompt, selectors, tokens, options.signal);
  return result?.matches ?? [];
}
