# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

#requires -Version 5.1

[CmdletBinding()]
param(
	[string]$OutputDirectory = 'artifacts/remote-pilot',
	[string]$Version,
	[string]$PackagingConfigPath,
	[switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $extensionRoot '..\..'))
$configPath = if ($PackagingConfigPath) {
	if ([System.IO.Path]::IsPathRooted($PackagingConfigPath)) { $PackagingConfigPath } else { Join-Path $repositoryRoot $PackagingConfigPath }
} else {
	Join-Path $PSScriptRoot 'release-vsix.json'
}
$configPath = [System.IO.Path]::GetFullPath($configPath)
$outputRoot = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) { $OutputDirectory } else { Join-Path $repositoryRoot $OutputDirectory }
$outputRoot = [System.IO.Path]::GetFullPath($outputRoot)

function Invoke-CheckedCommand {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Command,
		[Parameter(Mandatory = $true)]
		[string[]]$Arguments,
		[Parameter(Mandatory = $true)]
		[string]$Operation
	)

	& $Command @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "$Operation failed with exit code $LASTEXITCODE."
	}
}

function ConvertTo-OrderedValue {
	param(
		[AllowNull()]
		[object]$Value
	)

	if ($null -eq $Value) {
		return $null
	}
	if ($Value -is [System.Management.Automation.PSCustomObject]) {
		$result = [ordered]@{}
		foreach ($property in $Value.PSObject.Properties) {
			$result[$property.Name] = ConvertTo-OrderedValue -Value $property.Value
		}
		return $result
	}
	if ($Value -is [System.Collections.IDictionary]) {
		$result = [ordered]@{}
		foreach ($key in $Value.Keys) {
			$result[[string]$key] = ConvertTo-OrderedValue -Value $Value[$key]
		}
		return $result
	}
	if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
		$items = [System.Collections.Generic.List[object]]::new()
		foreach ($item in $Value) {
			$items.Add((ConvertTo-OrderedValue -Value $item))
		}
		return ,([object[]]$items.ToArray())
	}
	return $Value
}

function Copy-StagedFile {
	param(
		[Parameter(Mandatory = $true)]
		[string]$RelativePath,
		[Parameter(Mandatory = $true)]
		[string]$DestinationRoot
	)

	if ([System.IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -match '(^|[\\/])\.\.([\\/]|$)') {
		throw "VSCE returned an unsafe staging path: $RelativePath"
	}

	$sourcePath = [System.IO.Path]::GetFullPath((Join-Path $extensionRoot $RelativePath))
	$extensionPrefix = $extensionRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
	if (-not $sourcePath.StartsWith($extensionPrefix, [StringComparison]::OrdinalIgnoreCase)) {
		throw "VSCE returned a path outside the extension root: $RelativePath"
	}
	if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
		throw "VSCE selected a file that does not exist: $sourcePath"
	}

	$destinationPath = Join-Path $DestinationRoot $RelativePath
	$destinationDirectory = Split-Path -Parent $destinationPath
	New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
	Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
}

if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
	throw "Packaging config does not exist: $configPath"
}

$sourceManifestPath = Join-Path $extensionRoot 'package.json'
$sourceReadmePath = Join-Path $extensionRoot 'README.md'
$ignorePath = Join-Path $extensionRoot '.vscodeignore'
$distEntryPoint = Join-Path $extensionRoot 'dist\extension.js'
$nodeModulesPath = Join-Path $extensionRoot 'node_modules'
$runningOnWindows = $env:OS -eq 'Windows_NT'
$vscePath = if ($runningOnWindows) { Join-Path $nodeModulesPath '.bin\vsce.cmd' } else { Join-Path $nodeModulesPath '.bin\vsce' }
$npmCommand = if ($runningOnWindows) { 'npm.cmd' } else { 'npm' }

foreach ($requiredPath in @($sourceManifestPath, $sourceReadmePath, $ignorePath, $vscePath)) {
	if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
		throw "Required packaging file does not exist: $requiredPath"
	}
}
if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) {
	throw "Extension dependencies are missing. Run npm install in '$extensionRoot' first."
}

