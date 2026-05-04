import { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { featureFlags } from '../../config/feature-flags';
import { createSuccessResponse } from '../../utils/errors';

function buildAppConfig() {
  const legal = {
    termsUrl: env.TERMS_URL ?? null,
    privacyPolicyUrl: env.PRIVACY_POLICY_URL ?? null,
    supportUrl: env.SUPPORT_URL ?? null,
    accountDeletionGuideUrl: env.ACCOUNT_DELETION_URL ?? null,
    accountDeletionUrl: env.ACCOUNT_DELETION_URL ?? null,
    investmentDisclaimerUrl: env.INVESTMENT_DISCLAIMER_URL ?? null,
    communityPolicyUrl: env.COMMUNITY_POLICY_URL ?? null,
    homepageUrl: env.APP_HOMEPAGE_URL ?? null,
  };

  const missingRequiredLinks = Object.entries(legal)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return {
    appName: 'Cryptory',
    legal,
    appReview: {
      ready: missingRequiredLinks.length === 0,
      missingRequiredLinks,
      mode: featureFlags.appStoreReviewMode ? 'app_store_review' : 'standard',
    },
    features: featureFlags,
    account: {
      registerUrl: '/api/v1/auth/register',
      loginUrl: '/api/v1/auth/login',
      refreshUrl: '/api/v1/auth/refresh',
      logoutUrl: '/api/v1/auth/logout',
      sessionUrl: '/api/v1/auth/session',
      profileUrl: '/api/v1/auth/me',
      deleteAccountUrl: '/api/v1/auth/account',
      deletionPolicy: 'Account deletion revokes all Cryptory sessions, deletes stored social identity links, and allows later re-registration/re-linking.',
    },
    socialLogin: {
      google: {
        enabled: env.GOOGLE_CLIENT_IDS.length > 0,
        clientIds: env.GOOGLE_CLIENT_IDS,
        serverContract: '/api/v1/auth/social/google',
      },
      apple: {
        enabled: env.APPLE_CLIENT_IDS.length > 0,
        clientIds: env.APPLE_CLIENT_IDS,
        serverContract: '/api/v1/auth/social/apple',
      },
    },
  };
}

export async function appConfigRoutes(app: FastifyInstance) {
  app.get('/api/v1/app/config', async () => createSuccessResponse(buildAppConfig()));
  app.get('/api/v1/legal/config', async () => createSuccessResponse(buildAppConfig()));
}
