import type { CustomFaceActions, CustomFaceDetail } from '../types.ts';
import type { OneBotClient } from './client.ts';
import type { SessionKey } from '../../core/shared/events.ts';

export type OneBotActionRunner = <T>(action: string, run: () => Promise<T>) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detailFromUnknown(value: unknown): CustomFaceDetail {
  if (!isRecord(value)
    || typeof value.emoji_id !== 'string' || value.emoji_id.length === 0
    || typeof value.resId !== 'string' || value.resId.length === 0
    || typeof value.url !== 'string' || value.url.length === 0
    || typeof value.md5 !== 'string' || !/^[a-f\d]{32}$/iu.test(value.md5)
    || typeof value.desc !== 'string') {
    throw new Error('QQ 收藏表情详情格式无效');
  }
  return {
    emojiId: value.emoji_id,
    resId: value.resId,
    url: value.url,
    md5: value.md5.toLowerCase(),
    desc: value.desc,
  };
}

export function createOneBotCustomFaceActions(
  getClient: () => OneBotClient,
  runAction: OneBotActionRunner,
): CustomFaceActions {
  return {
    async fetchDetails(count) {
      if (!Number.isSafeInteger(count) || count < 0 || count > 300) {
        throw new RangeError('自定义表情同步数量必须为 0–300');
      }
      const result = await runAction('fetch_custom_face_detail', () => (
        getClient().raw('fetch_custom_face_detail', { count })
      ));
      if (!Array.isArray(result)) throw new Error('QQ 收藏表情详情格式无效');
      return result.map(detailFromUnknown);
    },

    async addCustomFace(file) {
      if (!file.trim()) throw new TypeError('表情文件不能为空');
      const result = await runAction('add_custom_face', () => (
        getClient().raw('add_custom_face', { file })
      ));
      if (!isRecord(result) || typeof result.emoji_id !== 'string' || result.emoji_id.length === 0) {
        throw new Error('QQ 收藏接口未返回 emoji_id');
      }
      return { emojiId: result.emoji_id };
    },

    async modifyCustomFace(emojiId, desc) {
      if (!emojiId.trim()) throw new TypeError('emoji_id 不能为空');
      await runAction('modify_custom_face', () => (
        getClient().raw('modify_custom_face', { emoji_id: emojiId, desc })
      ));
    },

    async getImageUrl(file) {
      if (!file.trim()) throw new TypeError('图片 file 不能为空');
      const result = await runAction('get_image', () => getClient().getImage({ file }));
      if (!isRecord(result) || typeof result.url !== 'string' || result.url.length === 0) {
        throw new Error('get_image 未返回图片 URL');
      }
      return result.url;
    },

    async sendCustomFace(input: { session: SessionKey; emojiId: string }) {
      if (!input.emojiId.trim()) throw new TypeError('表情 emoji_id 不能为空');
      const result = await runAction('send_custom_face', () => getClient().raw('send_custom_face', {
        emoji_id: input.emojiId,
        ...(input.session.kind === 'group'
          ? { group_id: input.session.peer }
          : { user_id: input.session.peer }),
      }));
      if (!isRecord(result) || typeof result.message_id !== 'number' || !Number.isSafeInteger(result.message_id)) {
        throw new Error('send_custom_face 未返回消息 ID');
      }
      return { messageId: String(result.message_id) };
    },
  };
}
