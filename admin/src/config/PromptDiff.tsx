import { diffText } from './textDiff.ts';

export function PromptDiff({ before, after }: { before: string; after: string }) {
  const ops = diffText(before, after);
  return (
    <div className="prompt-diff">
      <div className="prompt-diff-col">
        <h4>原来</h4>
        <p>
          {ops.filter((op) => op.type !== 'ins').map((op, i) =>
            op.type === 'del' ? <del key={i}>{op.text}</del> : <span key={i}>{op.text}</span>)}
        </p>
      </div>
      <div className="prompt-diff-col">
        <h4>改后</h4>
        <p>
          {ops.filter((op) => op.type !== 'del').map((op, i) =>
            op.type === 'ins' ? <ins key={i}>{op.text}</ins> : <span key={i}>{op.text}</span>)}
        </p>
      </div>
    </div>
  );
}
