import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, patch, post, type PanelAccount, type PanelStatus } from '../api.ts';
import { StickerImage } from '../components/StickerImage.tsx';
import { StickerSettingsCard } from '../components/StickerSettingsCard.tsx';
import {
  formatStickerTime as formatTime,
  removeStickerTag,
  stickerFilters as filters,
  stickerTagLength as tagLength,
  type StickerFilter as Filter,
  type StickerListView,
  type StickerView,
} from '../sticker-types.ts';

export function StickersPage() {
  const [stickers, setStickers] = useState<StickerView[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<PanelAccount[]>([]);
  const [account, setAccount] = useState<number>();
  const [tagEditing, setTagEditing] = useState<number | null>(null);
  const [tagDraft, setTagDraft] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const query = account === undefined ? '' : `?account=${account}`;

  const load = useCallback(async (): Promise<void> => {
    try {
      const list = await apiRequest<StickerListView>(`/api/stickers${query}`);
      setStickers(list.stickers);
      setLastSyncAt(list.lastSyncAt);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取表情库失败');
    }
  }, [query]);

  useEffect(() => {
    let active = true;
    void apiRequest<PanelStatus>('/api/status').then((status) => {
      if (!active) return;
      setAccounts(status.accounts);
      const first = status.accounts[0]?.account;
      setAccount(first);
      if (first === undefined) setError('尚未连接可用眷属。');
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (account === undefined) return;
    void load();
  }, [account, load]);

  const visible = useMemo(() => stickers.filter((sticker) => {
    if (filter === 'enabled') return sticker.enabled && !sticker.missing;
    if (filter === 'undescribed') return !sticker.missing && !sticker.descAi.trim();
    if (filter === 'missing') return sticker.missing;
    return true;
  }), [filter, stickers]);

  async function updateSticker(id: number, body: Record<string, unknown>): Promise<boolean> {
    try {
      await patch<StickerView>(`/api/stickers/${id}`, body);
      await load();
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新表情失败');
      return false;
    }
  }

  async function saveDescription(sticker: StickerView, value: string): Promise<void> {
    const descAi = value.trim();
    if (descAi === sticker.descAi) return;
    if (Array.from(descAi).length > 20) {
      setError('表情描述不能超过 20 字');
      return;
    }
    await updateSticker(sticker.id, { descAi });
  }

  async function addTag(sticker: StickerView): Promise<void> {
    const tag = tagDraft.trim();
    if (tagLength(tag) < 2 || tagLength(tag) > 4) {
      setError('标签必须为 2–4 字');
      return;
    }
    if (sticker.tags.includes(tag)) {
      setTagEditing(null);
      setTagDraft('');
      return;
    }
    if (sticker.tags.length >= 5) {
      setError('每个表情最多 5 个标签');
      return;
    }
    if (await updateSticker(sticker.id, { tags: [...sticker.tags, tag] })) {
      setTagEditing(null);
      setTagDraft('');
    }
  }

  async function sync(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await post(`/api/stickers/sync${query}`) as {
        results: Array<{ received?: number; inserted?: number; described?: number; ok: boolean }>;
      };
      const first = result.results[0];
      setNotice(first?.ok
        ? `同步完成：收到 ${first.received ?? 0} 张，新增 ${first.inserted ?? 0} 张。`
        : '同步失败，请检查眷属是否在线。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '同步失败');
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File): Promise<void> {
    if (file.size > 5 * 1024 * 1024) {
      setError('图片不能超过 5 MiB');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
      await post(`/api/stickers/upload${query}`, {
        dataBase64: btoa(binary),
        filename: file.name,
      });
      setNotice('已收藏到 QQ，并同步回表情库。');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }


  return (
    <div className="page stickers-page">
      <header className="page-header">
        <div className="stickers-header-copy">
          <div className="page-title-row">
            <h1>表情包</h1>
            <span className="eyebrow">来源：QQ 收藏</span>
          </div>
          <p className="page-description">收藏即表情库；同步后会补上描述与标签。</p>
          {accounts.length > 1 && (
            <label className="stickers-account-select">
              <span>眷属</span>
              <select value={account ?? ''} onChange={(event) => setAccount(Number(event.target.value))}>
                {accounts.map((item) => <option key={item.account} value={item.account}>{item.name}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="detail-title-actions">
          <button className="button button-secondary" type="button" disabled={busy || account === undefined} onClick={() => void sync()}>
            同步 QQ 收藏
          </button>
          <button className="button button-secondary" type="button" disabled={busy || account === undefined} onClick={() => fileRef.current?.click()}>
            上传
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </div>
      </header>

      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {notice && <div className="notice" role="status">{notice}</div>}

      <div className="stickers-top">
        <p className="stickers-sync-time">最近同步 <strong className="mono">{formatTime(lastSyncAt)}</strong></p>
        <StickerSettingsCard onNotice={setNotice} onError={setError} />
      </div>

      <div className="stickers-filters" role="tablist" aria-label="表情筛选">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={filter === item.id}
            className={filter === item.id ? 'is-current' : ''}
            onClick={() => setFilter(item.id)}
          >{item.label}</button>
        ))}
        <span className="stickers-count mono">{visible.length} 张</span>
      </div>

      {visible.length === 0 ? (
        <div className="panel-card stickers-empty">
          <p>还没有表情。同步 QQ 收藏，或回复一张图片说“收藏”。</p>
        </div>
      ) : (
        <div className="stickers-grid">
          {visible.map((sticker) => (
            <article className={`panel-card sticker-card ${sticker.missing ? 'is-missing' : ''}`} key={sticker.id}>
              {sticker.imageUrl
                ? <StickerImage src={sticker.imageUrl} alt={sticker.descAi || '收藏表情'} />
                : <div className="sticker-image"><span className="sticker-image-placeholder">无图片</span></div>}
              <div className="sticker-copy">
                <input
                  key={`${sticker.id}-${sticker.updatedAt}`}
                  className="sticker-description"
                  aria-label={`表情 ${sticker.id} 的描述`}
                  defaultValue={sticker.descAi}
                  placeholder="未描述"
                  maxLength={20}
                  onBlur={(event) => void saveDescription(sticker, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                    if (event.key === 'Escape') {
                      event.currentTarget.value = sticker.descAi;
                      event.currentTarget.blur();
                    }
                  }}
                />
                <div className="sticker-tags">
                  {sticker.tags.map((tag, index) => (
                    <button
                      className="sticker-tag-remove"
                      key={`${tag}-${index}`}
                      type="button"
                      aria-label={`移除表情 ${sticker.id} 的标签 ${tag}`}
                      onClick={() => void updateSticker(sticker.id, {
                        tags: removeStickerTag(sticker.tags, tag),
                      })}
                    >
                      <span className="sticker-tag">{tag}<span aria-hidden="true">×</span></span>
                    </button>
                  ))}
                  {tagEditing === sticker.id ? (
                    <input
                      className="sticker-tag-input"
                      aria-label={`为表情 ${sticker.id} 添加标签`}
                      autoFocus
                      value={tagDraft}
                      maxLength={4}
                      onChange={(event) => setTagDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void addTag(sticker);
                        if (event.key === 'Escape') {
                          setTagEditing(null);
                          setTagDraft('');
                        }
                      }}
                      onBlur={() => {
                        setTagEditing(null);
                        setTagDraft('');
                      }}
                    />
                  ) : (
                    <button
                      className="sticker-tag-add"
                      type="button"
                      aria-label={`为表情 ${sticker.id} 添加标签`}
                      onClick={() => {
                        setTagEditing(sticker.id);
                        setTagDraft('');
                      }}
                    >＋</button>
                  )}
                </div>
                <div className="sticker-meta">
                  <span className="mono">用了 {sticker.useCount} 次</span>
                  <div className="sticker-meta-actions">
                    {sticker.missing && <span className="sticker-missing-label">已从 QQ 收藏移除</span>}
                    <button
                      className={`switch sticker-switch ${sticker.enabled ? 'is-on' : ''}`}
                      type="button"
                      role="switch"
                      aria-label={`${sticker.enabled ? '停用' : '启用'}表情 ${sticker.id}`}
                      aria-checked={sticker.enabled}
                      disabled={sticker.missing}
                      onClick={() => void updateSticker(sticker.id, { enabled: !sticker.enabled })}
                    ><span /></button>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
