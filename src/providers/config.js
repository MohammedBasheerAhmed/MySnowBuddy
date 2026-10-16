// Single source of truth for providers and models. Do not hardcode a model name
// anywhere else in the codebase.

export const OPENAI_MODEL = 'gpt-5-mini';
export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    keyLabel: 'Anthropic API key',
    keyHint: 'Starts with sk-ant-. Create one in the Anthropic Console.',
    defaultModel: 'claude-opus-5-5',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 - best quality' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 - fast and capable' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 - cheapest' },
    ],
  },
  openai: {
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyHint: 'Starts with sk-. Create one in the OpenAI dashboard.',
    defaultModel: OPENAI_MODEL,
    models: [
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-5', label: 'GPT-5' },
    ],
  },
};

export const DEFAULT_PROVIDER = 'anthropic';

export const STORAGE_KEYS = {
  openaiKey: 'mysnowbuddy_openai_key',
  anthropicKey: 'mysnowbuddy_anthropic_key',
  provider: 'mysnowbuddy_provider',
  models: 'mysnowbuddy_models',
};

export const keyStorageFor = (provider) => (provider === 'openai' ? STORAGE_KEYS.openaiKey : STORAGE_KEYS.anthropicKey);

/** Resolve the active { provider, model, apiKey } from a chrome.storage.local snapshot. */
export function resolveProviderConfig(stored = {}) {
  const provider = PROVIDERS[stored[STORAGE_KEYS.provider]] ? stored[STORAGE_KEYS.provider] : null;
  // Existing installs only have an OpenAI key; keep them working without a settings visit.
  const inferred =
    provider ||
    (stored[STORAGE_KEYS.anthropicKey] ? 'anthropic' : stored[STORAGE_KEYS.openaiKey] ? 'openai' : DEFAULT_PROVIDER);
  const models = stored[STORAGE_KEYS.models] || {};
  const known = PROVIDERS[inferred].models.some((m) => m.id === models[inferred]);
  return {
    provider: inferred,
    model: known ? models[inferred] : PROVIDERS[inferred].defaultModel,
    apiKey: stored[keyStorageFor(inferred)] || '',
  };
}
