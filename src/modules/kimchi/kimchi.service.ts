import { getKimchiPremium as getCanonicalKimchiPremium } from '../../domains/kimchi-premium/kimchi-premium.service';

export async function getKimchiPremium(symbols: string[]) {
  return getCanonicalKimchiPremium(symbols);
}
