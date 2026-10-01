<#
  Install dsh-plugin-github into a DSH profile.

  DSH's CLI refuses the desktop profile ("profile desktop is managed
  exclusively by the Electron application"), so `dsh plugin --profile desktop
  add ...` cannot be used. This script does by hand what that command does for
  any other profile:

    1. copy the package into <profile>\node_modules\dsh-plugin-github
    2. add "dsh-plugin-github" to dsh.profile.bundles in <profile>\package.json

  Both steps are idempotent and the manifest is backed up first. A bundle that
  cannot be resolved is only a boot warning ("skipping profile bundle"), never a
  fatal failure, so re-running this after any package-manager change is safe.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileDir <path>
#>
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop')
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkgName = 'dsh-plugin-github'
$utf8 = New-Object System.Text.UTF8Encoding($false)

$manifestPath = Join-Path $ProfileDir 'package.json'
if (-not (Test-Path $manifestPath)) {
  throw "not a DSH profile (no package.json): $ProfileDir"
}

# 1. the package itself
$dest = Join-Path $ProfileDir "node_modules\$pkgName"
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($item in @('package.json', 'cordis.patch.yml', 'lib')) {
  $from = Join-Path $here $item
  if (-not (Test-Path $from)) { continue }
  $to = Join-Path $dest $item
  if (Test-Path $to) { Remove-Item $to -Recurse -Force }
  Copy-Item $from $to -Recurse -Force
}

# 2. the bundle row
$text = [System.IO.File]::ReadAllText($manifestPath)
if ($text -notmatch ('"' + [regex]::Escape($pkgName) + '"')) {
  # Anchor on the tail of the bundles array. The same package name appears in
  # "dependencies" but there it is followed by a colon, so this stays unique.
  $anchor = "`"dsh-delete-session`"`r`n      ]"
  $replacement = "`"dsh-delete-session`",`r`n        `"$pkgName`"`r`n      ]"
  if ($text -notmatch [regex]::Escape($anchor)) {
    $anchor = $anchor.Replace("`r`n", "`n")
    $replacement = $replacement.Replace("`r`n", "`n")
  }
  if ($text -notmatch [regex]::Escape($anchor)) {
    throw "could not find the bundles array tail in $manifestPath. Add `"$pkgName`" to dsh.profile.bundles by hand."
  }
  Copy-Item $manifestPath "$manifestPath.bak-github-plugin-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  [System.IO.File]::WriteAllText($manifestPath, $text.Replace($anchor, $replacement), $utf8)
  Write-Output "bundle row added to $manifestPath"
} else {
  Write-Output "bundle row already present in $manifestPath"
}

Write-Output "installed $pkgName"
Write-Output "  package : $dest"
Write-Output "  manifest: $manifestPath"
Write-Output "Restart DSH to load it."
