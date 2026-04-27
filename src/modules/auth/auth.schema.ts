import { z } from 'zod';

function optionalTrimmedString(max: number) {
  return z.preprocess(
    (value) => (value === null || value === undefined || value === '' ? undefined : value),
    z.string().trim().max(max).optional(),
  );
}

const OptionalEmail = z.preprocess(
  (value) => (value === null || value === undefined || value === '' ? undefined : value),
  z.string().trim().email().optional(),
);

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

export const RefreshTokenInput = z.object({
  refreshToken: z.string().min(20),
});

export const LogoutInput = z.object({
  refreshToken: z.string().min(20).optional(),
  logoutAll: z.boolean().optional(),
}).optional();

export const GoogleLoginInput = z.object({
  idToken: z.string().min(20).optional(),
  accessToken: z.string().min(1).optional(),
  credential: z.string().min(20).optional(),
  deviceId: z.string().trim().max(128).optional(),
}).refine((value) => Boolean(value.idToken ?? value.credential), {
  message: 'GOOGLE_ID_TOKEN_REQUIRED',
  path: ['idToken'],
});

export const AppleLoginInput = z.object({
  identityToken: z.string().min(20).optional(),
  idToken: z.string().min(20).optional(),
  authorizationCode: optionalTrimmedString(2048),
  fullName: optionalTrimmedString(80),
  email: OptionalEmail,
  givenName: optionalTrimmedString(40),
  familyName: optionalTrimmedString(40),
  deviceId: z.string().trim().max(128).optional(),
}).refine((value) => Boolean(value.identityToken ?? value.idToken), {
  message: 'APPLE_IDENTITY_TOKEN_REQUIRED',
  path: ['identityToken'],
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
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.string(),
  refreshTokenExpiresAt: z.string(),
  sessionId: z.string(),
});

export type RegisterInputType = z.infer<typeof RegisterInput>;
export type LoginInputType = z.infer<typeof LoginInput>;
export type RefreshTokenInputType = z.infer<typeof RefreshTokenInput>;
export type LogoutInputType = z.infer<typeof LogoutInput>;
export type GoogleLoginInputType = z.infer<typeof GoogleLoginInput>;
export type AppleLoginInputType = z.infer<typeof AppleLoginInput>;
export type AuthUserResponseType = z.infer<typeof AuthUserResponse>;
export type AuthSessionResponseType = z.infer<typeof AuthSessionResponse>;