if (-not $SkipBuild) {
	Push-Location $extensionRoot
	try {
		Invoke-CheckedCommand -Command $npmCommand -Arguments @('run', 'build') -Operation 'Copilot extension production build'
	} finally {
		Pop-Location
	}
}
$target = (& node -p "process.platform + '-' + process.arch").Trim()
if ($LASTEXITCODE -ne 0 -or $target -notin @('win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'linux-armhf', 'darwin-x64', 'darwin-arm64', 'alpine-x64', 'alpine-arm64')) {
	throw "Unable to determine a supported VSCE target for this build: '$target'"
}
$requiredBuildFiles = @(
	$distEntryPoint,
	(Join-Path $nodeModulesPath '@github\copilot\sdk\index.js'),
	(Join-Path $nodeModulesPath "@github\copilot\sdk\prebuilds\$target\runtime.node"),
	(Join-Path $nodeModulesPath '@vscode\copilot-typescript-server-plugin\dist\main.js')
)
foreach ($requiredBuildFile in $requiredBuildFiles) {
	if (-not (Test-Path -LiteralPath $requiredBuildFile -PathType Leaf)) {
		throw "Required compiled release file is missing: $requiredBuildFile. Run without -SkipBuild after closing any process that has the Copilot runtime open."
	}
}

$config = ConvertTo-OrderedValue -Value (Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json)
$manifest = ConvertTo-OrderedValue -Value (Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json)
if (-not $config['manifest']) {
	throw "Packaging config has no manifest overrides: $configPath"
}

foreach ($entry in $config['manifest'].GetEnumerator()) {
	$manifest[$entry.Key] = $entry.Value
}
foreach ($propertyName in @($config['removeManifestProperties'])) {
	$manifest.Remove([string]$propertyName)
}
if ($Version) {
	$manifest['version'] = $Version
}

$keywords = [System.Collections.Generic.List[string]]::new()
foreach ($keyword in @($manifest['keywords']) + @($config['appendKeywords'])) {
	if ($keyword -and -not $keywords.Contains([string]$keyword)) {
		$keywords.Add([string]$keyword)
	}
}
$manifest['keywords'] = $keywords.ToArray()

# Production builds bundle the normal dependencies. These are the only packages
# intentionally kept external by the build or contributed directly from disk.
$copilotPackagePath = Join-Path $nodeModulesPath '@github\copilot'
$typescriptPluginPath = Join-Path $nodeModulesPath '@vscode\copilot-typescript-server-plugin'
$detectLibcPath = Join-Path $nodeModulesPath 'detect-libc'
foreach ($runtimeDependencyPath in @($copilotPackagePath, $typescriptPluginPath, $detectLibcPath)) {
	if (-not (Test-Path -LiteralPath $runtimeDependencyPath -PathType Container)) {
		throw "Required packaged dependency does not exist: $runtimeDependencyPath"
	}
}
$copilotPackage = Get-Content -LiteralPath (Join-Path $copilotPackagePath 'package.json') -Raw | ConvertFrom-Json
$typescriptPluginPackage = Get-Content -LiteralPath (Join-Path $typescriptPluginPath 'package.json') -Raw | ConvertFrom-Json
$manifest['dependencies'] = [ordered]@{
	'@github/copilot' = [string]$copilotPackage.version
	'@vscode/copilot-typescript-server-plugin' = [string]$typescriptPluginPackage.version
}

$extensionId = "$($manifest['publisher']).$($manifest['name'])"
if ($config['extensionId'] -and $extensionId -cne [string]$config['extensionId']) {
	throw "Packaging config extensionId '$($config['extensionId'])' does not match manifest identity '$extensionId'."
}

$authenticationConfig = $config['authentication']
$signInCommand = [string]$authenticationConfig['signInCommand']
if (-not $signInCommand -or $signInCommand -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]+$') {
	throw "Packaging config must provide a valid authentication.signInCommand."
}
$signInCommandTitle = [string]$authenticationConfig['signInCommandTitle']
$signInCommandCategory = [string]$authenticationConfig['signInCommandCategory']
if (-not $signInCommandTitle -or -not $signInCommandCategory) {
	throw "Packaging config must provide authentication.signInCommandTitle and authentication.signInCommandCategory."
}

