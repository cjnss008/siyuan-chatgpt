import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../server/windows.ps1',import.meta.url));
test('Windows helper source is ASCII so BOM normalization cannot corrupt its UI labels',async()=>{
  const bytes=await fs.readFile(script);assert.ok(bytes.every(b=>b<128),'Non-ASCII PowerShell source depends on host ANSI code page or BOM preservation');
});

test('Windows PowerShell 5.1 file parser produces the exact Chinese title and buttons without opening a GUI',{skip:process.platform!=='win32'},async()=>{
  // Parse exactly as -File does, then evaluate only the three label expressions.
  // No helper entrypoint, configuration, secrets or real window is executed.
  const command=`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$testTokens = $null
$testErrors = $null
$testAst = [Management.Automation.Language.Parser]::ParseFile($env:SIYUAN_ENCODING_TEST_SCRIPT,[ref]$testTokens,[ref]$testErrors)
if ($testErrors.Count) {throw 'PowerShell syntax errors'}
$testAssignments = $testAst.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -in @('$form.Text','$cancel.Text','$save.Text')},$true)
$testLabels = @{}
foreach ($assignment in $testAssignments) {
  if ($assignment.Right.Extent.Text -match '^[-]join') {
    $testLabels[$assignment.Left.Extent.Text] = & ([ScriptBlock]::Create($assignment.Right.Extent.Text))
  }
}
@{labels=$testLabels;version=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress
`;
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{env:{...process.env,SIYUAN_ENCODING_TEST_SCRIPT:script},windowsHide:true,timeout:20000,encoding:'utf8'});
  const result=JSON.parse(stdout);assert.match(result.version,/^5\.1\./);
  assert.deepEqual(result.labels,{'$form.Text':'思源笔记 · 写入确认','$cancel.Text':'取消','$save.Text':'确认写入'});
});
