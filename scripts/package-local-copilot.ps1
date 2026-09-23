# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

<#
.SYNOPSIS
	Packages the bundled Copilot extension as a VSIX that enables Custom Endpoint BYOK
	(e.g. vLLM) for managed Copilot seats.

.DESCRIPTION
	The VSIX replaces the Copilot extension built into VS Code. VS Code only loads a
	user-installed copy when its version is strictly greater than the built-in one, so the
	version is stamped as <major>.<minor>.<yyyyMMdd><NN>: above the built-in <major>.<minor>.0,
	and below the next VS Code release's <major>.<minor+1>.0. When VS Code updates, the
	built-in copy wins again and this build retires itself; rebuild on the new release branch.

	Build from the release branch that matches the installed stable VS Code (for example
	upstream/release/1.139), not from main: main targets the next VS Code version.

.PARAMETER AllowedHosts
	Host patterns Custom Endpoint requests may target: '*', 'host.name' or '*.domain'.

.PARAMETER BuildNumber
	Two-digit counter (0-99) that makes multiple builds on the same day unique.

.PARAMETER OutDir
	Output directory for the VSIX.

.PARAMETER Install
	Run 'npm ci' in extensions/copilot first. Use it after switching release branches so
	node_modules match that branch's package-lock.json.

.EXAMPLE
	./scripts/package-local-copilot.ps1
	./scripts/package-local-copilot.ps1 -AllowedHosts 'vllm.corp.internal','*.gpu.corp.internal' -BuildNumber 2
#>
#Requires -Version 7
[CmdletBinding()]
param(
	[string[]]$AllowedHosts = @('*'),

	[ValidateRange(0, 99)]
	[int]$BuildNumber = 1,

	[string]$OutDir = (Join-Path $PSScriptRoot '..\.build\local-copilot'),

	[switch]$Install
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$extensionDir = Resolve-Path (Join-Path $PSScriptRoot '..\extensions\copilot')
$packageJsonPath = Join-Path $extensionDir 'package.json'
$backupPath = "$packageJsonPath.local-copilot.bak"

if (Test-Path $backupPath) {
	throw "Found $backupPath from an interrupted run. Restore it over package.json (or delete it) and retry."
}

$packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
if ($packageJson.version -notmatch '^(?<major>\d+)\.(?<minor>\d+)\.0$') {
	throw "Expected package.json version <major>.<minor>.0 (the version VS Code bundles), found '$($packageJson.version)'."
}
$version = '{0}.{1}.{2}{3:D2}' -f $Matches.major, $Matches.minor, (Get-Date -Format 'yyyyMMdd'), $BuildNumber
$bundledVersion = $packageJson.version

Write-Host "Built-in Copilot version: $bundledVersion (VS Code $($packageJson.engines.vscode))"
Write-Host "Local build version:      $version"
Write-Host "Allowed Custom Endpoint hosts: $($AllowedHosts -join ', ')"

New-Item -ItemType Directory -Force $OutDir | Out-Null
$vsixPath = Join-Path (Resolve-Path $OutDir) "copilot-chat-$version.vsix"

Copy-Item $packageJsonPath $backupPath
try {
	# Same fields the official pipeline patches (.esbuild.mts applyPackageJsonPatch), plus the local BYOK policy.
	$env:LOCAL_COPILOT_VERSION = $version
	$env:LOCAL_COPILOT_ALLOWED_HOSTS = ($AllowedHosts | ConvertTo-Json -Compress -AsArray)
	node -e @'
const fs = require('fs');
const path = process.argv[1];
const packageJson = JSON.parse(fs.readFileSync(path, 'utf8'));
Object.assign(packageJson, {
	version: process.env.LOCAL_COPILOT_VERSION,
	buildType: 'prod',
	isPreRelease: false,
	localByok: { enabled: true, allowedHosts: JSON.parse(process.env.LOCAL_COPILOT_ALLOWED_HOSTS) },
});
fs.writeFileSync(path, JSON.stringify(packageJson, null, '\t'));
'@ $packageJsonPath
	if ($LASTEXITCODE -ne 0) { throw 'Failed to patch package.json.' }

	Push-Location $extensionDir
	try {
		if ($Install) {
			npm ci
			if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
		}

		npm run build
		if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }

		npx vsce package --out $vsixPath --allow-package-secrets sendgrid
		if ($LASTEXITCODE -ne 0) { throw 'vsce package failed.' }
	} finally {
		Pop-Location
	}
} finally {
	Move-Item -Force $backupPath $packageJsonPath
	Remove-Item Env:LOCAL_COPILOT_VERSION, Env:LOCAL_COPILOT_ALLOWED_HOSTS -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host "Packaged $vsixPath"
Write-Host "Install with: code --install-extension `"$vsixPath`" --force"
Write-Host "Check Help > Toggle Developer Tools or the extension list: GitHub Copilot should show version $version."
