/**
 * Admin chat pairing store (file-backed)
 */

import { readJsonFile, writeJsonFileAtomic } from '../storage/file-store.js';

export interface AdminState {
  adminChatId: string | null;
}

export class AdminStore {
  constructor(private path: string = './data/admin.json') {}

  async get(): Promise<AdminState> {
    return readJsonFile<AdminState>(this.path, { adminChatId: null });
  }

  async setAdminChatId(adminChatId: string): Promise<void> {
    await writeJsonFileAtomic(this.path, { adminChatId });
  }
}
