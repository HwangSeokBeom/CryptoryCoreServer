import type { DomesticExchangeId } from '../../core/exchange/exchange.types';
import { toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import { AppError } from '../../utils/errors';
import { isSupportedKimchiVenue } from './kimchi-premium.service';

const INVALID_REQUEST_CODE = 'INVALID_REQUEST';
const SYMBOL_EXAMPLE = 'BTC,ETH,XRP';
const SYMBOL_FORMAT = 'comma-separated canonical symbols';
const NULL_LIKE_SYMBOL_VALUES = new Set(['all', '*', 'null', 'undefined', 'nil', 'none']);

type KimchiPremiumQueryInput = {
  symbols?: string;
  venue?: string | string[];
  exchange?: string;
  domesticExchange?: string;
  quoteCurrency?: string;
};

type KimchiPremiumQueryParams = {
  symbols: string[];
  venues: DomesticExchangeId[];
  quoteCurrency: 'KRW';
};

export type KimchiSymbolNormalizationFailure = {
  input: string;
  symbol?: string;
  reason: 'explicit_symbols_required' | 'not_canonical' | 'empty_after_normalization';
  retryable: false;
};

export type LenientKimchiPremiumQueryParams = KimchiPremiumQueryParams & {
  requestedSymbolCount: number;
  rejectedSymbols: KimchiSymbolNormalizationFailure[];
};

function invalidRequest(message: string, details: Record<string, unknown>) {
  return new AppError(400, message, {
    code: INVALID_REQUEST_CODE,
    ...details,
  });
}

export function normalizeKimchiSymbols(rawSymbols?: string) {
  if (!rawSymbols || rawSymbols.trim().length === 0) {
    throw invalidRequest('symbols query parameter is required', {
      field: 'symbols',
      reason: 'REQUIRED',
      acceptedFormat: SYMBOL_FORMAT,
      example: SYMBOL_EXAMPLE,
    });
  }

  const rawTokens = rawSymbols.split(',').map((token) => token.trim());
  const rejectedValues = rawTokens
    .filter((token) => token.length > 0)
    .filter((token) => NULL_LIKE_SYMBOL_VALUES.has(token.toLowerCase()));
  if (rejectedValues.length > 0) {
    throw invalidRequest('symbols must contain explicit canonical symbols', {
      field: 'symbols',
      reason: 'EXPLICIT_SYMBOLS_REQUIRED',
      acceptedFormat: SYMBOL_FORMAT,
      example: SYMBOL_EXAMPLE,
      rejectedValues: Array.from(new Set(rejectedValues)),
      availableSymbolsEndpoint: '/market/symbols?exchange=upbit',
    });
  }

  const nonEmptyTokens = rawTokens.filter((token) => token.length > 0);
  const normalizedTokens = nonEmptyTokens.map((token) => token.toUpperCase());
  const nonCanonicalTokens = normalizedTokens
    .map((token) => ({
      value: token,
      canonicalCandidate: toCanonicalSymbol(token),
    }))
    .filter(({ value, canonicalCandidate }) => {
      return value !== canonicalCandidate || !/^[A-Z0-9]+$/.test(value);
    });
  if (nonCanonicalTokens.length > 0) {
    throw invalidRequest('symbols must contain explicit canonical symbols only', {
      field: 'symbols',
      reason: 'CANONICAL_SYMBOLS_ONLY',
      acceptedFormat: SYMBOL_FORMAT,
      example: SYMBOL_EXAMPLE,
      rejectedValues: nonCanonicalTokens,
      comparableSymbolsEndpoint: '/kimchi-premium/comparable-symbols?exchange=upbit',
    });
  }

  const normalized = Array.from(new Set(normalizedTokens));

  if (normalized.length === 0) {
    throw invalidRequest('symbols query parameter is required', {
      field: 'symbols',
      reason: 'EMPTY_AFTER_NORMALIZATION',
      acceptedFormat: SYMBOL_FORMAT,
      example: SYMBOL_EXAMPLE,
    });
  }

  return normalized;
}

export function normalizeKimchiSymbolsLenient(rawSymbols?: string) {
  if (!rawSymbols || rawSymbols.trim().length === 0) {
    throw invalidRequest('symbols query parameter is required', {
      field: 'symbols',
      reason: 'REQUIRED',
      acceptedFormat: SYMBOL_FORMAT,
      example: SYMBOL_EXAMPLE,
    });
  }

  const accepted = new Map<string, string>();
  const rejectedSymbols: KimchiSymbolNormalizationFailure[] = [];
  const rawTokens = rawSymbols.split(',').map((token) => token.trim());

  for (const token of rawTokens) {
    if (token.length === 0) {
      continue;
    }

    if (NULL_LIKE_SYMBOL_VALUES.has(token.toLowerCase())) {
      rejectedSymbols.push({
        input: token,
        reason: 'explicit_symbols_required',
        retryable: false,
      });
      continue;
    }

    const canonical = toCanonicalSymbol(token);
    if (!canonical || !/^[A-Z0-9]+$/.test(canonical)) {
      rejectedSymbols.push({
        input: token,
        symbol: canonical || undefined,
        reason: 'not_canonical',
        retryable: false,
      });
      continue;
    }

    accepted.set(canonical, token);
  }

  const symbols = Array.from(accepted.keys());
  if (symbols.length === 0) {
    throw invalidRequest('symbols must contain at least one canonical symbol', {
      field: 'symbols',
      reason: 'EMPTY_AFTER_NORMALIZATION',
      acceptedFormat: SYMBOL_FORMAT,
      example: SYMBOL_EXAMPLE,
      rejectedSymbols,
    });
  }

  return {
    symbols,
    requestedSymbolCount: rawTokens.filter((token) => token.length > 0).length,
    rejectedSymbols,
  };
}

export function normalizeKimchiVenues(params: Pick<KimchiPremiumQueryInput, 'venue' | 'exchange'>): DomesticExchangeId[] {
  const rawVenueTokens = (Array.isArray(params.venue) ? params.venue : params.venue ? [params.venue] : [])
    .flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const rawExchange = params.exchange?.trim().toLowerCase() ?? '';
  if (rawExchange && rawVenueTokens.length > 0 && !rawVenueTokens.includes(rawExchange)) {
    throw invalidRequest('exchange and venue must resolve to the same domestic venue', {
      field: 'venue',
      reason: 'CONFLICTING_VALUES',
      acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
      venue: rawVenueTokens,
      exchange: rawExchange,
    });
  }

  const tokens = rawVenueTokens.length > 0 ? rawVenueTokens : rawExchange ? [rawExchange] : ['upbit'];
  const invalidVenue = tokens.find((token) => !isSupportedKimchiVenue(token));
  if (invalidVenue) {
    throw invalidRequest(`unsupported domestic venue: ${invalidVenue}`, {
      field: rawExchange ? 'exchange' : 'venue',
      reason: 'UNSUPPORTED_VALUE',
      acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
      rejectedValue: invalidVenue,
    });
  }

  return Array.from(new Set(tokens)) as DomesticExchangeId[];
}

export function normalizeKimchiQuoteCurrency(rawQuoteCurrency?: string): 'KRW' {
  if (!rawQuoteCurrency || rawQuoteCurrency.trim().length === 0) {
    return 'KRW';
  }

  const normalized = rawQuoteCurrency.trim().toUpperCase();
  if (normalized !== 'KRW') {
    throw invalidRequest(`unsupported quoteCurrency: ${rawQuoteCurrency}`, {
      field: 'quoteCurrency',
      reason: 'UNSUPPORTED_VALUE',
      acceptedValues: ['KRW'],
      rejectedValue: rawQuoteCurrency,
    });
  }

  return 'KRW';
}

export function normalizeKimchiPremiumQuery(query: KimchiPremiumQueryInput): KimchiPremiumQueryParams {
  return {
    symbols: normalizeKimchiSymbols(query.symbols),
    venues: normalizeKimchiVenues({
      venue: query.venue,
      exchange: query.domesticExchange ?? query.exchange,
    }),
    quoteCurrency: normalizeKimchiQuoteCurrency(query.quoteCurrency),
  };
}

export function normalizeKimchiPremiumQueryLenient(query: KimchiPremiumQueryInput): LenientKimchiPremiumQueryParams {
  const symbols = normalizeKimchiSymbolsLenient(query.symbols);
  return {
    symbols: symbols.symbols,
    requestedSymbolCount: symbols.requestedSymbolCount,
    rejectedSymbols: symbols.rejectedSymbols,
    venues: normalizeKimchiVenues({
      venue: query.venue,
      exchange: query.domesticExchange ?? query.exchange,
    }),
    quoteCurrency: normalizeKimchiQuoteCurrency(query.quoteCurrency),
  };
}
