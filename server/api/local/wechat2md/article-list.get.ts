import { normalizeProfileGetMsgResponse } from '#shared/utils/profile-ext';
import { getProfileCredential } from '~/server/utils/profile-credential-store';
import { clampProfilePageValue, requestProfileGetMsg } from '~/server/utils/profile-ext';

export default defineEventHandler(async event => {
  if (!useRuntimeConfig(event).public.outputDir) {
    throw createError({ statusCode: 403, statusMessage: 'Local output mode is disabled' });
  }

  const query = getQuery<{ id?: string; begin?: string; size?: string }>(event);
  const id = typeof query.id === 'string' ? query.id.trim() : '';
  const credential = id ? getProfileCredential(id) : null;
  if (!credential) {
    return {
      source: 'profile_ext',
      base_resp: { ret: -2, err_msg: 'credential unavailable or expired' },
      articles: [],
      can_continue: false,
      next_offset: 0,
      message_count: 0,
    };
  }

  try {
    const currentOffset = clampProfilePageValue(query.begin, 0, 0, 1_000_000);
    const response = await requestProfileGetMsg(event, credential, query.begin, query.size);
    return normalizeProfileGetMsgResponse(response, currentOffset);
  } catch {
    return {
      source: 'profile_ext',
      base_resp: { ret: -1, err_msg: 'profile_ext request failed' },
      articles: [],
      can_continue: false,
      next_offset: 0,
      message_count: 0,
    };
  }
});
