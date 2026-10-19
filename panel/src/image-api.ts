import { clearAuthentication, PASSWORD_KEY, UNAUTHORIZED_EVENT } from './api.ts';
import { redactSensitiveText } from './sensitive-text.ts';

export async function apiBlob(path: string): Promise<Blob> {
  const headers = new Headers();
  const password = sessionStorage.getItem(PASSWORD_KEY);
  if (password) headers.set('Authorization', `Bearer ${password}`);
  const response = await fetch(path, { headers });
  if (response.status === 401) {
    clearAuthentication();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error('登录已失效');
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === 'string') message = redactSensitiveText(body.error);
    } catch {
      // Keep the generic status message for non-JSON errors.
    }
    throw new Error(message);
  }
  return response.blob();
}
