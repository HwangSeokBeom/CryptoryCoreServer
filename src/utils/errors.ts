export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function createErrorResponse(error: string, details?: Record<string, unknown>) {
  return details ? { success: false as const, error, details } : { success: false as const, error };
}

export function createSuccessResponse<T>(data: T) {
  return { success: true as const, data };
}
