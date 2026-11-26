# 🎛️ Agent Mission Control (`amc`)

> **ศูนย์บัญชาการและติดตามสถานะ Multi-Agent / Claude Code CLI แบบ Real-time**  
> แก้ปัญหาการเปิดหลาย Terminal Tabs แล้วต้องคอยสลับไปไล่อ่าน History ย้อนหลังทีละหน้าต่าง

---

## 🎯 ปัญหาที่โปรเจกต์นี้แก้ (Why Agent Mission Control?)

เมื่อเราเปิด **Claude Code (`claude`)** หรือ Coding Agent หลายๆ Session พร้อมกันในหลาย Terminal Tabs:
1. **Context-Switching Tax**: ทุกครั้งที่สลับ Tab สมองต้องอ่าน Scrollback Log หลายร้อยบรรทัดเพื่อรื้อฟื้นความจำว่าห้องนี้ทำถึงไหนแล้ว
2. **มองไม่เห็น Sub-Agents**: เวลา Agent หลักแตกงานย่อย (`Task` / Sub-agents) ข้อมูลถูกกลืนไปใน Text Stream
3. **ไม่รู้ว่าห้องไหนค้างรอเรา**: ต้องคอยเดินตรวจทีละ Tab ว่ามีห้องไหนติด Permission Prompt หรือรอกด Approve อยู่หรือเปล่า

**Agent Mission Control (`amc`)** เปลี่ยนรูปแบบการทำงานจาก **"คนเดินตรวจทีละ Tab (Pull)"** เป็น **"ระบบส่งสถานะเข้าศูนย์กลางอัตโนมัติ (Event-Driven Push)"**:
- 📊 **4-Stage Workflow Pipeline**: เห็นทันทีว่าแต่ละห้องอยู่ขั้นตอนไหน (`1. Plan` → `2. Code` → `3. Verify` → `4. Done`)
- 📌 **Auto-TL;DR Summary**: สกัดข้อความสรุปล่าสุดจาก Claude Transcript อัตโนมัติ **ไม่ต้องอ่าน Log ยาวๆ**
- 🌳 **Live Sub-Agent Tree**: แสดงโครงสร้าง `Main Agent → Sub-Agents` พร้อมสถานะและ Tool ที่กำลังรัน
- ⚠️ **Attention Queue**: แจ้งเตือนเฉพาะห้องที่รอคุณตัดสินใจ (รอ Approve / ติดปัญหา) ไว้ด้านบนสุด
- 🔔 **แจ้งเตือนของระบบ**: กดกระดิ่งใน sidebar เพื่อให้ Windows แจ้งเตือนเมื่อห้องไหนรอคุณหรือทำเสร็จ (ไม่เตือนห้องที่เปิดดูอยู่) กดแจ้งเตือนเพื่อเปิดห้องนั้นทันที และชื่อแท็บจะขึ้นจำนวนห้องที่รอคุณ เช่น `(2) Mission Control`
- ⌨️ **Bi-Directional Command Center**: สั่งการหรือกด Approve ส่งกลับไปยังแต่ละ Session ได้จากหน้าจอเดียว (ผ่าน WezTerm IPC, CLI Wrapper, หรือ `claude --resume`)
- 🗂️ **ไฟล์ที่แก้ไข + Web IDE**: กดดูรายการไฟล์ที่เปลี่ยน แล้วเปิดดู Diff / Source แบบเต็มจอ หรือกดเลขบรรทัดเพื่อเปิดไฟล์นั้นใน VS Code ที่บรรทัดนั้นทันที (ผ่าน `vscode://` link ไม่ผ่าน shell)
- ✦ **เปลี่ยน Model / Effort**: เลือก Opus / Sonnet / Haiku / Fable และ effort `low` ถึง `max` ระบบส่ง `/model` และ `/effort` เข้า terminal ของห้องนั้นให้
- 📈 **เช็ค usage เมื่อกดปุ่ม**: ปุ่ม "เช็คตอนนี้" ในแผง Usage พิมพ์ `/usage` ใน Claude Code ที่ว่างอยู่หนึ่งห้อง อ่าน % ที่เหลือของรอบ 5 ชม. และรอบสัปดาห์ แล้วกด Esc ปิดให้ (ไม่ใช้ token ไม่ดึงเองตลอดเวลา และดูเป็นภาพรวมของแพลน ไม่แยกต่อห้อง) ส่วน context ของแต่ละห้องกดปุ่ม "เช็ค context" ที่หัวห้องเพื่ออ่านจาก transcript ได้ตอนที่ต้องการ
- ⏸️ **พักงานอัตโนมัติเมื่อ usage เหลือ < 8%**: บันทึก checkpoint ทุกห้อง ปล่อยให้ step ที่กำลังทำจบก่อน แล้วพักคำสั่งใหม่จนกว่า usage จะ reset จากนั้นสั่งห้องที่งานค้างให้ทำต่อเอง

