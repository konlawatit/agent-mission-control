const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Extracts git branch and dirty file count for a workspace directory.
 */
function getGitMetadata(cwd) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { branch: 'main', dirtyFiles: 0 };
  }
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1200,
    })
      .toString()
      .trim();

    const statusOutput = execSync('git status --porcelain', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1200,
    })
      .toString()
      .trim();

    const dirtyFiles = statusOutput
      ? statusOutput.split(/\r?\n/).filter(Boolean).length
      : 0;

    return { branch: branch || 'main', dirtyFiles };
  } catch {
    return { branch: 'local', dirtyFiles: 0 };
  }
}

/**
 * Parses the tail of a Claude Code transcript (.jsonl) file to extract:
 * - Latest human-readable assistant response (for Auto-TL;DR without reading terminal scrollback)
 * - Latest user prompt (if not already captured)
 * - Active or completed Task (sub-agent) invocations
 */
function parseTranscriptTail(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return null;
  }

  try {
    const stat = fs.statSync(transcriptPath);
    const maxBytes = 128 * 1024; // Read last 128KB for speed
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);

    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buffer, 0, length, start);
    fs.closeSync(fd);

    const raw = buffer.toString('utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));

    let lastAssistantText = null;
    let lastUserText = null;
    const subAgentsMap = new Map();

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = entry.message || entry;
      const role = msg.role || entry.type;
      const content = msg.content;

      if (role === 'user' && typeof content === 'string' && content.trim()) {
        lastUserText = content.trim();
      } else if (role === 'user' && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text && !block.text.startsWith('<')) {
            lastUserText = block.text.trim();
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            if (subAgentsMap.has(block.tool_use_id)) {
              const sub = subAgentsMap.get(block.tool_use_id);
              sub.state = block.is_error ? 'failed' : 'done';
              sub.tool = 'Completed';
              if (typeof block.content === 'string') {
                sub.resultSummary = summarizeText(block.content, 140);
              } else if (Array.isArray(block.content)) {
                const textBlock = block.content.find((b) => b.type === 'text');
                if (textBlock && textBlock.text) {
                  sub.resultSummary = summarizeText(textBlock.text, 140);
                }
              }
            }
          }
        }
      }

      if (role === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text && block.text.trim()) {
            lastAssistantText = block.text.trim();
          }
          if (
            block.type === 'tool_use' &&
            (block.name === 'Task' || block.name === 'Agent' || block.name === 'dispatch_agent')
          ) {
            const input = block.input || {};
            const subName =
              input.description ||
              input.subagent_type ||
              input.name ||
              'Sub-Agent Task';
            const subRole =
              input.prompt
                ? summarizeText(input.prompt, 110)
                : input.subagent_type || 'Autonomous Sub-task';
            subAgentsMap.set(block.id, {
              id: block.id,
              name: `Sub-Agent: ${subName}`,
              role: subRole,
              subagentType: input.subagent_type || 'general',
              state: 'working',
              tool: 'Running Task...',
              startedAt: entry.timestamp || new Date().toISOString(),
            });
          }
        }
      }
    }

    return {
      lastAssistantText: lastAssistantText ? summarizeText(lastAssistantText, 240) : null,
      lastUserText: lastUserText ? summarizeText(lastUserText, 160) : null,
      subAgents: Array.from(subAgentsMap.values()),
    };
  } catch {
    return null;
  }
}

function summarizeText(text, maxLen = 200) {
  if (!text) return '';
  const cleaned = String(text)
    .replace(/```[\s\S]*?```/g, '[โค้ด/คำสั่ง]')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + '…';
}

/**
 * Infers the 4-stage workflow index (0: Plan, 1: Code, 2: Verify, 3: Done)
 * and a human-readable Thai+EN action summary from a Claude tool call.
 */
function inferWorkflowFromTool(toolName, toolInput = {}) {
  const name = String(toolName || '');
  const filePath =
    toolInput.file_path ||
    toolInput.path ||
    toolInput.notebook_path ||
    toolInput.pattern ||
    '';
  const shortFile = filePath ? path.basename(String(filePath)) : '';

  if (['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite'].includes(name)) {
    const detail = shortFile
      ? `กำลังอ่านและสำรวจ ${shortFile}`
      : toolInput.pattern
      ? `กำลังค้นหาโค้ด "${toolInput.pattern}"`
      : `กำลังสำรวจโครงสร้างและวางแผน (${name})`;
    return {
      stageIndex: 0,
      stageName: 'plan',
      toolBadge: `${name}${shortFile ? ': ' + shortFile : ''}`,
      tldr: detail,
      modifiedFile: null,
    };
  }

  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
    return {
      stageIndex: 1,
      stageName: 'code',
      toolBadge: `${name}: ${shortFile || 'file'}`,
      tldr: `กำลังแก้ไขไฟล์ ${shortFile || 'โค้ดในโปรเจกต์'} (${name})`,
      modifiedFile: filePath ? String(filePath) : null,
    };
  }

  if (name === 'Task' || name === 'Agent') {
    const desc =
      toolInput.description ||
      toolInput.subagent_type ||
      summarizeText(toolInput.prompt || 'งานย่อย', 60);
    return {
      stageIndex: 1,
      stageName: 'code',
      toolBadge: `Sub-Agent: ${desc}`,
      tldr: `แตก Sub-Agent (${desc}) เพื่อแยกทำงานขนาน`,
      modifiedFile: null,
      isSubAgent: true,
    };
  }

  if (name === 'Bash') {
    const cmd = String(toolInput.command || '').trim();
    const isTestOrVerify =
      /\b(test|jest|vitest|mocha|pytest|playwright|cypress|lint|eslint|tsc|typecheck|check|verify|build|cargo\s+test|go\s+test)\b/i.test(
        cmd
      );
    const shortCmd = summarizeText(cmd, 70);
    return {
      stageIndex: isTestOrVerify ? 2 : 1,
      stageName: isTestOrVerify ? 'verify' : 'code',
      toolBadge: `Bash: ${shortCmd}`,
      tldr: isTestOrVerify
        ? `กำลังรันทดสอบ/ตรวจสอบระบบ: ${shortCmd}`
        : `กำลังรันคำสั่ง Terminal: ${shortCmd}`,
      modifiedFile: null,
    };
  }

  return {
    stageIndex: 1,
    stageName: 'code',
    toolBadge: name || 'Tool',
    tldr: `กำลังเรียกใช้งาน ${name}`,
    modifiedFile: null,
  };
}

module.exports = {
  getGitMetadata,
  parseTranscriptTail,
  summarizeText,
  inferWorkflowFromTool,
};
