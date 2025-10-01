/* eslint-disable no-empty */
export async function ensurePersistentStorage() {
  if (typeof window === 'undefined') {
    return;
  }
  const anyNav: any = navigator as any;
  if (!anyNav.storage || typeof anyNav.storage.persist !== 'function') {
    return;
  }
  try {
    const already = await anyNav.storage.persisted?.();
    if (!already) {
      await anyNav.storage.persist();
    }
  } catch {}
}
/* eslint-enable no-empty */