$commandContributions = [System.Collections.Generic.List[object]]::new()
$signInCommandContribution = $null
foreach ($commandContribution in @($manifest['contributes']['commands'])) {
	$commandContributions.Add($commandContribution)
	if ([string]$commandContribution['command'] -ceq $signInCommand) {
		$signInCommandContribution = $commandContribution
	}
}
if ($null -eq $signInCommandContribution) {
	$signInCommandContribution = [ordered]@{ command = $signInCommand }
	$commandContributions.Add($signInCommandContribution)
}
$signInCommandContribution['title'] = $signInCommandTitle
$signInCommandContribution['category'] = $signInCommandCategory
$manifest['contributes']['commands'] = $commandContributions.ToArray()

$commandPaletteEntries = [System.Collections.Generic.List[object]]::new()
$signInCommandPaletteEntry = $null
foreach ($commandPaletteEntry in @($manifest['contributes']['menus']['commandPalette'])) {
	$commandPaletteEntries.Add($commandPaletteEntry)
	if ([string]$commandPaletteEntry['command'] -ceq $signInCommand) {
		$signInCommandPaletteEntry = $commandPaletteEntry
	}
}
if ($null -eq $signInCommandPaletteEntry) {
	$signInCommandPaletteEntry = [ordered]@{ command = $signInCommand }
	$commandPaletteEntries.Add($signInCommandPaletteEntry)
}
if ([bool]$authenticationConfig['exposeSignInCommand']) {
	$signInCommandPaletteEntry.Remove('when')
}
$manifest['contributes']['menus']['commandPalette'] = $commandPaletteEntries.ToArray()

if ([bool]$authenticationConfig['disableWorkbenchCopilotSignInGate']) {
	$chatSessionContributions = @($manifest['contributes']['chatSessions'])
	if ($chatSessionContributions.Count -eq 0) {
		throw "The source manifest contains no chat session contributions whose workbench sign-in gate can be disabled."
	}
	foreach ($chatSessionContribution in $chatSessionContributions) {
		$chatSessionContribution['requiresCopilotSignIn'] = $false
	}
}

$readmeConfig = $config['readme']
$preamblePath = Join-Path (Split-Path -Parent $configPath) ([string]$readmeConfig['preamblePath'])
if (-not (Test-Path -LiteralPath $preamblePath -PathType Leaf)) {
	throw "Remote Pilot README preamble does not exist: $preamblePath"
}

$preamble = Get-Content -LiteralPath $preamblePath -Raw
$preamble = $preamble.Replace('{{REMOTE_CONFIGURATION_README_URL}}', [string]$readmeConfig['remoteConfigurationUrl'])
$preamble = $preamble.Replace('{{EXTENSION_ID}}', $extensionId)
$preamble = $preamble.Replace('{{PUBLISHER_DISPLAY_NAME}}', [string]$config['publisherDisplayName'])
if ($preamble -match '\{\{[A-Z0-9_]+\}\}') {
	throw "Remote Pilot README preamble contains an unresolved placeholder: $($Matches[0])"
}

$upstreamReadmeLines = Get-Content -LiteralPath $sourceReadmePath
if ($readmeConfig['stripUpstreamImages']) {
	$upstreamReadmeLines = @($upstreamReadmeLines | Where-Object {
		$_ -notmatch '!\[[^\]]*\]\([^\)]*\)' -and $_ -notmatch '<\s*(img|picture|source)\b'
	})
}
$upstreamReadme = ($upstreamReadmeLines -join "`n").Trim()
if ($readmeConfig['stripUpstreamImages'] -and ($upstreamReadme -match '!\[[^\]]*\]\([^\)]*\)' -or $upstreamReadme -match '<\s*(img|picture|source)\b')) {
	throw 'The upstream README still contains an image embed.'
}
$generatedReadme = $preamble.TrimEnd() + "`n`n---`n`n" + $upstreamReadme + "`n"

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null
$outputPath = Join-Path $outputRoot "$($manifest['name'])-$target-$($manifest['version']).vsix"
$stagingParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$stagingRoot = Join-Path $stagingParent "remote-pilot-vsix-$([Guid]::NewGuid().ToString('N'))"
$stagedNodeModulesPath = Join-Path $stagingRoot 'node_modules'