---

## 🚀 วิธีติดตั้งและใช้งานเมื่อย้ายเครื่องใหม่ (1-Command Portable Setup)

โปรเจกต์นี้ออกแบบให้เป็น **Zero-External-Dependency (Pure Node.js >= 18)** เพื่อให้ย้ายคอมพิวเตอร์ได้ง่ายที่สุด ไม่ต้องกังวลเรื่อง Native Module พังข้าม OS

### 1. สำหรับ Windows (PowerShell)
```powershell
git clone <YOUR_REPO_URL> C:\Repo\agent-mission-control
cd C:\Repo\agent-mission-control

# รันสคริปต์ติดตั้งอัตโนมัติ (ผูก Claude Hooks + ลงทะเบียนคำสั่ง amc)
powershell -ExecutionPolicy Bypass -File .\setup.ps1

# เปิดหน้าจอ Mission Control Dashboard (http://127.0.0.1:4310)
npm start
```

### 2. สำหรับ macOS / Linux / WSL
```bash
git clone <YOUR_REPO_URL> ~/agent-mission-control
cd ~/agent-mission-control

chmod +x setup.sh && ./setup.sh
npm start
```

---

## 🛠️ คำสั่ง CLI ทั้งหมด (`amc` หรือ `npm run ...`)

| คำสั่ง | คำอธิบาย |
| :--- | :--- |
| `npm start` หรือ `amc start` | เปิดเซิร์ฟเวอร์ Mission Control และเปิด Web Dashboard บน `http://127.0.0.1:4310` เซิร์ฟเวอร์จะเชื่อม Claude Code hooks ให้เองระหว่างที่เปิดอยู่ และถอดออกเมื่อปิด |
| `amc start --no-manage-hooks` | เปิดเซิร์ฟเวอร์โดยไม่แตะ `~/.claude/settings.json` (หรือตั้ง `AMC_MANAGE_HOOKS=0`) ใช้คู่กับสองคำสั่งด้านล่างเมื่ออยากผูก hooks ค้างไว้เอง |
| `npm run install-hooks` หรือ `amc install-hooks` | ผูก Claude Code Lifecycle Hooks เข้ากับ `~/.claude/settings.json` ด้วยตัวเอง Hooks ที่ติดตั้งแบบนี้จะค้างอยู่แม้ปิดเซิร์ฟเวอร์ และ Claude Code จะขึ้นคำเตือนทุก tool call ระหว่างที่เซิร์ฟเวอร์ไม่ได้เปิด |
| `amc uninstall-hooks` | ถอนการติดตั้ง Claude Hooks ออกจาก `~/.claude/settings.json` |
| `amc uninstall-statusline` | ถอด statusline usage bridge ของเวอร์ชันก่อน (ที่เคยติดตั้งด้วย `amc install-statusline`) และคืน statusline เดิม `amc start` ทำให้เองอยู่แล้ว ยกเว้นตอนใช้ `--no-manage-hooks` |
| `npm run status` หรือ `amc status` | แสดงตารางสรุปสถานะของทุกห้อง, TL;DR และ Sub-Agents บนหน้าจอ Terminal |
| `amc run --room "ชื่อห้อง" claude` | เปิดรัน Claude (หรือ Agent ตัวอื่น) ภายใต้ Wrapper ที่เชื่อมกับ Dashboard โดยตรง |
| `npm test` | รันชุดทดสอบ State Store, Sub-agent Tracker, Hooks และชุดทดสอบความปลอดภัย (token, Host/Origin, command injection, XSS) |

