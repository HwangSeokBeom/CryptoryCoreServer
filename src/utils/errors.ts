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
  return {
    success: false as const,
    error,
    ...(code ? { code } : {}),
    ...(details ? { details } : {}),
  };
}

export function createSuccessResponse<T>(data: T) {
  return { success: true as const, data };
}
