export function planAfterLocalReconciliation(localCanonicalRecords: number) {
  return {
    action: 'continue-public-discovery',
    localCanonicalRecords: Math.max(0, localCanonicalRecords),
    nextSource: 'public_index',
  } as const;
}

export function planAfterPublicSourceFailure(localCanonicalRecords: number) {
  if (localCanonicalRecords > 0) {
    return {
      action: 'finish-local-partial',
    } as const;
  }
  return {
    action: 'probe-complete-source',
    nextSource: 'appmsgpublish',
  } as const;
}
