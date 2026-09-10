import browser from 'webextension-polyfill';

export interface UserProfile {
  fullName: string;
  enrollmentNo: string;
  phone: string;
  email: string;
  dob: string;
  usePrefilledData: boolean;
}

export const DEFAULT_PROFILE: UserProfile = {
  fullName: 'Nitin Mali',
  enrollmentNo: '60',
  phone: '9876543210',
  email: 'nitinmali@example.com',
  dob: '2007-05-31',
  usePrefilledData: true,
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
