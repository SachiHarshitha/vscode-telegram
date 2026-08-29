# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

#requires -Version 7.0

[CmdletBinding()]
param(
	[string]$WorkspacePath,
	[string]$ProfilePath,
	[switch]$SkipBuild,
	[switch]$Build,
	[switch]$BuildClient,
	[switch]$BuildExtensions,
	[switch]$NoLaunch,
	[switch]$RequireNativeRuntime,
	[switch]$SkipDependencySync
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$copilotExtensionRoot = Join-Path $repositoryRoot 'extensions\copilot'
$nativeRuntimeModules = @(
	@{ Package = '@vscode/deviceid'; RelativePath = 'node_modules\@vscode\deviceid\build\Release\windows.node' },
	@{ Package = '@vscode/native-watchdog'; RelativePath = 'node_modules\@vscode\native-watchdog\build\Release\watchdog.node' },
	@{ Package = '@vscode/policy-watcher'; RelativePath = 'node_modules\@vscode\policy-watcher\build\Release\vscode-policy-watcher.node' },
	@{ Package = '@vscode/spdlog'; RelativePath = 'node_modules\@vscode\spdlog\build\Release\spdlog.node' },
	@{ Package = '@vscode/sqlite3'; RelativePath = 'node_modules\@vscode\sqlite3\build\Release\vscode-sqlite3.node' },
	@{ Package = '@vscode/windows-ca-certs'; RelativePath = 'node_modules\@vscode\windows-ca-certs\build\Release\crypt32.node' },
	@{ Package = '@vscode/windows-mutex'; RelativePath = 'node_modules\@vscode\windows-mutex\build\Release\CreateMutex.node' },
	@{ Package = '@vscode/windows-process-tree'; RelativePath = 'node_modules\@vscode\windows-process-tree\build\Release\windows_process_tree.node' },
	@{ Package = '@vscode/windows-registry'; RelativePath = 'node_modules\@vscode\windows-registry\build\Release\winregistry.node' },
	@{ Package = 'kerberos'; RelativePath = 'node_modules\kerberos\build\Release\kerberos.node' },
	@{ Package = 'native-is-elevated'; RelativePath = 'node_modules\native-is-elevated\build\Release\iselevated.node' },
	@{ Package = 'native-keymap'; RelativePath = 'node_modules\native-keymap\build\Release\keymapping.node' },
	@{ Package = 'windows-foreground-love'; RelativePath = 'node_modules\windows-foreground-love\build\Release\foreground_love.node' }
)

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

function Get-LockedDependencyMismatches {
	param(
		[Parameter(Mandatory = $true)]
		[string]$PackageRoot
	)

	$lockfilePath = Join-Path $PackageRoot 'package-lock.json'
	if (-not (Test-Path -LiteralPath $lockfilePath -PathType Leaf)) {
		throw "Package lockfile does not exist: $lockfilePath"
	}

	$lockfile = Get-Content -LiteralPath $lockfilePath -Raw | ConvertFrom-Json -AsHashtable
	$packages = $lockfile['packages']
	$rootPackage = $packages['']
	if (-not $packages -or -not $rootPackage) {
		throw "Package lockfile has no root package metadata: $lockfilePath"
	}

	$dependencyNames = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
	foreach ($groupName in @('dependencies', 'devDependencies')) {
		$group = $rootPackage[$groupName]
		if (-not $group) {
			continue
		}
		foreach ($dependencyName in $group.Keys) {
			$dependencyNames.Add([string]$dependencyName) | Out-Null
		}
	}

	$mismatches = [System.Collections.Generic.List[string]]::new()
	foreach ($dependencyName in $dependencyNames) {
		$lockEntry = $packages["node_modules/$dependencyName"]
		$lockedVersion = if ($lockEntry) { [string]$lockEntry['version'] } else { $null }
		if ([string]::IsNullOrWhiteSpace($lockedVersion)) {
			$mismatches.Add("$dependencyName is missing a locked version")
			continue
		}

		$installedPackagePath = Join-Path (Join-Path $PackageRoot 'node_modules') (Join-Path $dependencyName 'package.json')
		if (-not (Test-Path -LiteralPath $installedPackagePath -PathType Leaf)) {
			$mismatches.Add("$dependencyName is missing (locked $lockedVersion)")
			continue
		}

		try {
			$installedVersion = [string]((Get-Content -LiteralPath $installedPackagePath -Raw | ConvertFrom-Json).version)
		} catch {
			$mismatches.Add("$dependencyName has unreadable package metadata (locked $lockedVersion)")
			continue
		}
		if ($installedVersion -ne $lockedVersion) {
			$mismatches.Add("$dependencyName is $installedVersion (locked $lockedVersion)")
		}
	}

	return @($mismatches)
}

function Ensure-LockedDependencies {
	$targets = @(
		@{ Label = 'repository'; Root = $repositoryRoot },
		@{ Label = 'Copilot extension'; Root = $copilotExtensionRoot }
	)

	foreach ($target in $targets) {
		$mismatches = @(Get-LockedDependencyMismatches -PackageRoot $target.Root)
		if ($mismatches.Count -eq 0) {
			continue
		}

		Write-Host "Synchronizing $($target.Label) dependencies with package-lock.json..."
		$mismatches | Select-Object -First 8 | ForEach-Object { Write-Host "  - $_" }
		if ($mismatches.Count -gt 8) {
			Write-Host "  - and $($mismatches.Count - 8) more"
		}

		$arguments = if ($target.Root -eq $repositoryRoot) {
			@('install', '--no-audit', '--no-fund')
		} else {
			@('--prefix', $target.Root, 'install', '--no-audit', '--no-fund')
		}
		Invoke-CheckedCommand -Command 'npm.cmd' -Arguments $arguments -Operation "$($target.Label) dependency synchronization"

		$remaining = @(Get-LockedDependencyMismatches -PackageRoot $target.Root)
		if ($remaining.Count -gt 0) {
			throw "$($target.Label) dependencies still differ from package-lock.json: $($remaining -join '; ')"
		}
	}
}

function Resolve-ExistingDirectory {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Path,
		[Parameter(Mandatory = $true)]
		[string]$Description
	)

	if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
		throw "$Description does not exist: $Path"
	}
	return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path).Path)
}

