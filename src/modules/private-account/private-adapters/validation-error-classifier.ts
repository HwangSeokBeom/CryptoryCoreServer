import { ExchangeAuthError, ExchangeRequestError } from '../../../core/exchange/errors';
import { sanitizeSensitiveText } from '../../../domains/security/credential-security.service';
import type { ExchangeConnectionValidationCode } from './private-adapter.types';

type ClassifiedExchangeError = {
  code: ExchangeConnectionValidationCode;
  message: string;
  details: Record<string, unknown>;
};

function buildMessage(defaultMessage: string, rawMessage?: string) {
  const sanitized = sanitizeSensitiveText(rawMessage);
  return sanitized && sanitized !== rawMessage
    ? defaultMessage
    : sanitized || defaultMessage;
}

export function classifyExchangeValidationError(error: unknown): ClassifiedExchangeError {
  if (error instanceof ExchangeRequestError) {
    const rawMessage = error.responseBody ?? error.message;
    const normalized = `${error.message} ${error.responseBody ?? ''}`.toLowerCase();

    if (error.statusCode === 429) {
      return {
        code: 'rate_limited',
        message: '거래소 요청 한도에 도달했습니다.',
        details: {
          upstreamStatus: error.statusCode,
          rawMessage: buildMessage('rate limited', rawMessage),
        },
      };
    }

    if (error.statusCode >= 500) {
      return {
        code: 'exchange_unavailable',
        message: '거래소 응답이 일시적으로 불안정합니다.',
        details: {
          upstreamStatus: error.statusCode,
          rawMessage: buildMessage('exchange unavailable', rawMessage),
        },
      };
    }

    if (/ip|whitelist|white list|allowed ip|등록된 ip/i.test(normalized)) {
      return {
        code: 'ip_not_whitelisted',
        message: '허용된 IP 설정이 올바르지 않습니다.',
        details: {
          upstreamStatus: error.statusCode,
          rawMessage: buildMessage('ip restriction', rawMessage),
        },
      };
    }

    if (/permission|scope|out_of_scope|forbidden|not allowed/i.test(normalized)) {
      return {
        code: 'insufficient_permissions',
        message: 'API 키 권한이 부족합니다.',
        details: {
          upstreamStatus: error.statusCode,
          rawMessage: buildMessage('insufficient permissions', rawMessage),
        },
      };
    }

    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        code: 'insufficient_permissions',
        message: 'API 키 권한이 부족합니다.',
        details: {
          upstreamStatus: error.statusCode,
          rawMessage: buildMessage('insufficient permissions', rawMessage),
        },
      };
    }

    if (/signature|jwt|nonce|query_hash|invalid signature|signature for this request/i.test(normalized)) {
      return {
        code: 'signature_error',
        message: '서명 또는 인증 포맷이 올바르지 않습니다.',
        details: {
          upstreamStatus: error.statusCode,
          rawMessage: buildMessage('signature error', rawMessage),
        },
      };
    }

    if (/invalid|unauthorized|apikey|api-key|access key|secret key|token/i.test(normalized)) {
      return {
        code: 'invalid_credentials',
        message: 'API 키 또는 시크릿이 올바르지 않습니다.',
        details: {
          upstreamStatus: error.statusCode,
          rawMessage: buildMessage('invalid credentials', rawMessage),
        },
      };
    }

    return {
      code: 'unknown_error',
      message: '거래소 인증 검증에 실패했습니다.',
      details: {
        upstreamStatus: error.statusCode,
        rawMessage: buildMessage('unknown request error', rawMessage),
      },
    };
  }

  if (error instanceof ExchangeAuthError) {
    const normalized = error.message.toLowerCase();
    if (/ip|whitelist|white list|allowed ip|등록된 ip/i.test(normalized)) {
      return {
        code: 'ip_not_whitelisted',
        message: '허용된 IP 설정이 올바르지 않습니다.',
        details: { rawMessage: sanitizeSensitiveText(error.message) ?? 'ip restriction' },
      };
    }

    if (/permission|scope|out_of_scope|forbidden/i.test(normalized)) {
      return {
        code: 'insufficient_permissions',
        message: 'API 키 권한이 부족합니다.',
        details: { rawMessage: sanitizeSensitiveText(error.message) ?? 'insufficient permissions' },
      };
    }

    if (/signature|jwt|nonce|query_hash|invalid signature/i.test(normalized)) {
      return {
        code: 'signature_error',
        message: '서명 또는 인증 포맷이 올바르지 않습니다.',
        details: { rawMessage: sanitizeSensitiveText(error.message) ?? 'signature error' },
      };
    }

    if (/timeout|aborted|timed out/i.test(normalized)) {
      return {
        code: 'timeout',
        message: '거래소 응답 시간이 초과되었습니다.',
        details: { rawMessage: sanitizeSensitiveText(error.message) ?? 'timeout' },
      };
    }

    return {
      code: 'invalid_credentials',
      message: 'API 키 또는 시크릿이 올바르지 않습니다.',
      details: { rawMessage: sanitizeSensitiveText(error.message) ?? 'invalid credentials' },
    };
  }

  if (error instanceof Error) {
    const normalized = error.message.toLowerCase();
    if (/timeout|aborted|timed out/i.test(normalized)) {
      return {
        code: 'timeout',
        message: '거래소 응답 시간이 초과되었습니다.',
        details: { rawMessage: sanitizeSensitiveText(error.message) ?? 'timeout' },
      };
    }

    return {
      code: 'unknown_error',
      message: '거래소 인증 검증 중 알 수 없는 오류가 발생했습니다.',
      details: { rawMessage: sanitizeSensitiveText(error.message) ?? 'unknown error' },
    };
  }

  return {
    code: 'unknown_error',
    message: '거래소 인증 검증 중 알 수 없는 오류가 발생했습니다.',
    details: {},
  };
}
