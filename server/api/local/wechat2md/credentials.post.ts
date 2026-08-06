import { storeProfileCredentialSnapshot } from '~/server/utils/profile-credential-store';

export default defineEventHandler(async event => {
  if (!useRuntimeConfig(event).public.outputDir) {
    throw createError({ statusCode: 403, statusMessage: 'Local output mode is disabled' });
  }

  const body = await readBody<{ credentials?: unknown }>(event);
  const result = storeProfileCredentialSnapshot(body?.credentials);
  if (!result.applied) setResponseStatus(event, 422);
  return { success: result.applied, ...result };
});
