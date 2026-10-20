export type ExtractFailureType = 'timeout' | 'network' | 'http' | 'other';

export interface ExtractFailureClassification {
  type: ExtractFailureType;
  httpStatus?: number;
}

const networkCodes = new Set([
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

export function classifyExtractFailure(error: unknown): ExtractFailureClassification {
  if (error && typeof error === 'object') {
    const details = error as { name?: unknown; code?: unknown; status?: unknown };
    if (typeof details.name === 'string' && /timeout|abort/iu.test(details.name)) {
      return { type: 'timeout' };
    }
    if (typeof details.status === 'number' && Number.isInteger(details.status)) {
      return { type: 'http', httpStatus: details.status };
    }
    if (typeof details.code === 'string') {
      if (/TIMEOUT|ABORT/iu.test(details.code)) {
        return { type: 'timeout' };
      }
      if (networkCodes.has(details.code)) {
        return { type: 'network' };
      }
    }
    if (error instanceof TypeError) return { type: 'network' };
  }
  return { type: 'other' };
}

export function extractFailureLabel(failure: ExtractFailureClassification): string {
  if (failure.type === 'timeout') return '模型超时';
  if (failure.type === 'network') return '网络错误';
  if (failure.type === 'http') return `HTTP ${failure.httpStatus ?? '未知'}`;
  return '其他错误';
}
