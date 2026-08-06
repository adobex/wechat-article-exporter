import { listProfileCredentialStatus } from '~/server/utils/profile-credential-store';

export default defineEventHandler(event => {
  const outputDir = useRuntimeConfig(event).public.outputDir;
  if (!outputDir) {
    throw createError({ statusCode: 403, statusMessage: 'Local output mode is disabled' });
  }

  const credentials = listProfileCredentialStatus();
  return { success: true, outputDir, activeCount: credentials.length, credentials };
});
