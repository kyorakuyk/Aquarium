import { Component, type ErrorInfo, type ReactNode } from 'react';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('面板页面渲染失败', redactSensitiveText(error.message), errorInfo.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = redactSensitiveText(error.message) || '未知错误';
    return <section className="notice notice-warn" role="alert">
      <h2>页面出错了</h2>
      <p>{message}</p>
      <button className="button button-primary" type="button" onClick={() => window.location.reload()}>
        重新加载
      </button>
    </section>;
  }
}
