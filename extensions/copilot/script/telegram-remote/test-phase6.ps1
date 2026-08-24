# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

[CmdletBinding()]
param(
	[switch]$SkipTypecheck
)

$ErrorActionPreference = 'Stop'
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

function Assert-LastExitCode {
	param([string]$Operation)

	if ($LASTEXITCODE -ne 0) {
		throw "$Operation failed with exit code $LASTEXITCODE."
	}
}

Push-Location $extensionRoot
try {
	if (-not $SkipTypecheck) {
		& npx tsc --noEmit --project tsconfig.json --pretty false
		Assert-LastExitCode 'TypeScript validation'
	}

	& npx vitest run src/extension/telegramRemote
	Assert-LastExitCode 'Telegram Remote aggregate suite'

	& npx vitest run src/extension/chatSessions/copilotcli/node/test/copilotcliSession.spec.ts -t 'exit_plan_mode.requested'
	Assert-LastExitCode 'Copilot CLI plan-response race suite'
} finally {
	Pop-Location
}
