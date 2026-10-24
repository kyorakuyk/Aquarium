export type TaskProgressStatus = 'done' | 'active' | 'pending';

export interface TaskProgressItem {
  id: string;
  title: string;
  detail: string;
  status: TaskProgressStatus;
}

const STATUS_LABELS: Record<TaskProgressStatus, string> = {
  done: '已完成',
  active: '进行中',
  pending: '待开始',
};

const STATUS_MARKS: Record<TaskProgressStatus, string> = {
  done: '✓',
  active: '›',
  pending: '·',
};

export function TaskProgress({ items, note }: { items: readonly TaskProgressItem[]; note?: string }) {
  const completed = items.filter((item) => item.status === 'done').length;
  const percent = items.length ? Math.round((completed / items.length) * 100) : 0;
  const active = items.find((item) => item.status === 'active');

  return (
    <section className="task-progress" aria-labelledby="task-progress-title">
      <div className="task-progress-heading">
        <div>
          <h2 id="task-progress-title">之前任务与进度</h2>
          <p className="muted">{completed}/{items.length} 项已完成{active ? ` · 当前 ${active.id} ${active.title}` : ''}</p>
        </div>
        <span className="task-progress-percent mono">{percent}%</span>
      </div>
      <div className="task-progress-meter" role="progressbar" aria-label="任务完成度" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={completed}>
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="task-progress-list">
        {items.map((item) => (
          <li className="task-progress-item" data-status={item.status} key={item.id}>
            <span className="task-progress-mark" aria-hidden="true">{STATUS_MARKS[item.status]}</span>
            <div className="task-progress-copy">
              <div className="task-progress-title"><strong>{item.id} · {item.title}</strong><span>{STATUS_LABELS[item.status]}</span></div>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
      {note && <p className="task-progress-note">{note}</p>}
    </section>
  );
}
