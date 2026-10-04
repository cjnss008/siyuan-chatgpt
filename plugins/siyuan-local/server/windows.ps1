param([ValidateSet('protect','unprotect','configure','confirm')][string]$Mode)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Security
function Protect-Token([string]$value) {
  [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}
if ($Mode -eq 'protect') { [Console]::Write((Protect-Token $inputData.token)); exit }
if ($Mode -eq 'unprotect') {
  [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($inputData.cipher), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))); exit
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SiYuanDialogWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
'@
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = 'SiYuan Local'
$form.Size = [Drawing.Size]::new(760,620)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.MinimizeBox = $false
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI',10)
$form.FormBorderStyle = 'FixedDialog'
$save = [Windows.Forms.Button]::new()
$save.Text = 'Confirm'
$save.Location = [Drawing.Point]::new(490,535)
$save.Size = [Drawing.Size]::new(110,32)
$save.DialogResult = [Windows.Forms.DialogResult]::OK
$cancel = [Windows.Forms.Button]::new()
$cancel.Text = 'Cancel'
$cancel.Location = [Drawing.Point]::new(610,535)
$cancel.Size = [Drawing.Size]::new(110,32)
$cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
$form.Controls.AddRange(@($save,$cancel))
$form.CancelButton = $cancel
# Enter does not approve accidentally. Cancel is the initially focused button.
$form.Add_Shown({
  # Restore the form explicitly, including when a parent was launched hidden.
  [void][SiYuanDialogWindow]::ShowWindowAsync($form.Handle, 9)
  [void][SiYuanDialogWindow]::SetForegroundWindow($form.Handle)
  $form.Activate()
  $cancel.Focus()
})
if ($Mode -eq 'confirm') {
  $form.Text = '思源笔记 · 写入确认'
  $form.AutoScaleMode = 'Dpi'
  $form.FormBorderStyle = 'Sizable'
  $area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $form.Size = [Drawing.Size]::new([Math]::Min(760,$area.Width-40),[Math]::Min(620,$area.Height-40))
  $form.MinimumSize = [Drawing.Size]::new(400,300)
  $form.Padding = [Windows.Forms.Padding]::new(16)
  # The footer owns the buttons, so transcript length and scrolling cannot hide them.
  $footer = [Windows.Forms.FlowLayoutPanel]::new()
  $footer.Dock = 'Bottom'
  $footer.Height = 48
  $footer.FlowDirection = 'RightToLeft'
  $footer.WrapContents = $false
  $cancel.Text = '取消'
  $save.Text = '确认写入'
  $footer.Controls.AddRange(@($cancel,$save))
  $text = [Windows.Forms.RichTextBox]::new()
  $text.ReadOnly = $true
  $text.ScrollBars = 'Both'
  $text.WordWrap = $false
  $text.DetectUrls = $false
  $text.Text = $inputData.message
  $text.Dock = 'Fill'
  $form.Controls.AddRange(@($text,$footer))
  $accepted = $form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK
  [Console]::Write((@{accepted=$accepted} | ConvertTo-Json -Compress))
} else {
  $label = [Windows.Forms.Label]::new()
  $label.Text = 'Local API URL (loopback only)'
  $label.Location = [Drawing.Point]::new(20,25)
  $label.AutoSize = $true
  $url = [Windows.Forms.TextBox]::new()
  $url.Text = $inputData.apiUrl
  $url.Location = [Drawing.Point]::new(20,60)
  $url.Size = [Drawing.Size]::new(700,32)
  $tokenLabel = [Windows.Forms.Label]::new()
  $tokenLabel.Text = 'API token (leave blank to keep the saved token)'
  $tokenLabel.Location = [Drawing.Point]::new(20,115)
  $tokenLabel.AutoSize = $true
  $token = [Windows.Forms.TextBox]::new()
  $token.UseSystemPasswordChar = $true
  $token.Location = [Drawing.Point]::new(20,150)
  $token.Size = [Drawing.Size]::new(700,32)
  $clear = [Windows.Forms.CheckBox]::new()
  $clear.Text = 'Clear saved token'
  $clear.Location = [Drawing.Point]::new(20,205)
  $clear.AutoSize = $true
  $note = [Windows.Forms.Label]::new()
  $note.Text = "Token is protected by Windows DPAPI for the current user.`r`nIt is never returned to the assistant. Keep SiYuan running."
  $note.Location = [Drawing.Point]::new(20,260)
  $note.Size = [Drawing.Size]::new(700,100)
  $form.Controls.AddRange(@($label,$url,$tokenLabel,$token,$clear,$note))
  if ($form.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) {
    $cipher = ''
    if ($token.Text) { $cipher = Protect-Token $token.Text }
    [Console]::Write((@{accepted=$true;apiUrl=$url.Text;tokenCipher=$cipher;clearToken=$clear.Checked} | ConvertTo-Json -Compress))
  } else { [Console]::Write('{"accepted":false}') }
}
$form.Dispose()
