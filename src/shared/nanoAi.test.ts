import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseNano,
  matchUnmappedFields,
  NANO_LIMITS,
  type ControlSummary,
} from './nanoAi';
import { MockNanoModel } from './nanoMock';

const control: ControlSummary = {
  selector: '#npi',
  label: 'National Provider Identifier',
  placeholder: 'NPI',
  name: 'npi',
  id: 'npi',
  controlType: 'text',
};
const catalog = ['provider.npi', 'provider.firstName'];
const validResponse = JSON.stringify([
  { selector: '#npi', token: 'provider.npi', confidence: 0.97 },
]);

function installModel(
  model: MockNanoModel,
  options: { current?: boolean; legacy?: boolean } = {},
): void {
  const current = options.current !== false;
  const legacy = options.legacy !== false;
  vi.stubGlobal(
    'window',
    {
      ...(current ? { LanguageModel: model.current } : {}),
      ...(legacy ? { ai: { languageModel: model.legacy } } : {}),
    } as Window,
  );
}

async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

function promptControls(model: MockNanoModel): ControlSummary[] {
  const prompt = model.promptInputs[0];
  if (typeof prompt !== 'string') throw new Error('Expected a text prompt');
  const marker = 'Unmapped controls: ';
  return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) as ControlSummary[];
}

