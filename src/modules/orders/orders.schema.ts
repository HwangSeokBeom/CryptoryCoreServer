import { z } from 'zod';

export const CreateOrderInput = z.object({
  symbol: z.string(),
  exchange: z.string(),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['limit', 'market']),
  price: z.number().optional(),
  quantity: z.number(),
});

export type CreateOrderInputType = z.infer<typeof CreateOrderInput>;
