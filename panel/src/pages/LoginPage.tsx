import { useState, type FormEvent } from 'react';
import { authenticate } from '../api.ts';
import { FishIcon } from '../components/FishIcon.tsx';

export function LoginPage({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const accepted = await authenticate(password);
    setBusy(false);
    if (accepted) onAuthenticated();
    else setError('密码不正确，或本机控制台暂不可用。');
  }

  return (
    <main className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <FishIcon className="login-fish" />
        <h1>水族箱</h1>
        <p className="muted">输入本机控制台密码以继续</p>
        <label className="field-label" htmlFor="panel-password">控制台密码</label>
        <input
          autoComplete="current-password"
          id="panel-password"
          name="password"
          onChange={(event) => setPassword(event.currentTarget.value)}
          required
          type="password"
          value={password}
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary button-wide" disabled={busy} type="submit">
          {busy ? '正在验证…' : '进入'}
        </button>
      </form>
    </main>
  );
}
