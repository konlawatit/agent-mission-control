/**
 * Claude's AskUserQuestion prompts, from structured data instead of the terminal screen.
 *
 * The screen is read cell by cell, and Windows returns U+FFFD for a cell that holds a letter
 * with combining marks (most Thai syllables), so on-screen questions arrive garbled and only
 * the question currently shown is visible. The tool input (from the PreToolUse hook or the
 * transcript) has every question exactly. The screen still says which question is on screen,
 * where the cursor is, and which questions are answered; this module merges the two.
 */

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

const str = (v, max) => String(v == null ? '' : v).slice(0, max);

/** A safe, bounded copy of AskUserQuestion's `questions` input, or null if there are none. */
function sanitizeQuestions(questions) {
  if (!Array.isArray(questions)) return null;
  const out = questions
    .slice(0, MAX_QUESTIONS)
    .filter((q) => q && typeof q === 'object' && Array.isArray(q.options))
    .map((q) => ({
      header: str(q.header, 60),
      question: str(q.question, 600),
      multiSelect: Boolean(q.multiSelect),
      options: q.options.slice(0, MAX_OPTIONS).map((o) =>
        typeof o === 'string'
          ? { label: str(o, 200), description: '', preview: '' }
          : { label: str(o && o.label, 200), description: str(o && o.description, 400), preview: str(o && o.preview, 2000) }
      ),
    }));
  return out.length ? out : null;
}

/** The prompt shown before the screen has been read: the first question, cursor on option 1. */
function promptFromQuestions(questions) {
  const q = questions[0];
  return {
    question: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    context: [],
    currentIndex: 1,
    options: q.options.map((o, i) => ({
      index: i + 1,
      number: String(i + 1),
      label: o.label,
      description: o.description,
      preview: o.preview,
      active: i === 0,
    })),
    footer: '',
    questions,
    activeQuestion: 0,
    source: 'claude',
  };
}

function lcsLength(a, b) {
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = up;
    }
  }
  return prev[b.length];
}

const comparable = (t) => Array.from(String(t || '').replace(/�/g, '').replace(/\s+/g, '')).slice(0, 400);

/**
 * Which question the screen is showing: the one whose text best contains the surviving
 * (non-garbled) characters of the on-screen question, in order. -1 when none fits, such as
 * the final "submit your answers" step.
 */
function matchQuestionIndex(screenQuestion, questions) {
  const s = comparable(screenQuestion);
  if (s.length < 4) return -1;
  let best = -1;
  let bestScore = 0;
  questions.forEach((q, i) => {
    const score = lcsLength(s, comparable(q.question)) / s.length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return bestScore >= 0.7 ? best : -1;
}

const REVIEW_RE = /review your answers|submit answers|ready to submit/i;

function isReviewStep(screenPrompt) {
  return (
    REVIEW_RE.test(screenPrompt.question || '') ||
    (screenPrompt.options || []).some((o) => REVIEW_RE.test(o.label || ''))
  );
}

/** The on-screen prompt with Claude's exact questions and option text laid over it. */
function mergeScreenPrompt(screenPrompt, ask) {
  if (!screenPrompt || !ask || !Array.isArray(ask.questions) || !ask.questions.length) {
    return screenPrompt;
  }
  const tabs = Array.isArray(screenPrompt.tabs) ? screenPrompt.tabs : [];
  const questions = ask.questions.map((q, i) => ({
    ...q,
    answered: tabs[i] ? Boolean(tabs[i].done) : false,
  }));
  const active = matchQuestionIndex(screenPrompt.question, ask.questions);
  const merged = {
    ...screenPrompt,
    context: [], // the tab bar and wrapped question lines are garbled; tabs come from `questions`
    questions,
    activeQuestion: active,
    source: 'claude',
  };
  delete merged.tabs;
  if (active < 0) {
    // The submit step sits after the last question; knowing it lets the tabs move back from it.
    merged.reviewStep = isReviewStep(screenPrompt);
    // Its own lines (e.g. "⚠ Some questions are unanswered") are worth keeping when readable.
    merged.context = (screenPrompt.context || []).filter((l) => !l.includes('�'));
    return merged; // keep the screen's own options (Submit answers / Cancel)
  }
  const q = ask.questions[active];
  merged.question = q.question;
  merged.header = q.header;
  merged.multiSelect = q.multiSelect;
  // The TUI lists Claude's options first, then its own (type an answer, chat); keep those as read.
  merged.options = (screenPrompt.options || []).map((o, i) => {
    const src = q.options[i];
    // `claude` marks Claude's own options (the ones a multi-select answer is made of).
    return src ? { ...o, label: src.label, description: src.description, preview: src.preview, claude: true } : o;
  });
  return merged;
}

module.exports = {
  sanitizeQuestions,
  promptFromQuestions,
  matchQuestionIndex,
  mergeScreenPrompt,
};
