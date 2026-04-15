import { prisma } from '../../config/database';
import type { ExchangeId, UserExchangeCredentials } from '../../core/exchange/exchange.types';
import { AppError } from '../../utils/errors';
import { decryptSecret } from '../../modules/private-account/exchange-connections.crypto';

export async function getUserExchangeCredentials(
  userId: string,
  exchange: ExchangeId,
): Promise<UserExchangeCredentials> {
  const connection = await prisma.exchangeConnection.findUnique({
    where: {
      userId_exchange: {
        userId,
        exchange,
      },
    },
  });

  if (!connection) {
    throw new AppError(404, `${exchange} credentials are not connected`);
  }

  return {
    exchange,
    apiKey: decryptSecret(connection.apiKeyEncrypted),
    secretKey: decryptSecret(connection.secretKeyEncrypted),
    passphrase: connection.passphraseEncrypted ? decryptSecret(connection.passphraseEncrypted) : null,
  };
}
