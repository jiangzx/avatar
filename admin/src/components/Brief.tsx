import type { AdminOverview, AdminRange } from '@anyidea/protocol';
import { formatCount, formatYuan } from '../format.ts';
import { href } from '../router.ts';

const RANGE_WORD: Record<AdminRange, string> = { today: '今天', '7d': '近 7 天', '30d': '近 30 天' };
const PREVIOUS_WORD: Record<AdminRange, string> = { today: '昨天', '7d': '前 7 天', '30d': '前 30 天' };

function deltaSentence(range: AdminRange, delta: number): string {
  const previous = PREVIOUS_WORD[range];
  if (delta > 0) return `比${previous}多 ${formatCount(delta)} 分钟。`;
  if (delta < 0) return `比${previous}少 ${formatCount(-delta)} 分钟。`;
  return `和${previous}一样。`;
}

function scrollToSpend(): void {
  document.getElementById('spend')?.scrollIntoView?.({ block: 'start' });
}

/** The overview opens with one sentence a non-technical admin can read (spec「第一版方案与自查」1). */
export function Brief({ range, brief }: { range: AdminRange; brief: AdminOverview['brief'] }) {
  const when = RANGE_WORD[range];
  if (brief.owners === 0) {
    return (
      <section className="brief" aria-label="简报">
        <p className="brief-line">{when}还没有人通话。</p>
      </section>
    );
  }
  const cost = formatYuan(brief.costMicroYuan);
  const costLead = brief.costMicroYuan === 0 ? '花费 ' : cost.startsWith('不到') ? '花费' : '花费约 ';
  return (
    <section className="brief" aria-label="简报">
      <p className="brief-line">
        {when} <a href={href('/users')}>{brief.owners} 位老人</a>聊了 <a href={href('/sessions')}>{formatCount(brief.callMinutes)} 分钟</a>，{costLead}
        <button type="button" className="link-button" onClick={scrollToSpend}>
          {cost}
        </button>
        ，
        {brief.errors > 0 ? (
          <>
            出错 <a href={href('/trace', { level: 'error' })}>{brief.errors} 次</a>。
          </>
        ) : (
          '没有出错。'
        )}
      </p>
      <p className="brief-delta">{deltaSentence(range, brief.deltaMinutesVsPrev)}</p>
    </section>
  );
}
