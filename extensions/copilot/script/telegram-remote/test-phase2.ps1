# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

[CmdletBinding()]
param(
	[switch]$RealBot,
	[switch]$SkipUnit,
	[string]$EnvFile
)

$ErrorActionPreference = 'Stop'
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$resolvedEnvFile = if ($EnvFile) {
	if ([System.IO.Path]::IsPathRooted($EnvFile)) {
		[System.IO.Path]::GetFullPath($EnvFile)
	} else {
		[System.IO.Path]::GetFullPath((Join-Path $extensionRoot $EnvFile))
	}
} else {
	Join-Path $extensionRoot '.env'
}

function Invoke-Vitest {
	param([string[]]$TestFiles)

	& npx vitest --run --pool=forks @TestFiles
	if ($LASTEXITCODE -ne 0) {
		throw "Vitest failed with exit code $LASTEXITCODE."
	}
}

function Import-DotEnv {
	param([string]$Path)

	$allowedVariables = @(
		'TELEGRAM_BOT_TOKEN',
		'TELEGRAM_TEST_CHAT_ID',
		'TELEGRAM_REAL_TEST_SEND_MESSAGE'
	)
	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
		throw "Environment file not found: $Path. Copy .env.sample to .env and fill in TELEGRAM_BOT_TOKEN."
	}
	$loaded = 0
	foreach ($rawLine in Get-Content -LiteralPath $Path) {
		$line = $rawLine.Trim()
		if (-not $line -or $line.StartsWith('#')) {
			continue
		}
		$separator = $line.IndexOf('=')
		if ($separator -le 0) {
			throw "Invalid .env entry. Expected NAME=value."
		}
		$name = $line.Substring(0, $separator).Trim()
		if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
			throw "Invalid .env variable name: $name"
		}
		if ($name -notin $allowedVariables) {
			throw "Unsupported .env variable: $name. Only Telegram Phase 2 test variables are accepted."
		}
		$value = $line.Substring($separator + 1).Trim()
		if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
			$value = $value.Substring(1, $value.Length - 2)
		}
		[Environment]::SetEnvironmentVariable($name, $value, 'Process')
		$loaded++
	}
	Write-Host "Loaded $loaded environment variables from the local .env file (values hidden)."
}

Push-Location $extensionRoot
try {
	if (-not $SkipUnit) {
		Invoke-Vitest @(
			'src/extension/telegramRemote/node/test/telegramBotClient.spec.ts',
			'src/extension/telegramRemote/node/test/telegramPollerLease.spec.ts',
			'src/extension/telegramRemote/node/test/telegramService.spec.ts',
			'src/extension/telegramRemote/vscode-node/test/telegramRemoteContribution.spec.ts'
		)
	}

	if ($RealBot) {
		Import-DotEnv $resolvedEnvFile
		if (-not $env:TELEGRAM_BOT_TOKEN) {
			throw 'TELEGRAM_BOT_TOKEN is empty. The real-bot test was not started.'
		}
		Write-Host 'Running the opt-in real Telegram Bot API smoke test. Token values will not be printed.'
		Invoke-Vitest @('src/extension/telegramRemote/node/test/telegramBotClient.real.spec.ts')
	}
} finally {
	Pop-Location
}
