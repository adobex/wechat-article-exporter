import { describe, expect, test } from 'vitest';
import { planAfterLocalReconciliation, planAfterPublicSourceFailure } from '../shared/utils/account-refresh-plan';

describe('generic account refresh source plan', () => {
  test('continues public discovery even when old canonical local records exist', () => {
    expect(planAfterLocalReconciliation(136)).toEqual({
      action: 'continue-public-discovery',
      localCanonicalRecords: 136,
      nextSource: 'public_index',
    });
  });

  test('keeps verified local results when public discovery fails', () => {
    expect(planAfterPublicSourceFailure(136)).toEqual({ action: 'finish-local-partial' });
  });

  test('uses the authenticated complete source only as the final probe', () => {
    expect(planAfterPublicSourceFailure(0)).toEqual({
      action: 'probe-complete-source',
      nextSource: 'appmsgpublish',
    });
  });
});