---

## 🔄 วิธีการทำงานในชีวิตประจำวัน (3 โหมดการใช้งาน)

### โหมดที่ 1: เปิด Terminal Tab ปกติของคุณ (Passive Auto-Discovery)
ระหว่างที่ `npm start` เปิดอยู่ (เซิร์ฟเวอร์เชื่อม hooks ให้เอง ไม่ต้องติดตั้งแยก):
- คุณเปิด Windows Terminal, PowerShell, WezTerm หรือ VS Code Terminal กี่ Tab ก็ได้ แล้วพิมพ์ `claude` ตามปกติ
- ทันทีที่ Claude เริ่มทำงาน Claude Code จะส่ง event ของตัวเองผ่าน HTTP hook ตรงมาที่เซิร์ฟเวอร์ สถานะห้อง, Git Branch, ขั้นตอน Workflow, Sub-Agents ที่ถูกแตกออกมา และข้อความสรุป Auto-TL;DR จึงขึ้นบนหน้าเว็บ `http://127.0.0.1:4310` อัตโนมัติ
- HTTP hook ไม่เปิด process ใหม่ต่อ event (ต่างจาก hook แบบ command ที่ต้องรัน `bash` และ `node` ทุกครั้ง) มีเพียง `SessionStart` ที่ยังรัน `hooks/claude-hook.js` หนึ่งครั้งตอนเริ่ม session เพราะ Claude Code ไม่รองรับ HTTP ใน event นี้
- เมื่อปิดเซิร์ฟเวอร์ hooks จะถูกถอดออก Claude Code จึงไม่เสียอะไรและไม่ขึ้นคำเตือนตอนที่ไม่ได้เปิด Mission Control ถ้าเซิร์ฟเวอร์ถูก kill แบบบังคับ hooks จะค้างอยู่จนกว่าจะเปิดใหม่หรือรัน `amc uninstall-hooks`
- ต้องใช้ Claude Code รุ่นที่รองรับ hook แบบ `type: "http"` (ทดสอบกับ 2.1.332)
- Token ที่เขียนลง `~/.claude/settings.json` เป็น token เฉพาะ hook ใช้ส่ง event ได้อย่างเดียว เปิด API ส่วนอื่นของ Mission Control ไม่ได้
- ถ้าเปิดเซิร์ฟเวอร์มากกว่าหนึ่งตัว (คนละ port) ตัวที่เปิดทีหลังจะเป็นเจ้าของ hooks และการปิดตัวหนึ่งจะไม่ถอด hooks ของอีกตัว
- ถ้าอยากตั้งชื่อห้องให้สื่อความหมายชัดเจนก่อนรัน `claude` (ต้องเปิด Mission Control ไว้ก่อน เพราะชื่อห้องถูกส่งตอนเริ่ม session):
  ```powershell
  $env:AMC_ROOM="Room 01 • Auth Refactor"; claude
  ```

### โหมดที่ 2: เปิดห้องทำงานใหม่จากหน้าเว็บ Dashboard (Centralized Launch)
1. กดปุ่ม **"+ เปิดห้อง Agent ใหม่"** บนหน้าเว็บ
2. ระบุชื่อห้อง, โฟลเดอร์โปรเจกต์ (`cwd`), และเป้าหมายเริ่มต้น
3. เลือกได้ว่าจะให้ **เปิด Tab ใหม่ใน Windows Terminal อัตโนมัติ** หรือ **รัน Claude ในพื้นหลัง**

