# Quick Setup Script for Windows (PowerShell)
# Run this script whenever you clone this project onto a new Windows machine:
#   powershell -ExecutionPolicy Bypass -File .\setup.ps1

$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "🎛️  Agent Mission Control — Portable Setup (Windows)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Verify Node.js
$nodeVer = node -v 2>$null
if (-not $nodeVer) {
    Write-Host "❌ ไม่พบ Node.js ในเครื่อง กรุณาติดตั้ง Node.js (>= 18) ก่อนครับ" -ForegroundColor Red
    exit 1
}
Write-Host "✅ พบ Node.js รุ่น: $nodeVer" -ForegroundColor Green

# 2. Install Claude Code Lifecycle Hooks into ~/.claude/settings.json
Write-Host "🔗 กำลังผูก Claude Code Lifecycle Hooks เข้ากับ ~/.claude/settings.json ..." -ForegroundColor Yellow
node "$PSScriptRoot\bin\amc.js" install-hooks

# 3. Link global `amc` CLI command (optional convenience)
Write-Host "📦 กำลังลงทะเบียนคำสั่ง 'amc' ให้เรียกใช้ได้จากทุกโฟลเดอร์ (npm link)..." -ForegroundColor Yellow
try {
    npm link --silent 2>$null
    Write-Host "✅ ลงทะเบียนคำสั่ง 'amc' สำเร็จ! (พิมพ์ 'amc start' จากที่ไหนก็ได้)" -ForegroundColor Green
} catch {
    Write-Host "ℹ️ หากต้องการเรียกผ่านโฟลเดอร์นี้โดยตรง ใช้คำสั่ง: npm start" -ForegroundColor Gray
}

Write-Host ""
Write-Host "🎉 ติดตั้งเสร็จสมบูรณ์! เริ่มต้นใช้งานได้ทันทีด้วยคำสั่ง:" -ForegroundColor Green
Write-Host "   npm start          (เปิด Mission Control Dashboard บน http://127.0.0.1:4310)" -ForegroundColor White
Write-Host "   npm run status     (ดูตารางสรุปสถานะทุกห้องใน Terminal)" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan
