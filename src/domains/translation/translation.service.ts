import { createHash } from 'crypto';
import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { RestClient } from '../../core/exchange/rest.client';
import { AppError } from '../../utils/errors';
import { isDatabaseSchemaMismatchError } from '../../utils/errors';
import { logger } from '../../utils/logger';

export type TranslationContext = 'coin_description' | 'news_title' | 'news_summary' | 'general';

export type TranslationResult = {
  id?: string;
  originalText?: string;
  sourceLanguage: string;
  targetLanguage: string;
  translatedText: string | null;
  provider: string;
  cached: boolean;
  updatedAt: string;
  status?: 'translated' | 'original_only' | 'failed';
  reason?: string | null;
};

type OpenAiTranslationResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    } | null;
  }>;
};

const translationCache = new Map<string, TranslationResult>();
let lastLoggedProviderKey: string | null = null;

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cacheKey(params: { text: string; sourceLanguage: string; targetLanguage: string }) {
  return createHash('sha256')
    .update(params.sourceLanguage)
    .update('\0')
    .update(params.targetLanguage)
    .update('\0')
    .update(params.text)
    .digest('hex');
}

function normalizeCacheText(value: string) {
  return stripHtml(value).replace(/\s+/g, ' ').trim();
}

async function readCachedTranslation(params: {
  key: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
}) {
  const memory = translationCache.get(params.key);
  if (memory) {
    return { ...memory, cached: true, provider: 'cache' };
  }
  if (process.env.NODE_ENV === 'test') {
    return null;
  }

  try {
    const row = await prisma.translationCache.findUnique({
      where: {
        sourceLanguage_targetLanguage_originalHash: {
          sourceLanguage: params.sourceLanguage,
          targetLanguage: params.targetLanguage,
          originalHash: params.key,
        },
      },
    });
    if (!row) {
      return null;
    }
    const cached: TranslationResult = {
      originalText: row.originalText,
      sourceLanguage: row.sourceLanguage,
      targetLanguage: row.targetLanguage,
      translatedText: row.translatedText,
      provider: 'cache',
      cached: true,
      updatedAt: row.updatedAt.toISOString(),
      status: row.translatedText ? 'translated' : 'original_only',
      reason: row.translatedText ? null : 'TRANSLATION_ORIGINAL_ONLY',
    };
    translationCache.set(params.key, { ...cached, provider: row.provider, cached: false });
    return cached;
  } catch (error) {
    if (!isDatabaseSchemaMismatchError(error)) {
      logger.warn(
        { domain: 'translation', action: 'cache_read_failed', err: error },
        '[TranslateCache] action=read status=failed',
      );
    }
    return null;
  }
}

async function writeCachedTranslation(params: {
  key: string;
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  translatedText: string | null;
  provider: string;
  updatedAt: string;
}) {
  const result: TranslationResult = {
    originalText: params.text,
    sourceLanguage: params.sourceLanguage,
    targetLanguage: params.targetLanguage,
    translatedText: params.translatedText,
    provider: params.provider,
    cached: false,
    updatedAt: params.updatedAt,
    status: params.translatedText ? 'translated' : 'original_only',
    reason: params.translatedText ? null : 'TRANSLATION_ORIGINAL_ONLY',
  };
  translationCache.set(params.key, result);
  if (process.env.NODE_ENV === 'test') {
    return result;
  }

  try {
    await prisma.translationCache.upsert({
      where: {
        sourceLanguage_targetLanguage_originalHash: {
          sourceLanguage: params.sourceLanguage,
          targetLanguage: params.targetLanguage,
          originalHash: params.key,
        },
      },
      create: {
        sourceLanguage: params.sourceLanguage,
        targetLanguage: params.targetLanguage,
        originalHash: params.key,
        originalText: params.text,
        translatedText: params.translatedText,
        provider: params.provider,
      },
      update: {
        originalText: params.text,
        translatedText: params.translatedText,
        provider: params.provider,
      },
    });
  } catch (error) {
    if (!isDatabaseSchemaMismatchError(error)) {
      logger.warn(
        { domain: 'translation', action: 'cache_write_failed', err: error },
        '[TranslateCache] action=write status=failed',
      );
    }
  }
  return result;
}

