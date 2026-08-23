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
	[switch]$RequireNativeRuntime
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$copilotExtensionRoot = Join-Path $repositoryRoot 'extensions\copilot'
$nativeRuntimeFiles = @(
	Join-Path $repositoryRoot 'node_modules\@vscode\deviceid\build\Release\windows.node'
	Join-Path $repositoryRoot 'node_modules\@vscode\windows-registry\build\Release\winregistry.node'
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
	return @($nativeRuntimeFiles | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
}

function Test-Vs2022SpectreLibraries {
	$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
	if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) {
		return $false
	}

	$installations = @(& $vswhere `
		-products '*' `
		-version '[17.0,18.0)' `
		-requires 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre' `
		-property installationPath)
	return $installations.Count -gt 0
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

	if ($NativeRuntimeRequired -and (Get-MissingNativeRuntimeFiles).Count -gt 0 -and -not (Test-Vs2022SpectreLibraries)) {
		$problems += @"
Code OSS native runtime modules are missing, and the required VS 2022 Spectre libraries are not installed.
Open Visual Studio Installer, modify Visual Studio 2022, and add these Individual components:
  - MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)
  - C++ ATL for latest v143 build tools with Spectre Mitigations
  - C++ MFC for latest v143 build tools with Spectre Mitigations
"@
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
	$missingFiles = Get-MissingNativeRuntimeFiles
	if ($missingFiles.Count -eq 0) {
		return
	}

	Write-Host 'Rebuilding missing Code OSS native runtime modules...'
	try {
		Invoke-CheckedCommand `
			-Command 'npm.cmd' `
			-Arguments @('rebuild', '@vscode/deviceid', '@vscode/windows-registry') `
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
	Assert-BuildPrerequisites -BuildRequested (-not $SkipBuild) -NativeRuntimeRequired $RequireNativeRuntime

	if ($RequireNativeRuntime) {
		Ensure-NativeRuntimeModules
	} else {
		Initialize-DevelopmentProfileState
	}

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
