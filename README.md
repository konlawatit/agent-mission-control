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
- ⌨️ **Bi-Directional Command Center**: สั่งการหรือกด Approve ส่งกลับไปยังแต่ละ Session ได้จากหน้าจอเดียว (ผ่าน WezTerm IPC, CLI Wrapper, หรือ `claude --resume`)

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
| `npm start` หรือ `amc start` | เปิดเซิร์ฟเวอร์ Mission Control และเปิด Web Dashboard บน `http://127.0.0.1:4310` |
| `npm run install-hooks` หรือ `amc install-hooks` | ผูก Claude Code Lifecycle Hooks เข้ากับ `~/.claude/settings.json` อัตโนมัติ |
| `amc uninstall-hooks` | ถอนการติดตั้ง Claude Hooks ออกจาก `~/.claude/settings.json` |
| `npm run status` หรือ `amc status` | แสดงตารางสรุปสถานะของทุกห้อง, TL;DR และ Sub-Agents บนหน้าจอ Terminal |
| `amc run --room "ชื่อห้อง" claude` | เปิดรัน Claude (หรือ Agent ตัวอื่น) ภายใต้ Wrapper ที่เชื่อมกับ Dashboard โดยตรง |
| `npm test` | รันชุดทดสอบ State Store, Sub-agent Tracker, Hooks และชุดทดสอบความปลอดภัย (token, Host/Origin, command injection, XSS) |

---

## 🔄 วิธีการทำงานในชีวิตประจำวัน (3 โหมดการใช้งาน)

### โหมดที่ 1: เปิด Terminal Tab ปกติของคุณ (Passive Auto-Discovery)
หลังจากรัน `npm run install-hooks` เพียงครั้งเดียว:
- คุณเปิด Windows Terminal, PowerShell, WezTerm หรือ VS Code Terminal กี่ Tab ก็ได้ แล้วพิมพ์ `claude` ตามปกติ
- ทันทีที่ Claude เริ่มทำงาน ตัว Hook (`hooks/claude-hook.js`) จะส่งสถานะห้อง, Git Branch, ขั้นตอน Workflow, Sub-Agents ที่ถูกแตกออกมา และข้อความสรุป Auto-TL;DR ขึ้นไปแสดงบนหน้าเว็บ `http://127.0.0.1:4310` อัตโนมัติ!
- ถ้าอยากตั้งชื่อห้องให้สื่อความหมายชัดเจนก่อนรัน `claude`:
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
