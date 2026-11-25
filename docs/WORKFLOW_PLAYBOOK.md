# 🧭 คู่มือจัดระเบียบ Workflow การทำงานแบบ Multi-Agent (Workflow Playbook)

คู่มือฉบับปฏิบัติจริงสำหรับลดภาระสมองเวลาต้องคุม Claude CLI หรือ Agent หลายๆ ตัวพร้อมกัน และขั้นตอนการตั้งค่าเมื่อย้ายเครื่องคอมพิวเตอร์

---

## 1. กฎเหล็ก 3 ข้อเพื่อลดภาระสมอง (Zero-Cognitive-Load Rules)

### กฎข้อที่ 1: "1 ห้อง = 1 เป้าหมายชัดเจน + 1 โฟลเดอร์แยก (Git Worktree)"
อย่าเปิด Claude 3 Tabs ในโฟลเดอร์เดียวกันแล้วสั่งแก้โค้ดพร้อมกัน เพราะไฟล์จะทับกันและ Git Status จะปนกันมั่ว ให้ใช้ `git worktree` แยกห้องดังนี้:

```powershell
# สมมติโปรเจกต์หลักอยู่ที่ C:\Repo\my-app
cd C:\Repo\my-app

# แตกห้องที่ 1 สำหรับทำระบบ Auth
git worktree add ..\my-app-auth -b feat/auth

# แตกห้องที่ 2 สำหรับทำระบบ Payment
git worktree add ..\my-app-payment -b feat/payment
```
เมื่อเปิด Claude ในแต่ละ Worktree หน้าจอ **Agent Mission Control** จะแยกการ์ดห้องพร้อมแสดงชื่อ Branch (`feat/auth`, `feat/payment`) และจำนวนไฟล์ที่แก้ของใครของมันอย่างชัดเจน!

---

### กฎข้อที่ 2: "ห้ามเปิดไล่ดูทีละ Tab — ให้ดูที่ Attention Queue บน Dashboard เท่านั้น"
เปลี่ยนนิสัยจากการกด `Ctrl+Tab` วนดูทีละหน้าต่าง มาเป็นการเปิดหน้าจอ **Agent Mission Control (`http://127.0.0.1:4310`)** ทิ้งไว้ที่จอด้านข้าง:
- **ถ้าแถบสีเหลือง (`⚠️ รอคุณตัดสินใจ`) ไม่ขึ้น**: แปลว่าทุกห้องกำลังทำงานของมันอยู่ คุณไม่ต้องไปยุ่งกับมันเลย
- **ถ้าห้องไหนขึ้นสีเหลือง (`รอ Approve`)**: อ่านแค่บรรทัด `คำสั่งที่รอ Approve` บนหน้าเว็บ แล้วกดปุ่ม **Approve** หรือสลับไปเฉพาะ Tab นั้น
- **ถ้าห้องไหนขึ้นสีเขียว (`เสร็จสิ้น`)**: อ่านแค่ช่อง **📌 Auto-TL;DR** (2 บรรทัด) เพื่อตรวจผลลัพธ์ แล้วพิมพ์คำสั่งถัดไปจากช่องด้านล่างได้เลย

---

### กฎข้อที่ 3: "ตั้งชื่อห้อง (`AMC_ROOM`) ให้สื่อถึงภารกิจก่อนรัน"
เพื่อให้มองปราดเดียวรู้เรื่องว่าห้องไหนทำอะไร แนะนำให้สร้างฟังก์ชันสั้นๆ ไว้ใน PowerShell Profile (`$PROFILE`):

```powershell
# เพิ่มฟังก์ชันนี้ลงในไฟล์ $PROFILE ของ PowerShell
function cr($roomName) {
    $env:AMC_ROOM = $roomName
    claude
}
```
เวลาใช้งานจริงในแต่ละ Tab แค่พิมพ์:
```powershell
cr "Room 01 • ระบบ Login OAuth"
```
การ์ดบนหน้าเว็บ Mission Control จะแสดงชื่อ **`Room 01 • ระบบ Login OAuth`** ทันที!

---

## 2. การใช้งานคู่กับ WezTerm (แนะนำสำหรับสาย Power User)

หากคุณต้องการส่งคีย์บอร์ดจากหน้าเว็บ Dashboard ทะลุเข้าไปใน Terminal Tab ที่กำลังเปิด Interactive `claude` ค้างไว้แบบ 100%:
1. ติดตั้ง [WezTerm](https://wezfurlong.org/wezterm/) (รองรับทั้ง Windows, macOS, Linux)
2. เมื่อรัน `claude` ใน WezTerm ตัวแปร `WEZTERM_PANE` จะถูกส่งเข้า Agent Mission Control อัตโนมัติ
3. เมื่อคุณกดปุ่ม **`✓ Approve (y)`** หรือพิมพ์ข้อความในช่อง **สั่งการไปยัง Room...** บนหน้าเว็บ ข้อความจะถูกพิมพ์เข้า Pane นั้นของ WezTerm ทันทีผ่าน `wezterm cli send-text`!

---

## 3. Checklist เวลาเปลี่ยนเครื่องคอมพิวเตอร์ (Machine Migration Checklist)

เมื่อคุณย้ายไปทำงานอีกเครื่องหนึ่ง ให้ทำตาม 3 ขั้นตอนนี้ (ใช้เวลาไม่เกิน 1 นาที):

- [ ] **ขั้นที่ 1: Clone โปรเจกต์ลงเครื่องใหม่**
  ```powershell
  git clone <YOUR_PUBLIC_GIT_URL> C:\Repo\agent-mission-control
  cd C:\Repo\agent-mission-control
  ```
- [ ] **ขั้นที่ 2: รันสคริปต์ Setup ประจำ OS**
  - บน Windows:
    ```powershell
    powershell -ExecutionPolicy Bypass -File .\setup.ps1
    ```
  - บน macOS / Linux / WSL:
    ```bash
    chmod +x setup.sh && ./setup.sh
    ```
  *(สคริปต์นี้จะไปผูก Hook เข้ากับ `~/.claude/settings.json` ของเครื่องใหม่ให้อัตโนมัติ โดยไม่ลบตั้งค่าเดิมของคุณ)*
- [ ] **ขั้นที่ 3: รันเซิร์ฟเวอร์ Dashboard**
  ```powershell
  npm start
  ```
  หน้าเว็บ `http://127.0.0.1:4310` จะเปิดขึ้นมาพร้อมรับข้อมูลจากทุก Claude CLI Tab บนเครื่องใหม่ทันที!
