import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const COINS = [
  { id: 'BTC', symbol: 'BTC', nameKo: '비트코인', nameEn: 'Bitcoin', basePrice: 143250000 },
  { id: 'ETH', symbol: 'ETH', nameKo: '이더리움', nameEn: 'Ethereum', basePrice: 5120000 },
  { id: 'XRP', symbol: 'XRP', nameKo: '리플', nameEn: 'Ripple', basePrice: 3280 },
  { id: 'SOL', symbol: 'SOL', nameKo: '솔라나', nameEn: 'Solana', basePrice: 298000 },
  { id: 'DOGE', symbol: 'DOGE', nameKo: '도지코인', nameEn: 'Dogecoin', basePrice: 520 },
  { id: 'ADA', symbol: 'ADA', nameKo: '에이다', nameEn: 'Cardano', basePrice: 1240 },
  { id: 'AVAX', symbol: 'AVAX', nameKo: '아발란체', nameEn: 'Avalanche', basePrice: 52000 },
  { id: 'DOT', symbol: 'DOT', nameKo: '폴카닷', nameEn: 'Polkadot', basePrice: 12800 },
  { id: 'MATIC', symbol: 'MATIC', nameKo: '폴리곤', nameEn: 'Polygon', basePrice: 1580 },
  { id: 'LINK', symbol: 'LINK', nameKo: '체인링크', nameEn: 'Chainlink', basePrice: 28500 },
  { id: 'ATOM', symbol: 'ATOM', nameKo: '코스모스', nameEn: 'Cosmos', basePrice: 18200 },
  { id: 'UNI', symbol: 'UNI', nameKo: '유니스왑', nameEn: 'Uniswap', basePrice: 16800 },
  { id: 'SAND', symbol: 'SAND', nameKo: '샌드박스', nameEn: 'Sandbox', basePrice: 890 },
  { id: 'SHIB', symbol: 'SHIB', nameKo: '시바이누', nameEn: 'Shiba Inu', basePrice: 0.038 },
  { id: 'APT', symbol: 'APT', nameKo: '앱토스', nameEn: 'Aptos', basePrice: 18500 },
];

const INITIAL_HOLDINGS = [
  { coinId: 'BTC', quantity: 0.15, avgPrice: 138000000 },
  { coinId: 'ETH', quantity: 2.5, avgPrice: 4800000 },
  { coinId: 'XRP', quantity: 10000, avgPrice: 3100 },
  { coinId: 'SOL', quantity: 8, avgPrice: 280000 },
  { coinId: 'DOGE', quantity: 50000, avgPrice: 480 },
];

async function main() {
  console.log('Seeding database...');

  // Upsert coins
  for (const coin of COINS) {
    await prisma.coin.upsert({
      where: { id: coin.id },
      update: coin,
      create: coin,
    });
  }
  console.log(`Seeded ${COINS.length} coins`);

  // Create test user
  const passwordHash = await bcrypt.hash('test1234', 10);
  const user = await prisma.user.upsert({
    where: { email: 'test@cryptomts.com' },
    update: {},
    create: {
      email: 'test@cryptomts.com',
      passwordHash,
      nickname: '테스트유저',
      cash: 15000000,
    },
  });
  console.log(`Seeded test user: ${user.email}`);

  // Create initial holdings
  for (const holding of INITIAL_HOLDINGS) {
    await prisma.holding.upsert({
      where: {
        userId_coinId: { userId: user.id, coinId: holding.coinId },
      },
      update: {
        quantity: holding.quantity,
        avgPrice: holding.avgPrice,
      },
      create: {
        userId: user.id,
        coinId: holding.coinId,
        quantity: holding.quantity,
        avgPrice: holding.avgPrice,
      },
    });
  }
  console.log(`Seeded ${INITIAL_HOLDINGS.length} initial holdings`);

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
