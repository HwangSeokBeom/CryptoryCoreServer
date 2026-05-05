import { sanitizeSensitiveDetails, sanitizeSensitiveText } from '../domains/security/credential-security.service';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>,
    public code?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function createErrorResponse(error: string, details?: Record<string, unknown>, code?: string) {
  const message = sanitizeSensitiveText(error) ?? error;
  return {
    success: false as const,
    message,
    error: message,
    code: code ?? 'REQUEST_FAILED',
    ...(details ? { details: sanitizeSensitiveDetails(details) } : {}),
  };
}

export function createSuccessResponse<T>(data: T) {
  return { success: true as const, data };
}

function getObjectProperty(error: unknown, property: string) {
  if (!error || typeof error !== 'object' || !(property in error)) {
    return undefined;
  }

  return (error as Record<string, unknown>)[property];
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : '';
}

function getPrismaErrorCode(error: unknown) {
  const code = getObjectProperty(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function extractMissingSchemaObject(error: unknown) {
  const meta = getObjectProperty(error, 'meta');
  if (meta && typeof meta === 'object' && 'target' in meta) {
    const target = (meta as { target?: unknown }).target;
    if (typeof target === 'string') {
      return target;
    }
    if (Array.isArray(target) && target.every((item) => typeof item === 'string')) {
      return target.join('.');
    }
  }

  const match = getErrorMessage(error).match(/`([^`]+)` does not exist in the current database/i);
  return match?.[1];
}

export function isDatabaseSchemaMismatchError(error: unknown) {
  const code = getPrismaErrorCode(error);
  if (code === 'P2021' || code === 'P2022') {
    return true;
  }

  return /does not exist in the current database/i.test(getErrorMessage(error));
}

export function mapInfrastructureError(error: unknown) {
  if (!isDatabaseSchemaMismatchError(error)) {
    return null;
  }

  const details =
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          prismaCode: getPrismaErrorCode(error) ?? 'unknown',
          missingObject: extractMissingSchemaObject(error) ?? 'unknown',
          hint: 'Run `npx prisma migrate dev --schema prisma/schema.prisma` and `npx prisma generate`.',
        };

  return new AppError(
    503,
    '데이터베이스 스키마가 서버 코드와 일치하지 않습니다. 마이그레이션 적용 상태를 확인해 주세요.',
    details,
    'DATABASE_SCHEMA_MISMATCH',
  );
}
