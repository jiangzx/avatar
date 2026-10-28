import { Button } from 'antd';

export interface UnpublishedBarProps { count: number; blocked: boolean; onDiscard: () => void; onReview: () => void }

export function UnpublishedBar({ count, blocked, onDiscard, onReview }: UnpublishedBarProps) {
  if (count === 0) return null;
  return (
    <div className="unpublished-bar" role="region" aria-label="未发布的改动">
      <span className="unpublished-count">有 {count} 项改动还没发布</span>
      {blocked && <span className="unpublished-blocked">先改好标红的项</span>}
      <span className="unpublished-actions">
        <Button onClick={onDiscard}>放弃改动</Button>
        <Button type="primary" disabled={blocked} onClick={onReview}>查看并发布</Button>
      </span>
    </div>
  );
}