export function getConfiguredTranslationProvider() {
  const provider = env.TRANSLATION_PROVIDER;
  if (!provider) {
    return null;
  }
  if (provider === 'openai' && !env.OPENAI_API_KEY) {
    return null;
  }
  if (provider === 'papago' && (!env.PAPAGO_CLIENT_ID || !env.PAPAGO_CLIENT_SECRET)) {
    return null;
  }
  if (provider === 'google' && !env.GOOGLE_TRANSLATE_API_KEY) {
    return null;
  }
  return provider;
}

export function getTranslationProviderStatus() {
  const configuredProvider = getConfiguredTranslationProvider();
  const configured = Boolean(configuredProvider);
  const requestedProvider = env.TRANSLATION_PROVIDER ?? null;
  const reason = configured
    ? null
    : requestedProvider
      ? 'TRANSLATION_PROVIDER_CREDENTIALS_MISSING'
      : 'TRANSLATION_PROVIDER_NOT_CONFIGURED';

  return {
    configured,
    provider: configuredProvider ?? requestedProvider,
    reason,
  };
}

function logTranslateConfig() {
  const status = getTranslationProviderStatus();
  const key = `${status.provider ?? 'none'}:${status.configured}:${status.reason ?? 'ok'}`;
  if (lastLoggedProviderKey === key) {
    return;
  }
  lastLoggedProviderKey = key;
  logger.info(
    {
      domain: 'translation',
      provider: status.provider,
      configured: status.configured,
      reason: status.reason,
    },
    `[TranslateConfig] provider=${status.provider ?? ''} configured=${status.configured} reason=${status.reason ?? ''}`,
  );
}

function providerBaseUrl(provider: string) {
  if (env.TRANSLATION_API_BASE_URL) {
    return env.TRANSLATION_API_BASE_URL;
  }
  if (provider === 'openai') {
    return 'https://api.openai.com/v1';
  }
  if (provider === 'papago') {
    return 'https://openapi.naver.com';
  }
  return 'https://translation.googleapis.com';
}

async function translateWithOpenAi(params: {
  text: string;
  sourceLanguage: string;
  targetLanguage: string;
  context: TranslationContext;
}) {
  const client = new RestClient('translation', providerBaseUrl('openai'));
  const response = await client.request<OpenAiTranslationResponse>('/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    json: {
      model: env.TRANSLATION_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: 'Translate accurately for a Korean cryptocurrency app. Return only the translated text.',
        },
        {
          role: 'user',
          content: `source=${params.sourceLanguage}\ntarget=${params.targetLanguage}\ncontext=${params.context}\n\n${params.text}`,
        },
      ],
    },
    timeoutMs: env.LLM_TIMEOUT_MS,
    retryPolicy: { maxAttempts: 1 },
  });
  return response.choices?.[0]?.message?.content?.trim() || null;
}

async function translateWithPapago(params: { text: string; sourceLanguage: string; targetLanguage: string }) {
  const client = new RestClient('translation', providerBaseUrl('papago'));
  const response = await client.request<{ message?: { result?: { translatedText?: string | null } | null } | null }>('/v1/papago/n2mt', {
    method: 'POST',
    headers: {
      'X-Naver-Client-Id': env.PAPAGO_CLIENT_ID ?? '',
      'X-Naver-Client-Secret': env.PAPAGO_CLIENT_SECRET ?? '',
    },
    form: {
      source: params.sourceLanguage,
      target: params.targetLanguage,
      text: params.text,
    },
    timeoutMs: 5000,
    retryPolicy: { maxAttempts: 1 },
  });
  return response.message?.result?.translatedText?.trim() || null;
}

