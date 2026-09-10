import browser from 'webextension-polyfill';

export interface UserProfile {
  fullName: string;
  enrollmentNo: string;
  phone: string;
  email: string;
  dob: string;
}

export const DEFAULT_PROFILE: UserProfile = {
  fullName: 'Nitin Mali',
  enrollmentNo: '60',
  phone: '9876543210',
  email: 'nitinmali@example.com',
  dob: '2007-05-31',
};

export async function getStoredProfile(): Promise<UserProfile> {
  try {
    const res = await browser.storage.local.get('prahari_user_profile');
    if (res && res['prahari_user_profile']) {
      return { ...DEFAULT_PROFILE, ...(res['prahari_user_profile'] as Partial<UserProfile>) };
    }
  } catch (err) {
    console.warn('[PRAHARI] Error loading profile from storage:', err);
  }
  return DEFAULT_PROFILE;
}

export async function saveStoredProfile(profile: UserProfile): Promise<void> {
  try {
    await browser.storage.local.set({ prahari_user_profile: profile });
  } catch (err) {
    console.error('[PRAHARI] Error saving profile to storage:', err);
  }
}

export async function getSavedFields(): Promise<Record<string, string>> {
  try {
    const res = await browser.storage.local.get('prahari_saved_fields');
    if (res && res['prahari_saved_fields'] && typeof res['prahari_saved_fields'] === 'object') {
      return res['prahari_saved_fields'] as Record<string, string>;
    }
  } catch (err) {
    console.warn('[PRAHARI] Error loading saved fields:', err);
  }
  return {};
}

export async function saveField(key: string, value: string): Promise<void> {
  try {
    const existing = await getSavedFields();
    existing[key] = value;
    await browser.storage.local.set({ prahari_saved_fields: existing });
  } catch (err) {
    console.error('[PRAHARI] Error saving field to storage:', err);
  }
}

export async function deleteSavedField(key: string): Promise<void> {
  try {
    const existing = await getSavedFields();
    delete existing[key];
    await browser.storage.local.set({ prahari_saved_fields: existing });
  } catch (err) {
    console.error('[PRAHARI] Error deleting field from storage:', err);
  }
}