### โหมดที่ 3: สั่งการจากหน้า Dashboard กลับไปยัง Session
จากหน้าเว็บ Mission Control คุณสามารถพิมพ์คำสั่งหรือกดปุ่มลัด (**Approve**, **สั่งรัน Test**, **ขอสรุปงาน**) เพื่อส่งกลับไปที่ Session ได้ผ่าน:
- **WezTerm IPC**: หากคุณใช้ WezTerm ระบบจะตรวจจับ `WEZTERM_PANE` อัตโนมัติและส่งคีย์บอร์ดเข้า Tab นั้นทันที
- **Claude Headless Resume (`--resume`)**: สั่งรันต่อจาก `session_id` เดิมของ Claude CLI ในโฟลเดอร์นั้นโดยไม่ต้องสลับหน้าต่างไปพิมพ์ใน Terminal

---

## 🤖 งานอัตโนมัติ (`claude -p` และ Agent SDK)

session ที่สคริปต์หรือเครื่องมือรัน (`entrypoint: sdk-*` เช่น e2e-forge) ไม่มีห้องใน dashboard แต่ดูสรุปได้ที่เมนู **งานอัตโนมัติ** แยกตามโฟลเดอร์ที่รัน (เช่น `.worktrees/partner`):
- จำนวนรันต่อชั่วโมงเป็นกราฟแท่ง ส่วนที่ไม่สำเร็จเป็นสีชมพู ชั่วโมงที่ไม่มีงานเห็นเป็นช่องว่าง พร้อมประโยคบอกช่วงที่ว่างนานที่สุด
- token ที่ใช้ รันที่ไม่สำเร็จพร้อมเหตุผล (จบกลางคันเช่นติด "This command requires approval", API error, ถูกหยุด, ไม่ได้ตอบ) และรันล่าสุด กดแต่ละรันเพื่ออ่านบทสนทนา
- เลือกช่วง 24 ชม. / 3 วัน / 7 วัน อัปเดตทุก 30 วินาทีระหว่างเปิดหน้านี้
- ข้อมูลอ่านจาก transcript ใต้ `~/.claude/projects` อย่างเดียว ไฟล์ที่ไม่เปลี่ยนไม่ถูกอ่านซ้ำ และไฟล์ที่ยาวขึ้นอ่านเฉพาะส่วนที่ต่อท้าย (API: `GET /api/automated?hours=24`)

---

## ⏸️ พักงานอัตโนมัติเมื่อ Usage ใกล้หมด (Usage Guard)

- **แหล่งข้อมูล**: ผลเช็คล่าสุดจากปุ่ม "เช็คตอนนี้" ในแผง Usage (`POST /api/usage/check`): เลือก Claude Code ที่ว่างอยู่หนึ่งห้อง (ไม่ได้ทำงาน ไม่มีคำถามค้าง ช่องพิมพ์ว่าง ห้องที่เปิดดูอยู่ก่อน) พิมพ์ `/usage` อ่านตัวเลขจากหน้าจอ แล้วกด Esc ปิด `/usage` เป็นคำสั่งในเครื่องจึงไม่ใช้ token และไม่ถูกบันทึกเป็นงานของห้อง ระบบไม่เช็คเองอัตโนมัติ ถ้ายังไม่เคยเช็ค หรือรอบที่เช็คไว้ reset ไปแล้ว ระบบจะไม่พักงานเอง (ใช้ได้บน Windows ที่เปิด Claude Code ใน terminal)
- **เมื่อเหลือน้อยกว่าเกณฑ์ (ค่าเริ่มต้น 8%)**: บันทึก checkpoint ทุกห้องไว้ที่ `~/.agent-mission-control/checkpoints/` ห้องที่กำลังทำงานจะได้ทำ step ปัจจุบันให้จบก่อน (checkpoint อัปเดตอีกครั้งเมื่อจบ) จากนั้นพักคำสั่งใหม่ทั้งจาก dashboard และที่พิมพ์ใน terminal (ผ่าน hook `UserPromptSubmit`) ส่วนการกด Approve ยังทำได้
- **เมื่อถึงเวลา reset**: ปลดพักเอง (ตั้งเวลาไว้ครั้งเดียวตามเวลา reset ไม่มีการวนเช็ค) แล้วส่ง prompt ให้ห้องที่ยังมีงานค้างทำต่อจาก checkpoint ถ้าเช็คใหม่แล้วเป็นรอบถัดไปที่เหลือเกินเกณฑ์ ก็ปลดพักทันที ถ้าต้องการปลดพักก่อนเวลา กด "ทำต่อเลย" ใน dashboard หรือปิดสวิตช์พักงานอัตโนมัติในแผง Usage

