import { z } from 'zod';

export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  nickname: z.string().min(1).max(20),
});

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string(),
});

export type RegisterInputType = z.infer<typeof RegisterInput>;
export type LoginInputType = z.infer<typeof LoginInput>;