function Get-MissingNativeRuntimeFiles {
	return @(
		Get-MissingNativeRuntimeModules | ForEach-Object {
			Join-Path $repositoryRoot $_.RelativePath
		}
	)
}

function Get-MissingNativeRuntimeModules {
	return @(
		$nativeRuntimeModules | Where-Object {
			-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $_.RelativePath) -PathType Leaf)
		}
	)
}

function Get-VisualStudioNativeToolchain {
	$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
	if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
		return $null
	}

	$installationJson = & $vswhere `
		-products '*' `
		-requires 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' `
		-latest `
		-format json
	$installation = @($installationJson | ConvertFrom-Json) | Select-Object -First 1
	if (-not $installation) {
		return $null
	}

	$requiredComponents = @(
		@{
			Id = 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
			Label = 'C++ Spectre-mitigated libraries for x64/x86 (Latest MSVC)'
		},
		@{
			Id = 'Microsoft.VisualStudio.Component.VC.ATL.Spectre'
			Label = 'C++ ATL with Spectre mitigations for x64/x86 (Latest MSVC)'
		},
		@{
			Id = 'Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre'
			Label = 'C++ MFC with Spectre mitigations for x64/x86 (Latest MSVC)'
		}
	)
	$missingComponents = @(
		foreach ($component in $requiredComponents) {
			$matchingInstallations = @(& $vswhere `
				-products '*' `
				-requires $component.Id `
				-property installationPath)
			if ($matchingInstallations -notcontains $installation.installationPath) {
				$component
			}
		}
	)

	return [PSCustomObject]@{
		DisplayName = [string]$installation.displayName
		InstallationPath = [string]$installation.installationPath
		MissingSpectreComponents = $missingComponents
	}
}

function Assert-BuildPrerequisites {
	param(
		[bool]$BuildRequested,
		[bool]$NativeRuntimeRequired
	)

	$problems = @()
	if ($BuildRequested -or $NativeRuntimeRequired) {
		$expectedNodeVersion = (Get-Content -LiteralPath (Join-Path $repositoryRoot '.nvmrc') -Raw).Trim().TrimStart('v')
		$actualNodeVersion = (& node --version).Trim().TrimStart('v')
		if ($actualNodeVersion -ne $expectedNodeVersion) {
			$problems += "This checkout requires Node $expectedNodeVersion from .nvmrc, but the active version is $actualNodeVersion. Switch versions with your Node version manager and open a new PowerShell session."
		}
	}

	if ($NativeRuntimeRequired -and (Get-MissingNativeRuntimeFiles).Count -gt 0) {
		$toolchain = Get-VisualStudioNativeToolchain
		if (-not $toolchain) {
			$problems += 'Code OSS native runtime modules are missing, but no Visual Studio installation with the x64/x86 C++ toolset was found.'
		} elseif ($toolchain.MissingSpectreComponents.Count -gt 0) {
			$missingComponentList = ($toolchain.MissingSpectreComponents | ForEach-Object { "  - $($_.Label)" }) -join "`n"
			$problems += @"
Code OSS native runtime modules are missing. node-gyp will use:
  $($toolchain.DisplayName)
  $($toolchain.InstallationPath)

Open Visual Studio Installer, modify that exact installation, and add:
$missingComponentList
"@
		}
	}

	if ($problems.Count -gt 0) {
		throw @"
$($problems -join "`n`n")

Restart PowerShell after correcting the prerequisites and run this launcher again. It will rebuild missing modules automatically.
VS Code source prerequisites: https://github.com/microsoft/vscode/wiki/How-to-Contribute#prerequisites
"@
	}
}

