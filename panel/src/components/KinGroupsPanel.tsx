import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest } from '../api.ts';

interface KinGroupView {
  id: number;
  name: string;
  accounts: number[];
}

interface KinGroupPayload {
  accounts: Array<{ account: number; name: string }>;
  groups: KinGroupView[];
}

export function KinGroupsPanel() {
  const [payload, setPayload] = useState<KinGroupPayload>();
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingGroupId, setSavingGroupId] = useState<number>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load(): Promise<boolean> {
    try {
      setPayload(await apiRequest<KinGroupPayload>('/api/kin-groups'));
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取眷属组失败');
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function createGroup(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || savingGroupId !== undefined) return;
    setSavingGroupId(-1);
    setError('');
    setNotice('');
    try {
      await apiRequest('/api/kin-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cleanName }),
      });
      setName('');
      if (await load()) setNotice('眷属组已创建；成员需手动勾选。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建眷属组失败');
    } finally {
      setSavingGroupId(undefined);
    }
  }

  async function setMember(groupId: number, account: number, checked: boolean): Promise<void> {
    if (!payload || savingGroupId !== undefined) return;
    const group = payload.groups.find((item) => item.id === groupId);
    if (!group) return;
    const accounts = checked
      ? [...new Set([...group.accounts, account])].sort((first, second) => first - second)
      : group.accounts.filter((item) => item !== account);
    setPayload({
      ...payload,
      groups: payload.groups.map((item) => item.id === groupId ? { ...item, accounts } : item),
    });
    setSavingGroupId(groupId);
    setError('');
    setNotice('');
    try {
      await apiRequest(`/api/kin-groups/${groupId}/members`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accounts }),
      });
      if (await load()) setNotice('眷属组成员已保存。');
    } catch (reason) {
      await load();
      setError(reason instanceof Error ? reason.message : '保存眷属组失败');
    } finally {
      setSavingGroupId(undefined);
    }
  }

  return <section className="kin-groups-panel panel-card" aria-labelledby="kin-groups-title">
    <header className="kin-groups-heading">
      <div>
        <h2 id="kin-groups-title">眷属组</h2>
        <p className="muted">只有手动加入同一组的眷属才会共享群聊事实与获准转述。</p>
      </div>
    </header>
    {error && <p className="notice notice-warn" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <form className="kin-groups-create" onSubmit={(event) => void createGroup(event)}>
      <label>
        <span>新组名称</span>
        <input value={name} maxLength={40} disabled={savingGroupId !== undefined}
          onChange={(event) => setName(event.currentTarget.value)} placeholder="例如：夜航" />
      </label>
      <button className="button button-primary" type="submit" disabled={!name.trim() || savingGroupId !== undefined}>
        {savingGroupId === -1 ? '正在创建…' : '创建眷属组'}
      </button>
    </form>
    {loading && <p className="muted" role="status">正在读取眷属组…</p>}
    {!loading && payload?.accounts.length === 0 && <p className="empty-state">当前没有可管理的眷属。</p>}
    {!loading && payload?.groups.length === 0 && <p className="empty-state">还没有眷属组；创建后手动勾选眷属。</p>}
    <div className="kin-groups-list">
      {payload?.groups.map((group) => <section className="kin-group-card" key={group.id} aria-labelledby={`kin-group-${group.id}`}>
        <div className="kin-group-card-heading">
          <h3 id={`kin-group-${group.id}`}>{group.name}</h3>
          <span className="muted">{savingGroupId === group.id ? '正在保存…' : `${group.accounts.length} 位眷属`}</span>
        </div>
        <div className="kin-group-account-list">
          {payload.accounts.map(({ account, name: accountName }) => <label key={account}>
            <input type="checkbox" checked={group.accounts.includes(account)}
              disabled={savingGroupId !== undefined}
              onChange={(event) => void setMember(group.id, account, event.currentTarget.checked)} />
            <span>{accountName}</span>
            <span className="mono muted">{account}</span>
          </label>)}
        </div>
      </section>)}
    </div>
  </section>;
}
