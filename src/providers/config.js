// Single source of truth for providers and models. Do not hardcode a model name
// anywhere else in the codebase.
import { validateBaseUrl } from '../lib/aiUsage.js';

export const OPENAI_MODEL = 'gpt-5-mini';
export const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

// Every provider speaks one of two protocols: 'anthropic' (the Messages API) or 'openai' (Chat Completions, which most other
// vendors offer too). A preset has a fixed `baseUrl`; `userBaseUrl` means the user may type one; `freeModel` means the model
// id is free text (the listed models are only suggestions, so a new model never needs a release of this extension).
export const PROVIDERS = {
  anthropic: {
    api: 'anthropic',
    userBaseUrl: true,
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
    api: 'openai',
    userBaseUrl: true,
    label: 'OpenAI',
    keyLabel: 'OpenAI API key',
    keyHint: 'Starts with sk-. Create one in the OpenAI dashboard.',
    defaultModel: OPENAI_MODEL,
    models: [
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-5', label: 'GPT-5' },
    ],
  },
  gemini: {
    api: 'openai',
    freeModel: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    label: 'Google Gemini',
    keyLabel: 'Gemini API key',
    keyHint: 'Starts with AIza. Create one in Google AI Studio (aistudio.google.com/apikey).',
    keyPlaceholder: 'AIza...',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro - best quality' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash - fast and capable' },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite - cheapest' },
    ],
  },
  deepseek: {
    api: 'openai',
    freeModel: true,
    baseUrl: 'https://api.deepseek.com',
    label: 'DeepSeek',
    keyLabel: 'DeepSeek API key',
    keyHint: 'Starts with sk-. Create one on the DeepSeek platform (platform.deepseek.com).',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek Chat - general and tools' },
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner - slower, thinks first' },
    ],
  },
  xai: {
    api: 'openai',
    freeModel: true,
    baseUrl: 'https://api.x.ai/v1',
    label: 'xAI (Grok)',
    keyLabel: 'xAI API key',
    keyHint: 'Starts with xai-. Create one in the xAI console.',
    keyPlaceholder: 'xai-...',
    defaultModel: 'grok-4',
    models: [{ id: 'grok-4', label: 'Grok 4' }],
  },
  mistral: {
    api: 'openai',
    freeModel: true,
    baseUrl: 'https://api.mistral.ai/v1',
    label: 'Mistral',
    keyLabel: 'Mistral API key',
    keyHint: 'Create one in the Mistral console (console.mistral.ai).',
    defaultModel: 'mistral-large-latest',
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large' },
      { id: 'codestral-latest', label: 'Codestral - code' },
    ],
  },
  groq: {
    api: 'openai',
    freeModel: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    label: 'Groq',
    keyLabel: 'Groq API key',
    keyHint: 'Starts with gsk_. Create one in the Groq console (console.groq.com).',
    keyPlaceholder: 'gsk_...',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B - very fast' }],
  },
  openrouter: {
    api: 'openai',
    freeModel: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    label: 'OpenRouter',
    keyLabel: 'OpenRouter API key',
    keyHint: 'Starts with sk-or-. One key for hundreds of models from many vendors (openrouter.ai/keys).',
    keyPlaceholder: 'sk-or-...',
    defaultModel: 'anthropic/claude-sonnet-5-5',
    models: [
      { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5 via OpenRouter' },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro via OpenRouter' },
      { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat via OpenRouter' },
    ],
  },
  ollama: {
    api: 'openai',
    freeModel: true,
    keyOptional: true,
    baseUrl: 'http://localhost:11434/v1',
    label: 'Ollama (on this computer)',
    keyLabel: 'Key (not needed for Ollama)',
    keyHint: 'Leave empty. Nothing leaves this computer. Start Ollama first and pull a model, for example: ollama pull llama3.1.',
    defaultModel: 'llama3.1',
    models: [
      { id: 'llama3.1', label: 'Llama 3.1' },
      { id: 'qwen2.5-coder', label: 'Qwen 2.5 Coder - code' },
    ],
  },
  custom: {
    api: 'openai',
    userBaseUrl: true,
    freeModel: true,
    label: 'Other (OpenAI-compatible)',
    keyLabel: 'API key',
    keyHint: 'The key your provider gave you. Leave empty for a server on this computer that needs none.',
    defaultModel: '',
    models: [],
  },
};