function promptTokens(model: MockNanoModel): string[] {
  const prompt = model.promptInputs[0];
  if (typeof prompt !== 'string') throw new Error('Expected a text prompt');
  const marker = 'Allowed catalog tokens: ';
  const start = prompt.indexOf(marker) + marker.length;
  const end = prompt.indexOf('\n', start);
  return JSON.parse(prompt.slice(start, end)) as string[];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Chrome on-device field matching', () => {
  it('uses the current API first and destroys its session after success', async () => {
    const model = new MockNanoModel({ outputs: [validResponse] });
    installModel(model);

    await expect(matchUnmappedFields([control], catalog)).resolves.toEqual([
      { selector: '#npi', token: 'provider.npi', confidence: 0.97 },
    ]);
    expect(model.calls).toMatchObject({
      currentAvailability: 1,
      currentCreate: 1,
      prompt: 1,
      legacyCapabilities: 0,
      legacyCreate: 0,
      destroy: 1,
    });
    expect(model.sessions[0]?.destroyed).toBe(true);
  });

  it('falls back to the legacy API only when the current API is not ready', async () => {
    const model = new MockNanoModel({
      availability: 'downloadable',
      legacyAvailable: 'readily',
      outputs: [validResponse],
    });
    installModel(model);

    await expect(matchUnmappedFields([control], catalog)).resolves.toEqual([
      { selector: '#npi', token: 'provider.npi', confidence: 0.97 },
    ]);
    expect(model.calls).toMatchObject({
      currentAvailability: 1,
      currentCreate: 0,
      legacyCapabilities: 1,
      legacyCreate: 1,
      prompt: 1,
      destroy: 1,
    });
  });

  it.each(['unavailable', 'downloadable', 'downloading'] as const)(
    'does not create a current model when availability is %s',
    async (availability) => {
      const model = new MockNanoModel({
        availability,
        legacyAvailable: 'after-download',
      });
      installModel(model);

      await expect(canUseNano()).resolves.toBe(false);
      await expect(matchUnmappedFields([control], catalog)).resolves.toEqual([]);
      expect(model.calls.currentCreate).toBe(0);
      expect(model.calls.legacyCreate).toBe(0);
    },
  );

  it('reports the legacy model ready only for the readily capability state', async () => {
    const model = new MockNanoModel({ legacyAvailable: 'readily' });
    installModel(model, { current: false });
    await expect(canUseNano()).resolves.toBe(true);

    vi.stubGlobal('window', { ai: { languageModel: new MockNanoModel({
      legacyAvailable: 'after-download',
    }).legacy } } as Window);
    await expect(canUseNano()).resolves.toBe(false);
  });

  it('rejects malformed JSON, extra keys, invalid confidence, and out-of-catalog matches', async () => {
    const badResponses = [
      '```json\n[]\n```',
      JSON.stringify([{ selector: '#npi', token: 'provider.npi', confidence: 0.9, debug: true }]),
      JSON.stringify([{ selector: '#npi', token: 'provider.npi', confidence: 1.1 }]),
      '[{"selector":"#npi","token":"provider.npi","confidence":1e999}]',
      JSON.stringify([{ selector: '#other', token: 'provider.npi', confidence: 0.9 }]),
      JSON.stringify([{ selector: '#npi', token: 'provider.dob', confidence: 0.9 }]),
      'x'.repeat(NANO_LIMITS.maxResponseCharacters + 1),
    ];

    for (const response of badResponses) {
      const model = new MockNanoModel({ outputs: [response] });
      installModel(model, { legacy: false });
      await expect(matchUnmappedFields([control], catalog)).resolves.toEqual([]);
    }
  });

  it('projects only safe fields, deduplicates input selectors, and rejects duplicate output selectors', async () => {
    const model = new MockNanoModel({ outputs: [validResponse] });
    installModel(model, { legacy: false });
    const withSecret = { ...control, value: 'provider-value-must-not-leave-caller' } as ControlSummary;

    await expect(matchUnmappedFields([withSecret, control], catalog)).resolves.toEqual([
      { selector: '#npi', token: 'provider.npi', confidence: 0.97 },
    ]);
    expect(promptControls(model)).toHaveLength(1);
    expect(String(model.promptInputs[0])).not.toContain('provider-value-must-not-leave-caller');

    const duplicateOutput = JSON.stringify([
      { selector: '#npi', token: 'provider.npi', confidence: 0.97 },
      { selector: '#npi', token: 'provider.firstName', confidence: 0.9 },
    ]);
    const secondModel = new MockNanoModel({ outputs: [duplicateOutput] });
    installModel(secondModel, { legacy: false });
    await expect(matchUnmappedFields([control], catalog)).resolves.toEqual([]);
  });

  it('bounds control and token inputs before prompting', async () => {
    const controls = Array.from({ length: NANO_LIMITS.maxControls + 10 }, (_, index) => ({
      ...control,
      selector: `#field-${index}`,
    }));
    const tokens = Array.from(
      { length: NANO_LIMITS.maxTokens + 10 },
      (_, index) => `provider.field${index}`,
    );
    const model = new MockNanoModel({ outputs: ['[]'] });
    installModel(model, { legacy: false });

    await expect(matchUnmappedFields(controls, tokens)).resolves.toEqual([]);
    expect(promptControls(model)).toHaveLength(NANO_LIMITS.maxControls);
    expect(promptTokens(model)).toHaveLength(NANO_LIMITS.maxTokens);
    expect(String(model.promptInputs[0]).length).toBeLessThanOrEqual(
      NANO_LIMITS.maxPromptCharacters,
    );
  });

  it('admits the current full-size Minted token catalog', async () => {
    const tokens = Array.from({ length: 150 }, (_, index) => `provider.field${index}`);
    const model = new MockNanoModel({ outputs: ['[]'] });
    installModel(model, { legacy: false });

    await expect(matchUnmappedFields([control], tokens)).resolves.toEqual([]);
    expect(promptTokens(model)).toHaveLength(150);
  });

  it('destroys a session after a prompt error', async () => {
    const model = new MockNanoModel({ errors: { prompt: new Error('synthetic failure') } });
    installModel(model, { legacy: false });

    await expect(matchUnmappedFields([control], catalog)).resolves.toEqual([]);
    expect(model.calls.destroy).toBe(1);
    expect(model.sessions[0]?.destroyed).toBe(true);
  });

  it('returns false when availability times out', async () => {
    vi.useFakeTimers();
    const model = new MockNanoModel({ hangs: { availability: true } });
    installModel(model, { legacy: false });
    const result = canUseNano();

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(NANO_LIMITS.availabilityTimeoutMs);
    await expect(result).resolves.toBe(false);
    expect(model.calls.currentCreate).toBe(0);
  });

  it('destroys a session that resolves after create times out', async () => {
    vi.useFakeTimers();
    const model = new MockNanoModel({ hangs: { create: true } });
    installModel(model, { legacy: false });
    const result = matchUnmappedFields([control], catalog);

    await flushMicrotasks();
    expect(model.calls.currentCreate).toBe(1);
    await vi.advanceTimersByTimeAsync(NANO_LIMITS.createTimeoutMs);
    await expect(result).resolves.toEqual([]);

    model.releasePendingCreates();
    await flushMicrotasks();
    expect(model.sessions).toHaveLength(1);
    expect(model.sessions[0]?.destroyed).toBe(true);
    expect(model.calls.destroy).toBe(1);
  });

  it('destroys a session when prompting times out', async () => {
    vi.useFakeTimers();
    const model = new MockNanoModel({ hangs: { prompt: true } });
    installModel(model, { legacy: false });
    const result = matchUnmappedFields([control], catalog);

    await flushMicrotasks();
    expect(model.calls.prompt).toBe(1);
    await vi.advanceTimersByTimeAsync(NANO_LIMITS.promptTimeoutMs);
    await expect(result).resolves.toEqual([]);
    expect(model.calls.destroy).toBe(1);
    expect(model.sessions[0]?.destroyed).toBe(true);
  });

  it('honors caller cancellation without trying the legacy fallback', async () => {
    const model = new MockNanoModel({ hangs: { availability: true } });
    installModel(model);
    const controller = new AbortController();
    const result = canUseNano({ signal: controller.signal });
    controller.abort();

    await expect(result).resolves.toBe(false);
    expect(model.calls.legacyCapabilities).toBe(0);
  });
});