try {
	New-Item -ItemType Directory -Path $stagingRoot | Out-Null

	Push-Location $extensionRoot
	try {
		$includedFiles = @(& $vscePath ls --no-yarn --no-dependencies)
		if ($LASTEXITCODE -ne 0) {
			throw "VSCE file discovery failed with exit code $LASTEXITCODE."
		}
	} finally {
		Pop-Location
	}

	foreach ($relativePath in $includedFiles) {
		Copy-StagedFile -RelativePath ([string]$relativePath) -DestinationRoot $stagingRoot
	}
	Copy-Item -LiteralPath $ignorePath -Destination (Join-Path $stagingRoot '.vscodeignore') -Force

	$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
	[System.IO.File]::WriteAllText((Join-Path $stagingRoot 'package.json'), (($manifest | ConvertTo-Json -Depth 100) + "`n"), $utf8NoBom)
	[System.IO.File]::WriteAllText((Join-Path $stagingRoot 'README.md'), $generatedReadme, $utf8NoBom)

	$stagedPackageNlsPath = Join-Path $stagingRoot 'package.nls.json'
	if (-not (Test-Path -LiteralPath $stagedPackageNlsPath -PathType Leaf)) {
		throw "Staged localization manifest does not exist: $stagedPackageNlsPath"
	}
	$defaultSignInCommandUri = 'command:workbench.action.chat.triggerSetupForceSignIn'
	$remoteSignInCommandUri = "command:$signInCommand"
	$packageNls = Get-Content -LiteralPath $stagedPackageNlsPath -Raw
	$defaultSignInLinkCount = [regex]::Matches($packageNls, [regex]::Escape($defaultSignInCommandUri)).Count
	if ($defaultSignInLinkCount -eq 0) {
		throw "The staged localization manifest contains no default Copilot sign-in links to rewrite."
	}
	$packageNls = $packageNls.Replace($defaultSignInCommandUri, $remoteSignInCommandUri)
	[System.IO.File]::WriteAllText($stagedPackageNlsPath, $packageNls, $utf8NoBom)

	New-Item -ItemType Directory -Force -Path (Join-Path $stagedNodeModulesPath '@github'), (Join-Path $stagedNodeModulesPath '@vscode') | Out-Null
	$packagedDependencies = [ordered]@{
		(Join-Path $stagedNodeModulesPath '@github\copilot') = $copilotPackagePath
		(Join-Path $stagedNodeModulesPath '@vscode\copilot-typescript-server-plugin') = $typescriptPluginPath
		(Join-Path $stagedNodeModulesPath 'detect-libc') = $detectLibcPath
	}
	foreach ($destinationPath in $packagedDependencies.Keys) {
		Copy-Item -LiteralPath $packagedDependencies[$destinationPath] -Destination $destinationPath -Recurse -Force
	}

	Push-Location $stagingRoot
	try {
		Invoke-CheckedCommand -Command $vscePath -Arguments @('package', '--no-yarn', '--target', $target, '--ignore-other-target-folders', '--out', $outputPath) -Operation 'Remote Pilot VSIX packaging'
	} finally {
		Pop-Location
	}
} finally {
	$resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot)
	$stagingPrefix = $stagingParent.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
	if ($resolvedStagingRoot.StartsWith($stagingPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedStagingRoot) -like 'remote-pilot-vsix-*') {
		Remove-Item -LiteralPath $resolvedStagingRoot -Recurse -Force -ErrorAction SilentlyContinue
	}
}

if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
	throw "VSCE completed without producing the expected package: $outputPath"
}

Write-Host "Created Remote Pilot VSIX ($extensionId):"
Write-Output $outputPath