function Initialize-DevelopmentProfileState {
	$storageDirectory = Join-Path $userDataPath 'User\globalStorage'
	$storageFile = Join-Path $storageDirectory 'storage.json'
	New-Item -ItemType Directory -Force -Path $storageDirectory | Out-Null

	$state = [System.Collections.Generic.Dictionary[string, object]]::new()
	if (Test-Path -LiteralPath $storageFile -PathType Leaf) {
		try {
			$parsedState = Get-Content -LiteralPath $storageFile -Raw | ConvertFrom-Json
			foreach ($property in $parsedState.PSObject.Properties) {
				$state[$property.Name] = $property.Value
			}
		} catch {
			throw "Could not read the existing Code OSS profile state at '$storageFile'. $($_.Exception.Message)"
		}
	}

	$changed = $false
	if (-not $state.ContainsKey('telemetry.machineId')) {
		$seed = [Text.Encoding]::UTF8.GetBytes([Guid]::NewGuid().ToString())
		$state['telemetry.machineId'] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($seed)).ToLowerInvariant()
		$changed = $true
	}
	if (-not $state.ContainsKey('telemetry.sqmId') -or [string]::IsNullOrWhiteSpace([string]$state['telemetry.sqmId'])) {
		$state['telemetry.sqmId'] = "{$([Guid]::NewGuid().ToString().ToUpperInvariant())}"
		$changed = $true
	}
	if (-not $state.ContainsKey('telemetry.devDeviceId')) {
		$state['telemetry.devDeviceId'] = [Guid]::NewGuid().ToString()
		$changed = $true
	}

	if (-not $changed) {
		return
	}

	$temporaryStorageFile = "$storageFile.$PID.tmp"
	try {
		$json = $state | ConvertTo-Json -Depth 100
		[IO.File]::WriteAllText($temporaryStorageFile, $json, [Text.UTF8Encoding]::new($false))
		Move-Item -LiteralPath $temporaryStorageFile -Destination $storageFile -Force
	} finally {
		if (Test-Path -LiteralPath $temporaryStorageFile -PathType Leaf) {
			Remove-Item -LiteralPath $temporaryStorageFile -Force
		}
	}

	Write-Host 'Initialized source-development telemetry identifiers in the persistent profile.'
}

