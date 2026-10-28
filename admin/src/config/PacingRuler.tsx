import type { SceneView } from './ConfigScenePage.tsx';
import { formatSeconds } from './format.ts';
import { buildLadder, REST_KEYS, restMarks, rulerX } from './pacingRuler.ts';

const WIDTH = 300;
const KNEE_SEC = 60;
const REST_HORIZON_MIN = 120;

export function PacingRuler({ view }: { view: SceneView }) {
  const marks = buildLadder(view);
  const maxSec = Math.max(1, ...marks.map((m) => m.atSec));
  const first = view.read(REST_KEYS.first);
  const every = view.read(REST_KEYS.every);
  const hasRest = typeof first === 'number' && typeof every === 'number';
  const reminders = hasRest ? restMarks(first, every, REST_HORIZON_MIN) : [];

  return (
    <div className="pacing-ruler">
      <h2 className="ruler-title">节奏尺</h2>
      <p className="ruler-lead">老人停下说话后……</p>
      <svg className="ruler-svg" viewBox={`-8 0 ${WIDTH + 24} 56`} role="img" aria-label="沉默节奏刻度">
        <line x1={0} y1={32} x2={WIDTH} y2={32} className="ruler-axis" />
        {maxSec > KNEE_SEC && (
          <text x={rulerX(KNEE_SEC, maxSec, WIDTH)} y={36} className="ruler-break" textAnchor="middle" aria-hidden="true">≈</text>
        )}
        {marks.map((mark) => {
          const x = rulerX(mark.atSec, maxSec, WIDTH);
          return (
            <g key={mark.step}>
              <line
                data-step={mark.step}
                data-x={x}
                x1={x} y1={22} x2={x} y2={42}
                className="ruler-tick"
                {...(mark.onlyAfterChat ? { strokeDasharray: '3 3' } : {})}
              />
              <text x={x} y={14} className="ruler-label" textAnchor="middle" aria-hidden="true">{formatSeconds(mark.atSec)}</text>
            </g>
          );
        })}
        <text x={WIDTH + 12} y={36} className="ruler-end" textAnchor="middle" aria-hidden="true">停</text>
      </svg>
      <ol className="ruler-steps" aria-label="沉默后 AI 依次会做的事">
        {marks.map((mark) => (
          <li key={mark.step} className={mark.onlyAfterChat ? 'is-conditional' : undefined}>
            <span className="ruler-time">{formatSeconds(mark.atSec)}</span>
            <span className="ruler-step">{mark.label}</span>
            {mark.line
              ? <q className="ruler-line">{mark.line}</q>
              : <span className="ruler-line is-planned">按聊天内容决定说什么</span>}
            {mark.onlyAfterChat && <span className="ruler-note">聊过天才有这一步</span>}
          </li>
        ))}
      </ol>
      <p className="ruler-caption">实际说法会按聊天内容变化，这里显示的是备用话；时间还要加上 AI 每句说话的时长。</p>

      <h2 className="ruler-title">休息提醒</h2>
      <svg className="ruler-svg" viewBox={`-8 0 ${WIDTH + 24} 48`} role="img" aria-label="休息提醒刻度">
        <line x1={0} y1={28} x2={WIDTH} y2={28} className="ruler-axis" />
        {[0, 60, 120].map((min) => (
          <text key={min} x={(min / REST_HORIZON_MIN) * WIDTH} y={46} className="ruler-scale" textAnchor="middle" aria-hidden="true">{min} 分</text>
        ))}
        {reminders.map((min) => {
          const x = (min / REST_HORIZON_MIN) * WIDTH;
          return <line key={min} data-minute={min} x1={x} y1={18} x2={x} y2={34} className="ruler-tick" />;
        })}
      </svg>
      {hasRest && <p className="ruler-caption">{`${first} 分钟第一次提醒，之后每 ${every} 分钟一次`}</p>}
    </div>
  );
}