---

## 🔒 ความปลอดภัย (Security Model)

Mission Control ส่งคีย์และคำสั่งเข้า Terminal ของ Claude และเปิด Terminal ใหม่ได้ จึงต้องป้องกันไม่ให้ใครสั่งการเซิร์ฟเวอร์นี้ได้นอกจากคุณเอง:

- **API Token**: ตอนเริ่มทำงานครั้งแรก เซิร์ฟเวอร์จะสร้าง token แบบสุ่มเก็บไว้ที่ `~/.agent-mission-control/token` ทุก `/api/*` ต้องแนบ header `X-AMC-Token` (Hook, `amc status` และหน้าเว็บจัดการให้อัตโนมัติ) หากต้องการเปลี่ยน token ให้ลบไฟล์นี้แล้วรีสตาร์ทเซิร์ฟเวอร์
- **รับเฉพาะ Host และ Origin ของเครื่องตัวเอง**: เซิร์ฟเวอร์ปฏิเสธ request ที่ `Host`/`Origin` ไม่ใช่ `127.0.0.1` / `localhost` / `[::1]` (กัน DNS rebinding และเว็บไซต์อื่นที่พยายามยิง request เข้ามา) และไม่มี CORS แบบ `*`
- **ไม่ต่อ string เป็นคำสั่ง shell**: คำสั่งที่เปิด Terminal ถูกสร้างฝั่งเซิร์ฟเวอร์เท่านั้น ส่วนชื่อห้องและ path จะส่งเข้า PowerShell เป็น literal ที่ quote แล้วผ่าน `-EncodedCommand` ส่วนโหมด Headless ส่ง prompt ผ่าน stdin
- **หน้าเว็บไม่มี inline JS ที่ฝังข้อมูล**: ปุ่มต่างๆ ใช้ `data-act` และ event delegation ข้อความจากหน้าจอ Terminal จึงถูกแปลงเป็นโค้ดไม่ได้

> ⚠️ อย่าเปลี่ยนให้เซิร์ฟเวอร์ listen บน `0.0.0.0` หรือเปิดพอร์ต 4310 ออกนอกเครื่อง

---

## 📚 เอกสารการออกแบบและสถาปัตยกรรม (Documentation in Repo)

เอกสารการออกแบบทั้งหมดถูกเก็บรวมไว้ในโฟลเดอร์ [`docs/`](./docs/) เพื่อให้เปิดอ่านหรือต่อยอดได้ทุกเครื่อง:
- 📐 [**สถาปัตยกรรมและการออกแบบระบบ (`docs/ARCHITECTURE_AND_DESIGN.md`)**](./docs/ARCHITECTURE_AND_DESIGN.md) — อธิบายโครงสร้าง 4-Layer Architecture, แผนภาพ Mermaid, การแปลง Tool Events เป็น Workflow Stage, การสกัด Sub-Agent Tree และกลไก Command Bridge
- 🧭 [**คู่มือจัดระเบียบ Workflow การทำงาน (`docs/WORKFLOW_PLAYBOOK.md`)**](./docs/WORKFLOW_PLAYBOOK.md) — เทคนิคการจัดห้องทำงานด้วย Git Worktrees, การใช้ WezTerm / Windows Terminal คู่กับ Mission Control และ Checklist เวลาเปลี่ยนเครื่องคอมพิวเตอร์

---

## 📄 License
MIT License — Open Source & Public Ready.