async function translateWithGoogle(params: { text: string; sourceLanguage: string; targetLanguage: string }) {
  const client = new RestClient('translation', providerBaseUrl('google'));
  const response = await client.request<{ data?: { translations?: Array<{ translatedText?: string | null }> } }>('/language/translate/v2', {
    method: 'POST',
    query: { key: env.GOOGLE_TRANSLATE_API_KEY },
    json: {
      q: params.text,
      source: params.sourceLanguage,
      target: params.targetLanguage,
      format: 'text',
    },
    timeoutMs: 5000,
    retryPolicy: { maxAttempts: 1 },
  });
  return response.data?.translations?.[0]?.translatedText?.trim() || null;
}

export async function translateText(params: {
  text: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  context?: TranslationContext;
  symbol?: string | null;
}): Promise<TranslationResult> {
  const sourceLanguage = params.sourceLanguage?.trim().toLowerCase() || 'en';
  const targetLanguage = params.targetLanguage?.trim().toLowerCase() || 'ko';
  const context = params.context ?? 'general';
  const text = normalizeCacheText(params.text);
  const textLength = text.length;
  logTranslateConfig();
  const provider = getConfiguredTranslationProvider();

  if (!provider) {
    logger.warn(
      { domain: 'translation', context, sourceLanguage, targetLanguage, textLength, provider: env.TRANSLATION_PROVIDER ?? null, cached: false, status: 503 },
      `[Translate] context=${context} sourceLanguage=${sourceLanguage} targetLanguage=${targetLanguage} textLength=${textLength} provider=${env.TRANSLATION_PROVIDER ?? ''} cached=false status=503`,
    );
    throw new AppError(503, '번역 제공자가 설정되어 있지 않습니다', undefined, 'TRANSLATION_PROVIDER_NOT_CONFIGURED');
  }

  if (!text) {
    throw new AppError(400, 'text is required', { field: 'text' }, 'INVALID_TRANSLATION_TEXT');
  }
  if (textLength > env.TRANSLATION_MAX_TEXT_LENGTH) {
    throw new AppError(400, 'text is too long to translate in one request', {
      maxLength: env.TRANSLATION_MAX_TEXT_LENGTH,
      policy: 'Split long descriptions into server-sized chunks before retrying.',
    }, 'TRANSLATION_TEXT_TOO_LONG');
  }

  const key = cacheKey({ text, sourceLanguage, targetLanguage });
  const cached = await readCachedTranslation({ key, text, sourceLanguage, targetLanguage });
  if (cached) {
    const result = { ...cached, cached: true };
    logger.info(
      { domain: 'translation', context, sourceLanguage, targetLanguage, textLength, provider, cached: true, status: 200 },
      `[Translate] context=${context} sourceLanguage=${sourceLanguage} targetLanguage=${targetLanguage} textLength=${textLength} provider=${provider} cached=true status=200`,
    );
    return result;
  }

  let translatedText: string | null = null;
  try {
    if (provider === 'openai') {
      translatedText = await translateWithOpenAi({ text, sourceLanguage, targetLanguage, context });
    } else if (provider === 'papago') {
      translatedText = await translateWithPapago({ text, sourceLanguage, targetLanguage });
    } else {
      translatedText = await translateWithGoogle({ text, sourceLanguage, targetLanguage });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'translation provider request failed';
    logger.warn(
      { domain: 'translation', provider, code: 'TRANSLATION_PROVIDER_FAILED', message, err: error },
      `[TranslateFailure] provider=${provider} code=TRANSLATION_PROVIDER_FAILED message=${message}`,
    );
    throw new AppError(502, '번역 제공자 요청에 실패했습니다', { provider }, 'TRANSLATION_PROVIDER_FAILED');
  }

  if (!translatedText) {
    logger.warn(
      { domain: 'translation', provider, code: 'TRANSLATION_PROVIDER_EMPTY_RESPONSE', message: 'empty translatedText' },
      `[TranslateFailure] provider=${provider} code=TRANSLATION_PROVIDER_EMPTY_RESPONSE message=empty translatedText`,
    );
    throw new AppError(502, '번역 제공자 응답을 처리할 수 없습니다', { provider }, 'TRANSLATION_PROVIDER_FAILED');
  }

  const result = await writeCachedTranslation({
    key,
    text,
    sourceLanguage,
    targetLanguage,
    translatedText,
    provider,
    updatedAt: new Date().toISOString(),
  });
  logger.info(
    { domain: 'translation', context, sourceLanguage, targetLanguage, textLength, provider, cached: false, status: 200 },
    `[Translate] context=${context} sourceLanguage=${sourceLanguage} targetLanguage=${targetLanguage} textLength=${textLength} provider=${provider} cached=false status=200`,
  );
  return result;
}

export type TranslationBatchItemInput = {
  id: string;
  text: string;
  sourceLanguage?: string;
};

export type TranslationBatchItem = {
  id: string;
  originalText: string;
  translatedText: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  provider: string;
  cached: boolean;
  status: 'translated' | 'original_only' | 'failed';
  reason: string | null;
};

export async function translateBatch(params: {
  targetLanguage: string;
  items: TranslationBatchItemInput[];
}) {
  const targetLanguage = params.targetLanguage.trim().toLowerCase();
  const items: TranslationBatchItem[] = [];

  for (const item of params.items) {
    const sourceLanguage = item.sourceLanguage?.trim().toLowerCase() || 'en';
    const originalText = normalizeCacheText(item.text);

    if (!originalText) {
      items.push({
        id: item.id,
        originalText: '',
        translatedText: '',
        sourceLanguage,
        targetLanguage,
        provider: 'fallback',
        cached: false,
        status: 'original_only',
        reason: 'EMPTY_TEXT',
      });
      continue;
    }

    if (originalText.length > env.TRANSLATION_MAX_TEXT_LENGTH) {
      items.push({
        id: item.id,
        originalText,
        translatedText: null,
        sourceLanguage,
        targetLanguage,
        provider: 'fallback',
        cached: false,
        status: 'failed',
        reason: 'TRANSLATION_TEXT_TOO_LONG',
      });
      continue;
    }

    const key = cacheKey({ text: originalText, sourceLanguage, targetLanguage });
    const cached = await readCachedTranslation({ key, text: originalText, sourceLanguage, targetLanguage });
    if (cached) {
      items.push({
        id: item.id,
        originalText,
        translatedText: cached.translatedText,
        sourceLanguage,
        targetLanguage,
        provider: 'cache',
        cached: true,
        status: cached.translatedText ? 'translated' : 'original_only',
        reason: cached.translatedText ? null : 'TRANSLATION_ORIGINAL_ONLY',
      });
      continue;
    }

    try {
      const translated = await translateText({
        text: originalText,
        sourceLanguage,
        targetLanguage,
        context: 'general',
      });
      items.push({
        id: item.id,
        originalText,
        translatedText: translated.translatedText,
        sourceLanguage,
        targetLanguage,
        provider: translated.provider,
        cached: translated.cached,
        status: translated.translatedText ? 'translated' : 'original_only',
        reason: translated.translatedText ? null : translated.reason ?? 'TRANSLATION_ORIGINAL_ONLY',
      });
    } catch (error) {
      const fallback = await writeCachedTranslation({
        key,
        text: originalText,
        sourceLanguage,
        targetLanguage,
        translatedText: null,
        provider: 'fallback',
        updatedAt: new Date().toISOString(),
      });
      const reason = error instanceof AppError ? error.code ?? 'TRANSLATION_FAILED' : 'TRANSLATION_FAILED';
      items.push({
        id: item.id,
        originalText,
        translatedText: originalText,
        sourceLanguage,
        targetLanguage,
        provider: fallback.provider,
        cached: false,
        status: 'original_only',
        reason,
      });
    }
  }

  return { items };
}
