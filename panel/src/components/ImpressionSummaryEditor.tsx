import { useEffect, useState } from 'react';
import { apiRequest, type GroupSummaryView, type MemberSummaryView } from '../api.ts';
import { memberSummaryErrorMessage } from '../member-summary-errors.ts';
import { containsSensitiveText, redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';

type SummaryView = Pick<GroupSummaryView | MemberSummaryView, 'text' | 'manual'>;

export function ImpressionSummaryEditor({ endpoint, subject, refreshVersion = 0 }: {
  endpoint: string;
  subject: string;
  refreshVersion?: number;
}) {
  const [summary, setSummary] = useState<SummaryView | null>();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sensitiveInput, setSensitiveInput] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSummary(undefined);
    setLoading(true);
    setError('');
    setEditing(false);
    setDraft('');
    setSensitiveInput(false);
  }, [endpoint]);

  useEffect(() => {
    if (editing) return;
    let active = true;
    setLoading(true);
    setError('');
    void apiRequest<SummaryView | null>(endpoint).then((result) => {
      if (active) setSummary(result);
    }).catch((reason: unknown) => {
      if (active) setError(memberSummaryErrorMessage(reason, 'read'));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [editing, endpoint, refreshVersion]);

  async function save(): Promise<void> {
    const text = draft.trim();
    if (!text || Array.from(text).length > 50 || /[\r\n]/u.test(text) || containsSensitiveText(text) || saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = await apiRequest<SummaryView>(endpoint, { method: 'PUT', body: JSON.stringify({ text }) });
      setSummary(saved);
      setEditing(false);
    } catch (reason) {
      setError(memberSummaryErrorMessage(reason, 'save'));
    } finally {
      setSaving(false);
    }
  }

  return <div className="member-summary">
    <div className="member-summary-heading">
      <span className="small-heading">一句话印象</span>
      {summary?.manual && <span className="status-pill">手动</span>}
      {!editing && <button className="text-button" type="button" disabled={loading || saving} onClick={() => {
        setDraft(summary?.text ?? '');
        setSensitiveInput(false);
        setEditing(true);
      }}>{summary ? '改写' : '添加'}</button>}
    </div>
    {loading && <p className="muted" role="status">正在读取…</p>}
    {!loading && !editing && <p className="member-summary-text">{summary ? redactSensitiveText(summary.text) : '还没有一句话印象。'}</p>}
    {editing && <div className="member-summary-editor">
      <textarea
        value={draft}
        rows={2}
        aria-label={`编辑${subject}的一句话印象`}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (containsSensitiveText(value)) {
            setDraft('');
            setSensitiveInput(true);
            setError('疑似敏感凭据已清除，未发送。');
          } else {
            setDraft(value);
            setSensitiveInput(false);
            setError('');
          }
        }}
      />
      <span className="muted mono">{Array.from(draft).length}/50 个 Unicode 字符</span>
      {sensitiveInput && <span className="tag-sensitive-hint" role="status">疑似敏感凭据已清除，未发送。</span>}
      <div className="member-summary-actions">
        <button className="button button-primary" type="button" disabled={saving || sensitiveInput || !draft.trim() || Array.from(draft.trim()).length > 50 || /[\r\n]/u.test(draft)} onClick={() => void save()}>
          {saving ? '正在保存…' : '保存为手动印象'}
        </button>
        <button className="text-button" type="button" disabled={saving} onClick={() => { setEditing(false); setSensitiveInput(false); setError(''); }}>取消</button>
      </div>
    </div>}
    {error && <p className="notice notice-warn" role="alert">{error}</p>}
  </div>;
}
