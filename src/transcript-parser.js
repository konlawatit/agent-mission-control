const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

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
 * Finds all Claude Code UTF-8 `.jsonl` transcript files for a workspace `cwd`
 * inside `~/.claude/projects/<project-slug>/*.jsonl`, sorted newest first.
 */
function findTranscriptsForCwd(cwd) {
  if (!cwd) return [];
  try {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return [];

    const normCwd = String(cwd)
      .split('>')[0]
      .trim()
      .replace(/[\\\/]+$/, '');
    const expectedSlug = normCwd.replace(/[:\\\/\s_]+/g, '-').toLowerCase();
    const folderBase = path
      .basename(normCwd)
      .replace(/[\s_]+/g, '-')
      .toLowerCase();

    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    const matchedFiles = [];

    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dNameLower = d.name.toLowerCase();
      if (
        dNameLower === expectedSlug ||
        dNameLower.endsWith(folderBase) ||
        dNameLower.includes(folderBase)
      ) {
        const fullDir = path.join(projectsDir, d.name);
        const files = fs
          .readdirSync(fullDir)
          .filter((f) => f.endsWith('.jsonl'));
        for (const f of files) {
          const fullFile = path.join(fullDir, f);
          const stat = fs.statSync(fullFile);
          matchedFiles.push({
            path: fullFile,
            mtimeMs: stat.mtimeMs,
            sessionId: path.basename(f, '.jsonl'),
          });
        }
      }
    }

    matchedFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matchedFiles;
  } catch {
    return [];
  }
}

function findLatestTranscriptForCwd(cwd) {
  const list = findTranscriptsForCwd(cwd);
  return list.length > 0 ? list[0].path : null;
}

/**
 * Parses a Claude Code transcript (.jsonl) file (and recent transcripts in the same folder)
 * to extract:
 * - Current / latest turn (`lastUserText`, `lastAssistantText`)
 * - Internal Turn History (`turnHistory`: every past user prompt + assistant summary & tools used inside this room!)
 * - Clean UTF-8 conversation log (`utf8Preview`)
 * - Active or completed Task (sub-agent) invocations
 */
function parseTranscriptTail(transcriptPath, cwd = null) {
  const allTranscripts = findTranscriptsForCwd(cwd);
  const targetPath =
    transcriptPath && fs.existsSync(transcriptPath)
      ? transcriptPath
      : allTranscripts.length > 0
      ? allTranscripts[0].path
      : null;

  if (!targetPath || !fs.existsSync(targetPath)) {
    return null;
  }

  try {
    // Parse up to the 3 most recent transcript files in this project folder so past conversations
    // in the same room are also preserved inside the room's Internal Turn History!
    const filesToRead =
      allTranscripts.length > 0
        ? allTranscripts.slice(0, 3).map((item) => item.path).reverse()
        : [targetPath];

    if (!filesToRead.includes(targetPath)) {
      filesToRead.push(targetPath);
    }

    let lastAssistantFullText = null;
    let lastAssistantText = null;
    let lastUserText = null;
    const conversationLines = [];
    const subAgentsMap = new Map();
    const turns = [];
    let currentTurn = null;

    for (const filePath of filesToRead) {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      const maxBytes = 160 * 1024;
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);

      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, length, start);
      fs.closeSync(fd);

      const raw = buffer.toString('utf8');
      const lines = raw
        .split(/\r?\n/)
        .filter((line) => line.trim().startsWith('{'));

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
        const ts = entry.timestamp || new Date(stat.mtimeMs).toISOString();

        const recordUserPrompt = (text) => {
          const clean = text.trim();
          if (!clean || clean.startsWith('<')) return;
          lastUserText = clean;
          conversationLines.push(`🧑 คุณ: ${clean}`);

          if (currentTurn && (currentTurn.tldr || currentTurn.tools.length > 0)) {
            turns.push(currentTurn);
          }
          currentTurn = {
            id: entry.uuid || `turn-${turns.length + 1}-${Date.now()}`,
            goal: summarizeText(clean, 180),
            tldr: '',
            tools: [],
            timestamp: ts,
            sessionId: path.basename(filePath, '.jsonl'),
          };
        };

        if (role === 'user' && typeof content === 'string') {
          recordUserPrompt(content);
        } else if (role === 'user' && Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              recordUserPrompt(block.text);
            }
            if (block.type === 'tool_result' && block.tool_use_id) {
              if (subAgentsMap.has(block.tool_use_id)) {
                const sub = subAgentsMap.get(block.tool_use_id);
                sub.state = block.is_error ? 'failed' : 'done';
                sub.tool = 'Completed';
                if (typeof block.content === 'string') {
                  sub.resultSummary = summarizeText(block.content, 140);
                } else if (Array.isArray(block.content)) {
                  const textBlock = block.content.find(
                    (b) => b.type === 'text'
                  );
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
              const clean = block.text.trim();
              lastAssistantFullText = clean;
              lastAssistantText = clean;
              conversationLines.push(`🤖 Claude:\n${clean}`);
              if (currentTurn) {
                currentTurn.tldr = summarizeText(clean, 240);
                currentTurn.timestamp = ts;
              }
            }
            if (block.type === 'tool_use') {
              const input = block.input || {};
              const fileOrCmd =
                input.command ||
                input.file_path ||
                input.path ||
                input.description ||
                input.pattern ||
                '';
              if (block.name) {
                const badge = `${block.name}${
                  fileOrCmd ? ': ' + summarizeText(path.basename(String(fileOrCmd)), 35) : ''
                }`;
                conversationLines.push(
                  `🔧 [Tool: ${block.name}] ${summarizeText(fileOrCmd, 100)}`
                );
                if (currentTurn && !currentTurn.tools.includes(badge)) {
                  currentTurn.tools.push(badge);
                }
              }
            }
            if (
              block.type === 'tool_use' &&
              (block.name === 'Task' ||
                block.name === 'Agent' ||
                block.name === 'dispatch_agent')
            ) {
              const input = block.input || {};
              const subName =
                input.description ||
                input.subagent_type ||
                input.name ||
                'Sub-Agent Task';
              const subRole = input.prompt
                ? summarizeText(input.prompt, 110)
                : input.subagent_type || 'Autonomous Sub-task';
              subAgentsMap.set(block.id, {
                id: block.id,
                name: `Sub-Agent: ${subName}`,
                role: subRole,
                subagentType: input.subagent_type || 'general',
                state: 'working',
                tool: 'Running Task...',
                startedAt: ts,
              });
            }
          }
        }
      }
    }

    if (currentTurn) {
      turns.push(currentTurn);
    }

    const recentLog = conversationLines.slice(-30).join('\n\n');

    return {
      transcriptPath: targetPath,
      lastAssistantFullText,
      lastAssistantText: lastAssistantText
        ? summarizeText(lastAssistantText, 260)
        : null,
      lastUserText: lastUserText ? summarizeText(lastUserText, 160) : null,
      utf8Preview: recentLog || lastAssistantFullText || null,
      turnHistory: turns.reverse().slice(0, 20), // Newest first
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

function inferWorkflowFromTool(toolName, toolInput = {}) {
  const name = String(toolName || '');
  const filePath =
    toolInput.file_path ||
    toolInput.path ||
    toolInput.notebook_path ||
    toolInput.pattern ||
    '';
  const shortFile = filePath ? path.basename(String(filePath)) : '';

  if (
    ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite'].includes(
      name
    )
  ) {
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
  findTranscriptsForCwd,
  findLatestTranscriptForCwd,
  parseTranscriptTail,
  summarizeText,
  inferWorkflowFromTool,
};
