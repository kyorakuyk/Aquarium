import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiRequest, type DecisionStep, type DecisionView, type PanelStatus, type PipelineStepTraceView, type SessionView, type TraceView } from '../api.ts';
import { FishIcon } from '../components/FishIcon.tsx';
import { decisionLabel, decisionTone } from '../labels.ts';

interface ChatEntry {
  id: number;
  role: 'user' | 'bot';
  text: string;
  steps?: DecisionStep[];
  model?: string;
  costCny?: number;
  partCount?: number;
}

interface SandboxResponse {
  parts: string[];
  decisionSteps: DecisionStep[];
  usage: { provider: string; model: string; costCny: number; inputTokens: number; cachedTokens: number; outputTokens: number };
}

function stepLabel(step: string): string {
  const labels: Record<string, string> = {
    settings: '会话设置', prompt: '提示词', reply: '模型回复', split: '拆条与节奏',
  };
  return labels[step] ?? step;
}

function pipelineStepLabel(step: string): string {
  const labels: Record<string, string> = {
    persist: '入库与去重', gate: '触发与守门', context: '上下文与提示词',
    generate: '生成回复', deliver: '拆条与发送',
  };
  return labels[step] ?? step;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value);
}

export function DecisionsPage() {
  const [view, setView] = useState<'sandbox' | 'records'>('sandbox');
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [asOwner, setAsOwner] = useState(false);
  const [ownerAvailable, setOwnerAvailable] = useState(true);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [steps, setSteps] = useState<DecisionStep[]>([]);
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [selectedDecision, setSelectedDecision] = useState<DecisionView>();
  const [traces, setTraces] = useState<TraceView[]>([]);
  const [pipelineTrace, setPipelineTrace] = useState<PipelineStepTraceView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void Promise.all([
      apiRequest<SessionView[]>('/api/sessions'),
      apiRequest<DecisionView[]>('/api/decisions?limit=200'),
      apiRequest<PanelStatus>('/api/status'),
    ]).then(([sessionRows, decisionRows, status]) => {
      setSessions(sessionRows);
      setSessionId(sessionRows.find((item) => item.kind === 'group')?.sessionId ?? sessionRows[0]?.sessionId ?? '');
      setDecisions(decisionRows);
      setOwnerAvailable(status.ownerConfigured);
      setAsOwner(status.ownerConfigured);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取决策数据失败'));
  }, []);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages]);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !sessionId || busy) return;
    const history = messages.map(({ role, text: messageText }) => ({ role, text: messageText }));
    setMessages((current) => [...current, { id: Date.now(), role: 'user', text }]);
    setDraft('');
    setBusy(true);
    setError('');
    try {
      const response = await apiRequest<SandboxResponse>('/api/sandbox/chat', {
        method: 'POST',
        body: JSON.stringify({ sessionId, asOwner, history, text }),
      });
      const entries = response.parts.map((part, index): ChatEntry => ({
        id: Date.now() + index + 1,
        role: 'bot',
        text: part,
        steps: response.decisionSteps,
        model: response.usage.model,
        ...(index === 0 ? { costCny: response.usage.costCny } : {}),
        partCount: response.parts.length,
      }));
      setMessages((current) => [...current, ...entries]);
      setSteps(response.decisionSteps);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '试聊失败');
    } finally {
      setBusy(false);
    }
  }

  function clearChat() {
    setMessages([]);
    setSteps([]);
    setError('');
  }

  async function loadTrace(decision: DecisionView) {
    setSelectedDecision(decision);
    setTraces([]);
    setPipelineTrace([]);
    if (!decision.hasDebugTrace && !decision.hasPipelineTrace) return;
    try {
      const [debugResult, pipelineResult] = await Promise.all([
        decision.hasDebugTrace
          ? apiRequest<{ traces: TraceView[] }>(`/api/decisions/${decision.id}/trace`)
          : Promise.resolve({ traces: [] as TraceView[] }),
        decision.hasPipelineTrace
          ? apiRequest<{ trace: PipelineStepTraceView[] }>(`/api/decisions/${decision.id}/pipeline-trace`)
          : Promise.resolve({ trace: [] as PipelineStepTraceView[] }),
      ]);
      setTraces(debugResult.traces);
      setPipelineTrace(pipelineResult.trace);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取调试记录失败');
    }
  }

  const selectedSession = sessions.find((item) => item.sessionId === sessionId);

  return (
    <div className="page">
      <header className="page-header">
        <h1>试聊与决策</h1>
        <p className="page-description">沿用真实会话的人设、提示词组装与 reply 槽位；试聊消息不会发到 QQ，也不会写入消息表。</p>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      <div className="page-tabs" role="tablist" aria-label="试聊与决策视图">
        <button className={view === 'sandbox' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'sandbox'} onClick={() => setView('sandbox')}>试聊工作台</button>
        <button className={view === 'records' ? 'is-active' : ''} type="button" role="tab" aria-selected={view === 'records'} onClick={() => setView('records')}>决策记录 <span className="mono">{decisions.length}</span></button>
      </div>

      {view === 'sandbox' && <div className="sandbox-layout">
        <section className="chat-card panel-card">
          <div className="chat-toolbar">
            <label><span className="field-label">按哪个会话的设置</span><select value={sessionId} onChange={(event) => { setSessionId(event.currentTarget.value); clearChat(); }}>
              {sessions.map((item) => <option value={item.sessionId} key={item.sessionId}>{item.name} · {item.sessionId}</option>)}
            </select></label>
            <label><span className="field-label">我扮演</span><select value={asOwner ? 'owner' : 'friend'} onChange={(event) => { setAsOwner(event.currentTarget.value === 'owner'); clearChat(); }}><option value="owner" disabled={!ownerAvailable}>{ownerAvailable ? '主人' : '主人（未配置）'}</option><option value="friend">普通群友</option></select></label>
            <button className="button button-secondary" type="button" onClick={clearChat}>清空对话</button>
          </div>
          <div className="sandbox-note">试聊不入消息库、不发 QQ · 模型用量照常计入花费</div>
          <div className="chat-log" aria-live="polite">
            {messages.map((message) => message.role === 'user'
              ? <div className="chat-line chat-line-user" key={message.id}><div className="chat-bubble user-bubble">{message.text}</div></div>
              : <div className="chat-line chat-line-bot" key={message.id}>
                <FishIcon className="bot-mark" />
                <button className={`chat-bubble bot-bubble ${steps === message.steps ? 'is-focused' : ''}`} type="button" onClick={() => setSteps(message.steps ?? [])} aria-label="查看这条回复的决策步骤">{message.text}</button>
                <div className="chat-meta mono">{message.model ?? 'reply'} · {message.costCny === undefined ? '同轮' : `¥${message.costCny.toFixed(4)}`} · {message.partCount ?? 1} 条</div>
              </div>)}
            {messages.length === 0 && <div className="chat-empty"><p>试聊从这里开始。</p><span className="muted">选择一个会话，输入消息查看模型回复与执行步骤。</span></div>}
            <div ref={chatEnd} />
          </div>
          <form className="chat-compose" onSubmit={sendMessage}>
            <label className="visually-hidden" htmlFor="sandbox-message">输入试聊内容</label>
            <textarea id="sandbox-message" rows={2} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder="写一条消息…" disabled={busy || !sessionId} />
            <button className="button button-primary" type="submit" disabled={busy || !draft.trim() || !sessionId}>{busy ? '发送中…' : '发送'}</button>
          </form>
          {selectedSession && <div className="chat-session-foot">当前设置：{selectedSession.enabled ? '已启用' : '已停用'} · {selectedSession.overrides.length ? '本会话有覆盖项' : '继承全局'}</div>}
        </section>

        <aside className="trace-card panel-card">
          <div className="section-heading"><div><h2>它为什么这么回</h2></div></div>
          <p className="trace-explainer">手动消息直达提示词与 reply 槽位；真实触发判断、频率限制和适配器发送不在试聊中运行。</p>
          {steps.length ? <ol className="decision-timeline">
            {steps.map((step, index) => <li key={`${step.step}-${index}`}>
              <span className="timeline-marker">{String(index + 1).padStart(2, '0')}</span>
              <div className="timeline-content"><div className="timeline-title"><strong>{stepLabel(step.step)}</strong><span className="mono">{String(step.status)}</span></div>
                <p>{Object.entries(step).filter(([key]) => !['step', 'status'].includes(key)).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || '步骤已完成'}</p>
              </div>
            </li>)}
          </ol> : <div className="empty-state">发送一条试聊消息后，这里会显示真实返回的步骤。</div>}
          {messages.some((item) => item.role === 'bot') && <details className="prompt-details"><summary>查看发给模型的完整提示词</summary><p className="muted">试聊不会保存全文。真实会话开启调试记录后，可在决策记录中查看。</p></details>}
        </aside>
      </div>}

      {view === 'records' && <div className="decision-records-layout">
        <section className="panel-card table-card">
          <div className="section-heading"><div><h2>最近决策</h2><p className="muted">最多显示 200 条</p></div><button className="text-button" type="button" onClick={() => void apiRequest<DecisionView[]>('/api/decisions?limit=200').then(setDecisions)}>刷新</button></div>
          <div className="decision-record-list">
            {decisions.map((decision) => <button className={`decision-record ${selectedDecision?.id === decision.id ? 'is-selected' : ''}`} type="button" key={decision.id} onClick={() => void loadTrace(decision)}>
              <span className={`result-pill result-${decisionTone(decision.reason)}`}>{decisionLabel(decision.reason)}</span>
              <span>{decision.sessionName}</span>
              <span className="decision-message" title={decision.messageText ?? undefined}>{decision.messageText ?? '—'}</span>
              <span className="mono muted">{decision.costCny === null ? '—' : `¥${decision.costCny.toFixed(4)}`}</span>
              <span className="mono muted">{formatTime(decision.time)}</span>
            </button>)}
            {!decisions.length && <div className="empty-state">尚无决策记录。</div>}
          </div>
        </section>
        <aside className="panel-card trace-card">
          <h2>决策追踪</h2>
          {!selectedDecision && <p className="muted">选择一条决策查看详情。</p>}
          {selectedDecision && !selectedDecision.hasDebugTrace && !selectedDecision.hasPipelineTrace && <p className="notice">该会话当时没有开启调试记录。</p>}
          {selectedDecision?.hasPipelineTrace && (pipelineTrace.length
            ? <>
              <h3>流水线步骤</h3>
              <ol className="decision-timeline pipeline-timeline">
                {pipelineTrace.map((entry, index) => <li key={`${entry.step}-${index}`}>
                  <span className="timeline-marker">{String(index + 1).padStart(2, '0')}</span>
                  <div className="timeline-content">
                    <div className="timeline-title"><strong>{pipelineStepLabel(entry.step)}</strong><span className="mono">{entry.durationMs.toFixed(1)} ms</span></div>
                    <p>{entry.summary}</p>
                  </div>
                </li>)}
              </ol>
            </>
            : <p className="muted">流水线追踪记录为空或已过期。</p>)}
          {traces.map((trace) => <details className="prompt-details" key={trace.id} open>
            <summary>{trace.slot} · {trace.provider}/{trace.model} · {trace.promptHash}</summary>
            <h3>发送给模型的内容</h3><pre>{trace.promptJson}</pre>
            <h3>模型原始返回</h3><pre>{trace.responseText}</pre>
            <h3>调用结果</h3><pre>{JSON.stringify(trace.detail, null, 2)}</pre>
          </details>)}
        </aside>
      </div>}
    </div>
  );
}
