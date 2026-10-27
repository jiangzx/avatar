import type { AdminTimeline, AdminTimelineItem } from '@anyidea/protocol';
import { formatClock, formatDateTime, formatDuration, formatMoney, formatSeconds } from '../format.ts';
import { characterName, endReasonLabel } from '../labels.ts';
import { palette } from '../theme.ts';

/** The timeline payload; firstAudioAlertMs comes from admin.json alerts.firstAudioP95Ms. */
export type TimelineData = AdminTimeline;

const BAR_MAX_PX = 240;
const MIN_SCALE_MS = 1000;

export function sortTimeline(items: readonly AdminTimelineItem[]): AdminTimelineItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (a.item.ts !== b.item.ts) return a.item.ts - b.item.ts;
      const sa = a.item.seq ?? Number.POSITIVE_INFINITY;
      const sb = b.item.seq ?? Number.POSITIVE_INFINITY;
      return sa !== sb ? sa - sb : a.index - b.index;
    })
    .map(({ item }) => item);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function firstAudioMs(item: AdminTimelineItem): number | null {
  if (item.event !== 'reply_metrics') return null;
  return num(item.fields.speech_to_first_audio_ms) ?? num(item.fields.vad_to_first_audio_ms);
}

export function timelineLabel(item: AdminTimelineItem): string {
  const code = typeof item.fields.code === 'string' ? item.fields.code : '';
  switch (item.event) {
    case 'session_created':
      return '开始通话';
    case 'session_destroyed':
      return '结束通话';
    case 'reply_metrics': {
      const seq = item.seq ?? num(item.fields.seq);
      return seq === null ? '回复' : `第 ${seq} 次回复`;
    }
    case 'upstream_error': {
      const attempt = num(item.fields.attempt);
      return `上游出错 ${code}${attempt === null ? '' : `（第 ${attempt} 次尝试）`}`;
    }
    case 'adapter_error':
      // Old log_events rows still carry the pre-P1-T6 name; label them like upstream_error.
      return `模型出错 ${code}`;
    case 'response_cancel':
      return '回复被打断';
    case 'model_rebuild':
      return '重新连接模型';
    default:
      // Never drop an event the UI does not know yet.
      return item.event;
  }
}

export function Timeline({ timeline }: { timeline: TimelineData }) {
  const { session } = timeline;
  const items = sortTimeline(timeline.items);
  const slowMs = timeline.firstAudioAlertMs;
  const latencies = items.map(firstAudioMs).filter((v): v is number => v !== null);
  const scale = Math.max(MIN_SCALE_MS, slowMs, ...latencies);
  const when = `${formatDateTime(session.startedAt)} 开始`;
  const how = session.endedAt === null ? '还在进行' : `时长 ${formatDuration(session.endedAt - session.startedAt)}，${endReasonLabel(session)}`;

  return (
    <section aria-labelledby="timeline-title">
      <h2 id="timeline-title" style={{ fontSize: 22 }}>
        {characterName(session.character)}和用户 {session.oid} 的通话
      </h2>
      <p className="caption">
        {when}，{how}
      </p>
      <p className="prose">
        回复 {session.replies} 次，出错 {session.errors} 次，费用 {formatMoney(session.usage)}。
      </p>
      <ol className="timeline">
        {items.map((item, index) => {
          const ms = firstAudioMs(item);
          const slow = ms !== null && slowMs !== null && ms > slowMs;
          const danger = item.level === 'error';
          return (
            <li key={`${item.ts}-${index}`}>
              <span className="timeline-clock" data-testid="timeline-clock">
                {formatClock(item.ts - session.startedAt)}
              </span>
              <span style={danger ? { color: palette.cinnabar } : undefined}>{timelineLabel(item)}</span>
              <span>
                {ms !== null && (
                  <>
                    首音 {formatSeconds(ms)}
                    <span
                      className="timeline-bar"
                      data-testid="latency-bar"
                      data-tone={slow ? 'danger' : 'normal'}
                      aria-hidden="true"
                      style={{ width: `${Math.max(2, Math.round((ms / scale) * BAR_MAX_PX))}px`, background: slow ? palette.cinnabar : palette.celadon }}
                    />
                  </>
                )}
              </span>
              <details>
                <summary>详情</summary>
                <ul>
                  {Object.entries(item.fields).map(([key, value]) => (
                    <li key={key}>
                      {key}：{String(value)}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
