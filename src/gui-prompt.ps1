param([string]$Site = 'this site')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'browser-pilot 需要登录'
$form.Size = New-Object System.Drawing.Size(480, 300)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

$head = New-Object System.Windows.Forms.Label
$head.Text = "登录 $Site"
$head.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$head.SetBounds(20, 15, 420, 26)
$form.Controls.Add($head)

$tip = New-Object System.Windows.Forms.Label
$tip.Text = '密码只在内存中使用；勾选「长期保留」后用 Windows 用户级加密保存。'
$tip.ForeColor = [System.Drawing.Color]::DimGray
$tip.SetBounds(20, 45, 430, 20)
$form.Controls.Add($tip)

$lbUser = New-Object System.Windows.Forms.Label
$lbUser.Text = '账号'
$lbUser.SetBounds(20, 80, 70, 22)
$form.Controls.Add($lbUser)

$tbUser = New-Object System.Windows.Forms.TextBox
$tbUser.SetBounds(95, 78, 340, 24)
$form.Controls.Add($tbUser)

$lbPass = New-Object System.Windows.Forms.Label
$lbPass.Text = '密码'
$lbPass.SetBounds(20, 116, 70, 22)
$form.Controls.Add($lbPass)

$tbPass = New-Object System.Windows.Forms.TextBox
$tbPass.SetBounds(95, 114, 340, 24)
$tbPass.UseSystemPasswordChar = $true
$form.Controls.Add($tbPass)

$cb = New-Object System.Windows.Forms.CheckBox
$cb.Text = '长期保留账号和密码（下次不再询问）'
$cb.SetBounds(95, 148, 340, 24)
$form.Controls.Add($cb)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = '登录'
$ok.SetBounds(255, 195, 85, 30)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($ok)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = '取消'
$cancel.SetBounds(350, 195, 85, 30)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancel)

$form.AcceptButton = $ok
$form.CancelButton = $cancel

$res = $form.ShowDialog()
if ($res -ne [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write('{"cancelled":true}')
  exit 3
}
if (-not $tbUser.Text -or -not $tbPass.Text) {
  [Console]::Out.Write('{"cancelled":true,"reason":"empty"}')
  exit 3
}
$obj = [ordered]@{ user = $tbUser.Text; pass = $tbPass.Text; remember = [bool]$cb.Checked }
[Console]::Out.Write(($obj | ConvertTo-Json -Compress))
