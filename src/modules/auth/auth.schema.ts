import { z } from 'zod';

export const RegisterInput = z.object({
  email: z
    .string({
      required_error: 'INVALID_REQUEST',
      invalid_type_error: 'INVALID_EMAIL_FORMAT',
    })
    .trim()
    .email('INVALID_EMAIL_FORMAT'),
  password: z
    .string({
      required_error: 'INVALID_REQUEST',
      invalid_type_error: 'INVALID_PASSWORD_LENGTH',
    })
    .min(8, 'INVALID_PASSWORD_LENGTH')
    .max(72, 'INVALID_PASSWORD_LENGTH'),
  nickname: z
    .string({
      required_error: 'INVALID_REQUEST',
      invalid_type_error: 'INVALID_REQUEST',
    })
    .trim()
    .min(1, 'INVALID_REQUEST')
    .max(20, 'INVALID_REQUEST'),
});

export const LoginInput = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const AuthUserResponse = z.object({
  id: z.string(),
  email: z.string().email(),
  nickname: z.string(),
  authProvider: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const AuthSessionResponse = z.object({
  user: AuthUserResponse,
  token: z.string().min(1),
});

export type RegisterInputType = z.infer<typeof RegisterInput>;
export type LoginInputType = z.infer<typeof LoginInput>;
export type AuthUserResponseType = z.infer<typeof AuthUserResponse>;
export type AuthSessionResponseType = z.infer<typeof AuthSessionResponse>;