/** The protocol a provider speaks. */
export const apiOf = (provider) => PROVIDERS[provider]?.api || 'anthropic';

export const DEFAULT_PROVIDER = 'anthropic';

export const STORAGE_KEYS = {
  openaiKey: 'mysnowbuddy_openai_key',
  anthropicKey: 'mysnowbuddy_anthropic_key',
  provider: 'mysnowbuddy_provider',
  models: 'mysnowbuddy_models',
  // Custom endpoints: an OpenAI-compatible server (xAI, OpenRouter, Azure gateway, Ollama...) or an Anthropic proxy.
  openaiBaseUrl: 'mysnowbuddy_openai_base_url',
  anthropicBaseUrl: 'mysnowbuddy_anthropic_base_url',
};

// Anthropic and OpenAI keep the keys of earlier versions; the others are stored per provider.
export const keyStorageFor = (provider) => (provider === 'openai' ? STORAGE_KEYS.openaiKey : provider === 'anthropic' ? STORAGE_KEYS.anthropicKey : `mysnowbuddy_key_${provider}`);
export const baseUrlStorageFor = (provider) => (provider === 'openai' ? STORAGE_KEYS.openaiBaseUrl : provider === 'anthropic' ? STORAGE_KEYS.anthropicBaseUrl : `mysnowbuddy_base_url_${provider}`);
/** The address calls go to: a preset's fixed one, or what the user typed for a provider that allows it ('' = the vendor's own API). */
export const effectiveBaseUrl = (provider, typed = '') => validateBaseUrl(PROVIDERS[provider]?.baseUrl || (PROVIDERS[provider]?.userBaseUrl ? typed : ''));

// Shared settings object (src/content/storage.js): prompt caching is on unless switched off.
const SETTINGS_KEY = 'mysnowbuddy_settings';

/**
 * Resolve the active { provider, model, apiKey, baseUrl, keyOptional, promptCache } from a chrome.storage.local snapshot.
 * With a custom base URL the model id is free text (whatever that server calls its model); without one it must be a listed model.
 */
export function resolveProviderConfig(stored = {}) {
  const provider = PROVIDERS[stored[STORAGE_KEYS.provider]] ? stored[STORAGE_KEYS.provider] : null;
  // Existing installs only have an OpenAI key; keep them working without a settings visit.
  const inferred =
    provider ||
    (stored[STORAGE_KEYS.anthropicKey] ? 'anthropic' : stored[STORAGE_KEYS.openaiKey] ? 'openai' : DEFAULT_PROVIDER);
  const models = stored[STORAGE_KEYS.models] || {};
  const def = PROVIDERS[inferred];
  const base = effectiveBaseUrl(inferred, stored[baseUrlStorageFor(inferred)]);
  const baseUrl = base.ok ? base.url : '';
  const known = def.models.some((m) => m.id === models[inferred]);
  const custom = baseUrl && typeof models[inferred] === 'string' && models[inferred].trim() ? models[inferred].trim() : '';
  return {
    provider: inferred,
    model: custom || (known ? models[inferred] : PROVIDERS[inferred].defaultModel),
    apiKey: stored[keyStorageFor(inferred)] || '',
    baseUrl,
    // A server on this machine (Ollama, LM Studio) usually needs no key.
    keyOptional: Boolean(def.keyOptional || (baseUrl && base.local && def.api === 'openai')),
    promptCache: stored[SETTINGS_KEY]?.promptCache !== false,
  };
}
