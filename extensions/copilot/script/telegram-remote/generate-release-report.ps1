# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

[CmdletBinding()]
param(
	[string]$OutputDirectory = 'artifacts/telegram-remote',
	[string[]]$ArtifactPath = @(),
	[ValidateSet('passed', 'failed', 'not-run')]
	[string]$TestStatus = 'not-run',
	[switch]$AllowDirty
)

$ErrorActionPreference = 'Stop'
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $extensionRoot '..\..'))
$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $repositoryRoot $OutputDirectory }
$outputRoot = [System.IO.Path]::GetFullPath($outputRoot)

Push-Location $repositoryRoot
try {
	$sourceCommit = (& git rev-parse HEAD).Trim()
	if ($LASTEXITCODE -ne 0) { throw 'Unable to read the source commit.' }
	$dirty = [bool](& git status --porcelain)
	if ($dirty -and -not $AllowDirty) {
		throw 'Release metadata must be generated from a clean worktree. Pass -AllowDirty only for local engineering previews.'
	}
	$upstreamCommit = $null
	& git show-ref --verify --quiet refs/remotes/upstream/main
	if ($LASTEXITCODE -eq 0) {
		$upstreamCommit = (& git merge-base HEAD upstream/main).Trim()
	}
} finally {
	Pop-Location
}

$packageJson = Get-Content -LiteralPath (Join-Path $extensionRoot 'package.json') -Raw | ConvertFrom-Json
$compatibility = Get-Content -LiteralPath (Join-Path $extensionRoot 'docs\telegram-remote\compatibility.json') -Raw | ConvertFrom-Json
$revisionSource = Get-Content -LiteralPath (Join-Path $extensionRoot 'src\extension\telegramRemote\common\telegramRemoteCompatibility.ts') -Raw
$revisionMatch = [regex]::Match($revisionSource, 'TELEGRAM_REMOTE_PATCH_REVISION\s*=\s*(?<revision>\d+)')
if (-not $revisionMatch.Success) { throw 'Unable to read the Telegram Remote patch revision.' }
$patchRevision = [int]$revisionMatch.Groups['revision'].Value

# Windows PowerShell's ConvertFrom-Json rejects package-lock objects containing
# keys that differ only by case. Reduce the lockfile to an array in Node first.
$lockSummaryScript = @'
const fs = require('fs');
const lock = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const packages = lock.packages || {};
const licenses = Object.entries(packages)
  .filter(([path]) => path.startsWith('node_modules/'))
  .map(([path, value]) => ({
    name: path.slice('node_modules/'.length),
    version: value.version,
    license: value.license || 'UNKNOWN',
    resolved: value.resolved,
    integrity: value.integrity,
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || String(left.version).localeCompare(String(right.version)));
process.stdout.write(JSON.stringify({ copilot: packages['node_modules/@github/copilot'] || null, licenses }));
'@
$lockSummaryJson = & node -e $lockSummaryScript (Join-Path $extensionRoot 'package-lock.json')
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the extension dependency lockfile.' }
$lockSummary = $lockSummaryJson | ConvertFrom-Json
$copilotLock = $lockSummary.copilot
if (-not $copilotLock) { throw 'The locked @github/copilot runtime was not found.' }

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$licenseInventory = @($lockSummary.licenses)
$licensePath = Join-Path $outputRoot 'dependency-licenses.json'
$licenseInventory | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $licensePath -Encoding utf8

Copy-Item -LiteralPath (Join-Path $repositoryRoot 'LICENSE.txt') -Destination (Join-Path $outputRoot 'VS-Code-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $extensionRoot 'LICENSE.txt') -Destination (Join-Path $outputRoot 'Copilot-Extension-LICENSE.txt') -Force

$report = [ordered]@{
	schemaVersion = 1
	generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
	distribution = 'bundled-vscode-fork'
	sourceCommit = $sourceCommit
	upstreamCommit = $upstreamCommit
	worktreeDirty = $dirty
	copilotExtensionVersion = $packageJson.version
	vscodeEngine = $packageJson.engines.vscode
	nodeEngine = $packageJson.engines.node
	copilotRuntime = [ordered]@{ declared = $packageJson.dependencies.'@github/copilot'; locked = $copilotLock.version }
	telegramPatchRevision = $patchRevision
	enabledApiProposals = @($packageJson.enabledApiProposals | Sort-Object)
	operatingSystem = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
	architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
	nodeVersion = (& node --version).Trim()
	testStatus = $TestStatus
	telegramBotApiSmoke = 'not-run'
	compatibilitySchemaVersion = $compatibility.schemaVersion
	dependencyCount = $licenseInventory.Count
	dependenciesMissingLicenseMetadata = @($licenseInventory | Where-Object license -eq 'UNKNOWN').Count
	disclaimer = 'Internal bundled-fork framework; not a stable public VS Code extension API or Marketplace-compatible standalone extension.'
}
$reportPath = Join-Path $outputRoot 'compatibility-report.json'
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding utf8

$checksumTargets = @($reportPath, $licensePath, (Join-Path $outputRoot 'VS-Code-LICENSE.txt'), (Join-Path $outputRoot 'Copilot-Extension-LICENSE.txt'))
foreach ($path in $ArtifactPath) {
	$resolved = if ([System.IO.Path]::IsPathRooted($path)) { $path } else { Join-Path $repositoryRoot $path }
	if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Release artifact not found: $path" }
	$checksumTargets += [System.IO.Path]::GetFullPath($resolved)
}
$checksums = foreach ($path in $checksumTargets | Select-Object -Unique) {
	$hash = Get-FileHash -LiteralPath $path -Algorithm SHA256
	[ordered]@{ file = [System.IO.Path]::GetFileName($path); sha256 = $hash.Hash.ToLowerInvariant() }
}
$checksumPath = Join-Path $outputRoot 'SHA256SUMS.json'
$checksums | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $checksumPath -Encoding utf8

$sensitivePattern = '(?i)\b\d{6,12}:[A-Za-z0-9_-]{20,}\b|(?:github|ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~-]+|https?://[^/\s:@]+:[^@\s/]+@'
foreach ($path in @($reportPath, $licensePath, $checksumPath)) {
	if ((Get-Content -LiteralPath $path -Raw) -match $sensitivePattern) {
		throw "Secret-shaped data was found in generated release metadata: $path"
	}
}

Write-Host "Generated Telegram Remote release metadata in $outputRoot"
