import type {
  ExchangeConnectionCredentials,
  ExchangeConnectionValidationResult,
  ExchangeConnectionValidator,
} from './private-adapter.types';

class PlaceholderExchangeConnectionValidator implements ExchangeConnectionValidator {
  constructor(public readonly exchange: string) {}

  async validate(credentials: ExchangeConnectionCredentials): Promise<ExchangeConnectionValidationResult> {
    if (!credentials.apiKey.trim() || !credentials.secretKey.trim()) {
      return {
        status: 'invalid',
        mode: 'syntactic',
        canUsePrivateApi: false,
        message: 'apiKey and secretKey are required',
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      status: 'placeholder',
      mode: 'placeholder',
      canUsePrivateApi: false,
      message: `Credentials stored for ${this.exchange}, but a live private adapter is not implemented yet.`,
      checkedAt: new Date().toISOString(),
    };
  }
}

const validators = new Map<string, ExchangeConnectionValidator>([
  ['upbit', new PlaceholderExchangeConnectionValidator('upbit')],
  ['bithumb', new PlaceholderExchangeConnectionValidator('bithumb')],
  ['coinone', new PlaceholderExchangeConnectionValidator('coinone')],
  ['korbit', new PlaceholderExchangeConnectionValidator('korbit')],
  ['binance', new PlaceholderExchangeConnectionValidator('binance')],
]);

export function getExchangeConnectionValidator(exchange: string) {
  return validators.get(exchange) ?? new PlaceholderExchangeConnectionValidator(exchange);
}
