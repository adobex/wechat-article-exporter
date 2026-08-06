import { cookieStore } from '~/server/utils/CookieStore';

interface DebugQuery {
  key: string;
}

export default defineEventHandler(async event => {
  const { key } = getQuery<DebugQuery>(event);
  const debugKey = process.env.DEBUG_KEY;
  if (!debugKey || typeof key !== 'string' || key !== debugKey) {
    throw createError({ statusCode: 403, statusMessage: 'Invalid debug key' });
  }

  return {
    ...cookieStore.getDebugSummary(),
    mpRequestLoggingEnabled: process.env.NUXT_DEBUG_MP_REQUEST === 'true',
  };
});
