import type { Language } from '@anyidea/protocol';

export interface PromptLabels {
  user: string;
  assistant: string;
  memoryHeader: string;
  summaryHeader: string;
  recentHeader: string;
  empty: string;
  fact: string;
  relationship: string;
  episode: string;
  addressing: string;
  /** Shared basic facts (profile_facts.profile): known basics, not something "you were told last time". */
  profile: string;
  /** Pinned memories: the user's own words they asked to keep. */
  pinned: string;
  summaryPrevious: string;
  /** Joins summary fragments: full-width semicolon for CJK, semicolon-space for English. */
  summaryJoiner: string;
  /** Label/value separator: full-width for CJK, colon-space for English. */
  separator: string;
  /** Header of the per-turn affect section (internal guidance, never read aloud). */
  affectHeader: string;
}

export const PROMPT_LABELS: Record<Language, PromptLabels> = {
  zh: {
    user: '用户', assistant: '助手',
    memoryHeader: '## 记忆参考（可能不准确，注意「用户」与「助手」的区别）',
    summaryHeader: '## 对话摘要', recentHeader: '## 最近对话', empty: '（暂无）',
    fact: '事实', relationship: '关系', episode: '上次话题（概括，非原话）', addressing: '称呼',
    profile: '基本情况', pinned: '用户让你记住',
    summaryPrevious: '已有摘要', summaryJoiner: '；', separator: '：',
    affectHeader: '## 此刻（内部参考）',
  },
  ja: {
    user: 'ユーザー', assistant: 'アシスタント',
    memoryHeader: '## 記憶の参考（不正確な場合があります。「ユーザー」と「アシスタント」の区別に注意）',
    summaryHeader: '## 会話の要約', recentHeader: '## 最近の会話', empty: '（なし）',
    fact: '事実', relationship: '関係', episode: '前回の話題（要約、原文ではない）', addressing: '呼び方',
    profile: '基本情報', pinned: 'ユーザーが覚えてと頼んだこと',
    summaryPrevious: '既存の要約', summaryJoiner: '；', separator: '：',
    affectHeader: '## いまの様子（内部参考）',
  },
  en: {
    user: 'User', assistant: 'Assistant',
    memoryHeader: '## Memory reference (may be inaccurate; distinguish "User" from "Assistant")',
    summaryHeader: '## Conversation summary', recentHeader: '## Recent conversation', empty: '(none)',
    fact: 'Fact', relationship: 'Relationship', episode: 'Previous topic (summary, not verbatim)', addressing: 'Address as',
    profile: 'Basic facts', pinned: 'The user asked you to remember',
    summaryPrevious: 'Existing summary', summaryJoiner: '; ', separator: ': ',
    affectHeader: '## Right now (internal reference)',
  },
};
