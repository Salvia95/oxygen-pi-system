# 제목이 정확히 같은 창을 찾아 PNG 로 찍거나(-Out) 닫는다(-Close). tuicap.sh 가 쓴다. 가려진 창도 PrintWindow 로 찍는다.
# 창은 최상위 창을 모두 훑어 제목으로 찾는다: 프로세스의 "주 창" 제목으로 찾으면 Windows Terminal 처럼 창이 여러 개인 프로세스에서 다른 창을 놓친다.
param([string]$Title, [string]$Out = "", [switch]$Close, [int]$Wait = 10)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // 보이는 최상위 창 가운데 제목이 주어진 글자로 시작하는 것 (mintty 는 제목 뒤에 공백 등을 채운다. 그래서 제목은 겹치지 않게 짓는다)
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512);
      GetWindowText(h, t, 512);
      if (t.ToString().StartsWith(title)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[void][Win]::SetProcessDPIAware()
$h = [IntPtr]::Zero
for ($i = 0; $i -lt $Wait * 4 -and $h -eq [IntPtr]::Zero; $i++) { $h = [Win]::Find($Title); if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 } }
if ($h -eq [IntPtr]::Zero) { Write-Output "window not found: $Title"; exit 1 }
if ($Out) {
  Start-Sleep -Milliseconds 1200
  $r = New-Object Win+RECT
  [void][Win]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [Win]::PrintWindow($h, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output "saved $Out ${w}x${ht} printwindow=$ok"
}
if ($Close) {
  [void][Win]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  if ([Win]::Find($Title) -eq [IntPtr]::Zero) { Write-Output "closed: $Title" } else { Write-Output "still open: $Title" }
}
