// Profile state for the signed-in account. Framework-free (like ChatController).
// Rules:
//  - nothing is reported as saved until the backend confirmed it;
//  - results that arrive after the account changed are discarded (epoch);
//  - switching accounts clears everything immediately.
import { validateAvatarFile, validateDisplayName } from './profile.js';

const blank = () => ({
  ownerId: null,
  status: 'idle', // 'idle' | 'loading' | 'ready' | 'error'
  profile: null,
  avatarUrl: null,
  saving: false,
  error: null, // load error (with retry)
});

export class ProfileManager {
  constructor({ createStore, processImage }) {
    this.createStore = createStore;
    this.processImage = processImage;
    this.store = null;
    this.epoch = 0;
    this.listeners = new Set();
    this.state = blank();
  }

  subscribe = (l) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getState = () => this.state;
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // userId === null clears everything (guest / signed out).
  setUser = (userId) => {
    if (this.state.ownerId === userId && this.store) return;
    this.epoch += 1;
    this.store = userId ? this.createStore(userId) : null;
    this.state = blank();
    if (userId) this.state = { ...this.state, ownerId: userId, status: 'loading' };
    this.listeners.forEach((l) => l());
    if (userId) this.load();
  };

  load = async () => {
    const { store, epoch } = this;
    if (!store) return;
    this.setState({ status: 'loading', error: null });
    try {
      const profile = await store.ensure();
      const avatarUrl = await store.signedUrl(profile.avatarPath);
      if (epoch !== this.epoch) return;
      this.setState({ status: 'ready', profile, avatarUrl, error: null });
    } catch {
      if (epoch !== this.epoch) return;
      this.setState({ status: 'error', error: "Your profile couldn't be loaded. Check your connection and try again." });
    }
  };

  // Each action resolves to { ok: true } or { ok: false, error }.
  saveDisplayName = async (raw) => {
    const checked = validateDisplayName(raw);
    if (!checked.ok) return checked;
    const { store, epoch } = this;
    if (!store || !this.state.profile) return { ok: false, error: 'Your profile is not loaded yet.' };
    this.setState({ saving: true });
    try {
      const profile = await store.saveDisplayName(checked.value);
      if (epoch !== this.epoch) return { ok: false, error: 'Signed out.' };
      this.setState({ profile, saving: false });
      return { ok: true };
    } catch {
      if (epoch === this.epoch) this.setState({ saving: false });
      return { ok: false, error: "Your name couldn't be saved. Please try again." };
    }
  };

  uploadAvatar = async (file) => {
    const problem = validateAvatarFile(file);
    if (problem) return { ok: false, error: problem };
    const { store, epoch } = this;
    const current = this.state.profile;
    if (!store || !current) return { ok: false, error: 'Your profile is not loaded yet.' };
    this.setState({ saving: true });
    try {
      const { blob, type } = await this.processImage(file);
      const profile = await store.uploadAvatar(blob, type, current.avatarPath);
      const avatarUrl = await store.signedUrl(profile.avatarPath);
      if (epoch !== this.epoch) return { ok: false, error: 'Signed out.' };
      this.setState({ profile, avatarUrl, saving: false });
      return { ok: true };
    } catch (err) {
      if (epoch === this.epoch) this.setState({ saving: false });
      return { ok: false, error: err?.message?.startsWith('That') ? err.message : "The photo couldn't be uploaded. Please try again." };
    }
  };

  removeAvatar = async () => {
    const { store, epoch } = this;
    const current = this.state.profile;
    if (!store || !current?.avatarPath) return { ok: false, error: 'There is no photo to remove.' };
    this.setState({ saving: true });
    try {
      const profile = await store.removeAvatar(current.avatarPath);
      if (epoch !== this.epoch) return { ok: false, error: 'Signed out.' };
      this.setState({ profile, avatarUrl: null, saving: false });
      return { ok: true };
    } catch {
      if (epoch === this.epoch) this.setState({ saving: false });
      return { ok: false, error: "The photo couldn't be removed. Please try again." };
    }
  };
}
