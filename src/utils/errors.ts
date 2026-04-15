export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function createErrorResponse(error: string) {
  return { success: false as const, error };
}

export function createSuccessResponse<T>(data: T) {
  return { success: true as const, data };
}