function Ensure-NativeRuntimeModules {
	$missingModules = @(Get-MissingNativeRuntimeModules)
	if ($missingModules.Count -eq 0) {
		return
	}

	Write-Host 'Rebuilding missing Code OSS native runtime modules...'
	$missingModules | ForEach-Object { Write-Host "  - $($_.Package)" }
	try {
		$arguments = @('rebuild') + @($missingModules | ForEach-Object { $_.Package })
		Invoke-CheckedCommand `
			-Command 'npm.cmd' `
			-Arguments $arguments `
			-Operation 'Native runtime rebuild'
	} catch {
		throw "Native runtime rebuild failed. Verify the VS Code Windows prerequisites, restart PowerShell, and retry. $($_.Exception.Message)"
	}

	$missingFiles = Get-MissingNativeRuntimeFiles
	if ($missingFiles.Count -gt 0) {
		throw "Native runtime rebuild completed without producing: $($missingFiles -join ', ')"
	}
}

$resolvedWorkspacePath = if ($WorkspacePath) {
	Resolve-ExistingDirectory -Path $WorkspacePath -Description 'Workspace'
} else {
	$repositoryRoot
}

$resolvedProfilePath = if ($ProfilePath) {
	[System.IO.Path]::GetFullPath($ProfilePath)
} else {
	$localApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
	if (-not $localApplicationData) {
		throw 'Could not resolve the current Windows user LocalAppData directory. Pass -ProfilePath explicitly.'
	}
	Join-Path $localApplicationData 'vscode-telegram\dev-profile'
}

$userDataPath = Join-Path $resolvedProfilePath 'user-data'
$extensionsPath = Join-Path $resolvedProfilePath 'extensions'
New-Item -ItemType Directory -Force -Path $userDataPath, $extensionsPath | Out-Null

Push-Location $repositoryRoot
try {
	$nativeRuntimeRequired = $RequireNativeRuntime -or -not $NoLaunch
	Assert-BuildPrerequisites -BuildRequested (-not $SkipBuild) -NativeRuntimeRequired $nativeRuntimeRequired
	if (-not $SkipBuild -and -not $SkipDependencySync) {
		Ensure-LockedDependencies
	}

	if ($nativeRuntimeRequired) {
		Ensure-NativeRuntimeModules
	}
	Initialize-DevelopmentProfileState

	if (-not $SkipBuild) {
		if ($Build) {
			Write-Host 'Compiling Code OSS, its extensions, and the Copilot extension...'
			Invoke-CheckedCommand -Command 'npm.cmd' -Arguments @('run', 'compile') -Operation 'Repository compile'
		} else {
			Write-Host 'Compiling the Copilot extension...'
			Invoke-CheckedCommand -Command 'npm.cmd' -Arguments @('run', 'compile-copilot') -Operation 'Copilot extension compile'
			if ($BuildClient) {
				Write-Host 'Compiling the Code OSS client...'
				Invoke-CheckedCommand -Command 'npm.cmd' -Arguments @('run', 'gulp', 'compile-client') -Operation 'Code OSS client compile'
			}
			if ($BuildExtensions) {
				Write-Host 'Compiling the built-in extensions...'
				Invoke-CheckedCommand -Command 'npm.cmd' -Arguments @('run', 'build-fast-extensions') -Operation 'Built-in extensions compile'
			}
		}
	}

	if (-not $SkipBuild -and ($Build -or $BuildClient)) {
		Write-Host 'Preparing the Code OSS development runtime...'
		Invoke-CheckedCommand -Command 'node' -Arguments @('build/lib/preLaunch.ts') -Operation 'Code OSS pre-launch preparation'
	}

	$product = Get-Content -LiteralPath (Join-Path $repositoryRoot 'product.json') -Raw | ConvertFrom-Json
	$codeExecutable = Join-Path $repositoryRoot ".build\electron\$($product.nameShort).exe"
	$copilotBundle = Join-Path $copilotExtensionRoot 'dist\extension.js'
	if (-not (Test-Path -LiteralPath $codeExecutable -PathType Leaf)) {
		throw "Code OSS executable not found: $codeExecutable. Run again with -BuildClient or -Build."
	}
	if (-not (Test-Path -LiteralPath $copilotBundle -PathType Leaf)) {
		throw "Copilot extension bundle not found: $copilotBundle. Run again without -SkipBuild."
	}

	$launchArguments = @(
		"--user-data-dir=$userDataPath",
		"--extensions-dir=$extensionsPath",
		"--extensionDevelopmentPath=$copilotExtensionRoot",
		'--disable-extension=vscode.vscode-api-tests',
		'--disable-updates',
		'--skip-welcome',
		'--skip-release-notes',
		'--new-window',
		'--log=GitHub.copilot-chat:trace',
		$resolvedWorkspacePath
	)

	Write-Host ''
	Write-Host "Persistent profile: $resolvedProfilePath"
	Write-Host "Workspace:          $resolvedWorkspacePath"
	Write-Host "Copilot source:     $copilotExtensionRoot"
	Write-Host ''
	Write-Host 'GitHub sign-in, settings, workspace trust, extension state, and SecretStorage remain in this profile.'
	Write-Host 'Close an existing dev window that uses this profile before relaunching when you need a new build loaded.'

	if ($NoLaunch) {
		Write-Host 'Launch skipped because -NoLaunch was supplied.'
		return
	}

	$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
	$startInfo.FileName = $codeExecutable
	$startInfo.WorkingDirectory = $repositoryRoot
	$startInfo.UseShellExecute = $false
	$startInfo.CreateNoWindow = $false
	$startInfo.Environment['NODE_ENV'] = 'development'
	$startInfo.Environment['VSCODE_DEV'] = '1'
	$startInfo.Environment['VSCODE_CLI'] = '1'
	$startInfo.Environment['VSCODE_DEV_DEBUG'] = '1'
	$startInfo.Environment['ELECTRON_ENABLE_LOGGING'] = '1'
	$startInfo.Environment['ELECTRON_ENABLE_STACK_DUMPING'] = '1'
	foreach ($argument in $launchArguments) {
		$startInfo.ArgumentList.Add($argument)
	}

	$codeProcess = [System.Diagnostics.Process]::Start($startInfo)
	if (-not $codeProcess) {
		throw 'Code OSS did not start.'
	}

	if ($codeProcess.WaitForExit(5000)) {
		if ($codeProcess.ExitCode -ne 0) {
			throw "Code OSS exited during startup with code $($codeProcess.ExitCode). Review the main-process error printed above and the latest log under '$userDataPath\logs'."
		}
		Write-Host 'The launch request was handed to an existing Code OSS instance that uses this profile.'
	} else {
		Write-Host "Started Code OSS development instance (process $($codeProcess.Id))."
	}
} finally {
	Pop-Location
}
