import { useEffect, useRef, useState } from 'react';
import { apiRequest, post } from '../api.ts';
import { notifyPersonaCounterpartsUpdated } from '../persona-counterpart-events.ts';
import type {
  PersonaCounterpart,
  PersonaCounterpartBindingView,
  PersonaCounterpartClaimView,
  PersonaCounterpartsView,
} from '../persona-counterpart-api.ts';

function relativeAge(timestamp: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function parseAliases(value: string): string[] {
  return value.split(/[、，,]/u).map((alias) => alias.trim()).filter(Boolean);
}

function CounterpartItem({
  counterpart,
  index,
  bindings,
  claims,
  accountId,
  disabled,
  busy,
  canManageAssociations,
  onChange,
  onRemove,
  onBind,
  onUnbind,
  onDismiss,
}: {
  counterpart: PersonaCounterpart;
  index: number;
  bindings: PersonaCounterpartBindingView[];
  claims: PersonaCounterpartClaimView[];
  accountId: number | null;
  disabled: boolean;
  busy: boolean;
  canManageAssociations: boolean;
  onChange: (counterpart: PersonaCounterpart) => void;
  onRemove: () => void;
  onBind: (name: string, userId: number, account: number) => Promise<boolean>;
  onUnbind: (name: string, userId: number, account: number) => Promise<boolean>;
  onDismiss: (name: string, userId: number, account: number) => Promise<boolean>;
}) {
  const [userIdText, setUserIdText] = useState('');
  const [error, setError] = useState('');
  const counterpartBindings = bindings.filter((binding) => binding.counterpartName === counterpart.name
    && (accountId === null || binding.account === accountId));
  const counterpartClaims = claims.filter((claim) => claim.counterpartName === counterpart.name
    && (accountId === null || claim.account === accountId));
  const inputId = `persona-counterpart-user-${index}`;

  async function addBinding(): Promise<void> {
    if (busy) return;
    if (!canManageAssociations) {
      setError('先保存人设，再配置 QQ 绑定。');
      return;
    }
    const value = userIdText.trim();
    if (!/^[1-9]\d{0,15}$/u.test(value) || !Number.isSafeInteger(Number(value))) {
      setError('请输入有效的 QQ 号。');
      return;
    }
    if (accountId === null) {
      setError('先选择机器人账号，再添加绑定。');
      return;
    }
    setError('');
    try {
      if (await onBind(counterpart.name, Number(value), accountId)) setUserIdText('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '绑定失败');
    }
  }

  return (
    <article className="persona-counterpart-item">
      <div className="persona-counterpart-item-heading">
        <strong>原作对象 {index + 1}</strong>
        <button className="button button-secondary" type="button" disabled={disabled || busy} onClick={onRemove}>删除对象</button>
      </div>
      <div className="persona-counterpart-fields">
        <label>
          名字
          <input value={counterpart.name} disabled={disabled || busy} onChange={(event) => onChange({ ...counterpart, name: event.currentTarget.value })} />
        </label>
        <label>
          关系
          <input value={counterpart.label} disabled={disabled || busy} onChange={(event) => onChange({ ...counterpart, label: event.currentTarget.value })} />
        </label>
        <label className="persona-counterpart-aliases">
          别名（用顿号分隔）
          <input value={counterpart.aliases.join('、')} disabled={disabled || busy} onChange={(event) => onChange({ ...counterpart, aliases: parseAliases(event.currentTarget.value) })} />
        </label>
        <label>
          名字匹配
          <select
            value={counterpart.matchByName}
            disabled={disabled || busy}
            onChange={(event) => onChange({ ...counterpart, matchByName: event.currentTarget.value as PersonaCounterpart['matchByName'] })}
          >
            <option value="off">关</option>
            <option value="prompt">认领提示</option>
          </select>
        </label>
      </div>
      <div className="persona-counterpart-associations">
        <div className="persona-counterpart-section-heading">
          <strong>已绑定的 QQ</strong>
          <span className="muted">绑定只影响角色口吻，不授予隐私权限或改变好感。</span>
        </div>
        {counterpartBindings.length === 0
          ? <p className="muted">暂无绑定</p>
          : <ul className="persona-counterpart-binding-list">
            {counterpartBindings.map((binding) => (
              <li key={`${binding.account}:${binding.userId}`}>
                <span className="persona-counterpart-binding-avatar" aria-hidden="true">{Array.from(binding.senderName)[0] ?? '友'}</span>
                <span className="persona-counterpart-binding-name">
                  <strong>{binding.senderName || '未知昵称'}</strong>
                  <span className="mono">QQ {binding.userId}</span>
                  {accountId === null && <span className="muted">账号 {binding.account}</span>}
                </span>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={disabled || busy || !canManageAssociations}
                  onClick={() => void onUnbind(counterpart.name, binding.userId, binding.account)}
                >移除</button>
              </li>
            ))}
          </ul>}
        <form className="persona-counterpart-add-binding" onSubmit={(event) => { event.preventDefault(); void addBinding(); }}>
          <label htmlFor={inputId}>添加 QQ</label>
          <input
            id={inputId}
            inputMode="numeric"
            value={userIdText}
            placeholder="输入 QQ 号"
            disabled={disabled || busy || accountId === null || !canManageAssociations}
            onChange={(event) => setUserIdText(event.currentTarget.value)}
          />
          <button className="button button-secondary" type="submit" disabled={disabled || busy || accountId === null || !canManageAssociations || !userIdText.trim()}>绑定</button>
        </form>
        {accountId === null && <p className="muted">当前显示所有账号的绑定；选择机器人账号后才能新增。</p>}
        {error && <p className="persona-counterpart-error" role="alert">{error}</p>}
      </div>
      <div className="persona-counterpart-associations">
        <div className="persona-counterpart-section-heading">
          <strong>待认领</strong>
          <span className="muted">只试探回应；按【不是】后不再提示。</span>
        </div>
        {counterpartClaims.length === 0
          ? <p className="muted">暂无待认领对象</p>
          : <ul className="persona-counterpart-claim-list">
            {counterpartClaims.map((claim) => (
              <li key={`${claim.account}:${claim.userId}`}>
                <div className="persona-counterpart-claim-copy">
                  <strong className="mono">QQ {claim.userId}</strong>
                  <span>{claim.senderName ? `“${claim.senderName}”` : '未知昵称'}</span>
                  <span className="muted">{claim.evidence}</span>
                  <time className="mono muted">{relativeAge(claim.lastSeen)}</time>
                </div>
                <div className="persona-counterpart-claim-actions">
                  <button className="button button-primary" type="button" disabled={disabled || busy || !canManageAssociations} onClick={() => void onBind(counterpart.name, claim.userId, claim.account)}>绑定</button>
                  <button className="button button-secondary" type="button" disabled={disabled || busy || !canManageAssociations} onClick={() => void onDismiss(counterpart.name, claim.userId, claim.account)}>不是</button>
                </div>
              </li>
            ))}
          </ul>}
      </div>
    </article>
  );
}

export function PersonaCounterpartEditor({
  personaId,
  accountId,
  counterparts,
  onChange,
  disabled,
}: {
  personaId: string;
  accountId: number | null;
  counterparts: PersonaCounterpart[];
  onChange: (counterparts: PersonaCounterpart[]) => void;
  disabled: boolean;
}) {
  const [loaded, setLoaded] = useState<{ scope: string; value: PersonaCounterpartsView }>();
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const nextRowKey = useRef(counterparts.length);
  const [rowKeys, setRowKeys] = useState(() => counterparts.map((_, index) => `counterpart-${index}`));
  const scope = `${personaId}:${accountId ?? 'all'}`;
  const view = loaded?.scope === scope ? loaded.value : undefined;

  useEffect(() => {
    if (rowKeys.length === counterparts.length) return;
    if (rowKeys.length > counterparts.length) {
      setRowKeys(rowKeys.slice(0, counterparts.length));
      return;
    }
    const addedKeys = Array.from({ length: counterparts.length - rowKeys.length }, () => `counterpart-${nextRowKey.current++}`);
    setRowKeys([...rowKeys, ...addedKeys]);
  }, [counterparts.length, rowKeys]);

  useEffect(() => {
    let active = true;
    setLoadError('');
    const query = accountId === null ? '' : `?account=${accountId}`;
    void apiRequest<PersonaCounterpartsView>(`/api/personas/${encodeURIComponent(personaId)}/counterparts${query}`)
      .then((value) => {
        if (active) setLoaded({ scope, value });
      })
      .catch((reason: unknown) => {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : '读取原作对象失败';
        setLoadError(/404|not found/iu.test(message)
          ? '人设尚未保存；保存后可配置 QQ 绑定与待认领。'
          : message);
      });
    return () => { active = false; };
  }, [accountId, personaId, refreshKey, scope]);

  async function mutate(action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setActionError('');
    try {
      await action();
      setRefreshKey((current) => current + 1);
      notifyPersonaCounterpartsUpdated();
      return true;
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '原作对象操作失败');
      return false;
    } finally {
      setBusy(false);
    }
  }

  function endpoint(name: string): string {
    return `/api/personas/${encodeURIComponent(personaId)}/counterparts/${encodeURIComponent(name)}`;
  }

  function withAccount(url: string, account: number): string {
    return `${url}?account=${account}`;
  }

  function bind(name: string, userId: number, account: number): Promise<boolean> {
    return mutate(() => post(withAccount(`${endpoint(name)}/bindings`, account), { userId }));
  }

  function unbind(name: string, userId: number, account: number): Promise<boolean> {
    return mutate(() => apiRequest(withAccount(`${endpoint(name)}/bindings/${userId}`, account), { method: 'DELETE' }));
  }

  function dismiss(name: string, userId: number, account: number): Promise<boolean> {
    return mutate(() => post(withAccount(`${endpoint(name)}/claims/${userId}/dismiss`, account)));
  }

  return (
    <section className="persona-form-card persona-counterpart-editor" aria-label="原作对象">
      <div className="persona-counterpart-heading">
        <div>
          <h3>原作对象</h3>
          <p className="persona-form-hint">名字与绑定只影响口吻和 audience 层级；不授予隐私权限、不算主人、不改好感存储。</p>
        </div>
        <button className="button button-secondary" type="button" disabled={disabled || busy} onClick={() => setRefreshKey((current) => current + 1)}>重新读取</button>
      </div>
      <div className="persona-counterpart-scope muted">
        {accountId === null ? '当前账号：全部机器人账号' : `当前机器人账号：${accountId}`}
      </div>
      {loadError && <p className="persona-counterpart-error" role="alert">读取失败：{loadError}</p>}
      {actionError && <p className="persona-counterpart-error" role="alert">操作失败：{actionError}</p>}
      {!view && !loadError && <p className="muted">正在读取绑定与待认领…</p>}
      {counterparts.length === 0 && <p className="muted">还没有原作对象。添加对象后，名字匹配可以设置为“关”或“认领提示”。</p>}
      <div className="persona-counterpart-list">
        {counterparts.map((counterpart, index) => (
          <CounterpartItem
            key={rowKeys[index] ?? `counterpart-pending-${personaId}-${index}`}
            counterpart={counterpart}
            index={index}
            bindings={view?.bindings ?? []}
            claims={view?.claims ?? []}
            accountId={accountId}
            disabled={disabled}
            busy={busy}
            canManageAssociations={Boolean(view)}
            onChange={(next) => onChange(counterparts.map((current, itemIndex) => itemIndex === index ? next : current))}
            onRemove={() => {
              setRowKeys((current) => current.filter((_, itemIndex) => itemIndex !== index));
              onChange(counterparts.filter((_, itemIndex) => itemIndex !== index));
            }}
            onBind={bind}
            onUnbind={unbind}
            onDismiss={dismiss}
          />
        ))}
      </div>
      <button
        className="button button-secondary persona-counterpart-add-object"
        type="button"
        disabled={disabled || busy}
        onClick={() => {
          const addedKey = `counterpart-${nextRowKey.current++}`;
          setRowKeys((current) => [...current, addedKey]);
          onChange([...counterparts, { name: '', aliases: [], label: '', matchByName: 'prompt' }]);
        }}
      >添加原作对象</button>
    </section>
  );
}
