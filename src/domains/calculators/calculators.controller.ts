import type { FastifyReply, FastifyRequest } from 'fastify';
import { createSuccessResponse } from '../../utils/errors';
import { calculatorsService } from './calculators.service';

export async function getUsdtRateController(_request: FastifyRequest, _reply: FastifyReply) {
  return createSuccessResponse(await calculatorsService.getUsdtRate());
}
