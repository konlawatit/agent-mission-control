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

/** Whether the readable characters of on-screen `text` appear, in order, in `candidate`. */
function readableIn(text, candidate) {
  const s = comparable(text);
  return s.length > 0 && lcsLength(s, comparable(candidate)) / s.length >= 0.85;
}

/**
 * Whether the screen is the submit step after the last question: "Review your answers" over
 * "1. Submit answers / 2. Cancel". Only the TUI's own wording counts; a question or option of
 * Claude's that happens to say "submit answers" is still that question.
 */
function isReviewStep(screenPrompt, questions = []) {
  const claudeSays = questions
    .flatMap((q) => [q.question, ...(q.options || []).map((o) => o.label)])
    .filter((t) => REVIEW_RE.test(t || ''));
  const tuiSays = (t) => REVIEW_RE.test(t || '') && !claudeSays.some((c) => readableIn(t, c));
  return (
    [screenPrompt.question, ...(screenPrompt.context || [])].some(tuiSays) ||
    (screenPrompt.options || []).some((o) => tuiSays(o.label))
  );
}

/** A multi-question prompt's tab bar ("←  ☒ สี  ☐ ผลไม้  ✔ Submit  →"); the tabs come from `questions`. */
const isTabBar = (line) => /[←→]/.test(line) && /[☐☑☒✔✓■□]/.test(line);

/**
 * Whether garbled on-screen text is a copy of `candidate`: its readable characters appear in
 * order in the candidate, and the lengths fit (each U+FFFD stands for one or more characters, so
 * more text than that, e.g. something appended, is not a copy).
 */
function sameText(screenText, candidate) {
  const s = comparable(screenText);
  const c = comparable(candidate);
  if (!s.length || !c.length) return false;
  const shown = Array.from(String(screenText).replace(/\s+/g, '')).length; // with the � cells
  if (c.length < shown * 0.9 || c.length > shown * 2.5) return false;
  return lcsLength(s, c) / s.length >= 0.85;
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
  // The submit step first: it lists the answered questions ("● question?" / "→ answer"), and such
  // a line matches its question, whose options would then be laid over "Submit answers / Cancel".
  const reviewStep = isReviewStep(screenPrompt, ask.questions);
  const active = reviewStep ? -1 : matchQuestionIndex(screenPrompt.question, ask.questions);
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
    merged.reviewStep = reviewStep;
    // Its own lines (e.g. "⚠ Some questions are unanswered", readable answers) are worth keeping.
    merged.context = (screenPrompt.context || []).filter((l) => !l.includes('�') && !isTabBar(l));
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
  sameText,
};
