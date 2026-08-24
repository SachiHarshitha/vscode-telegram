# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

[CmdletBinding()]
param(
	[switch]$SkipTypecheck,
	[switch]$SkipCoreBuild,
	[switch]$SkipCoreTest
)

$ErrorActionPreference = 'Stop'
$extensionRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $extensionRoot '..\..'))

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

	& npx vitest run `
		src/extension/chatSessions/copilotcli/vscode-node/test/chatSessionInitializer.spec.ts `
		src/extension/chatSessions/copilotcli/node/test/copilotCliSessionService.spec.ts `
		src/extension/chatSessions/copilotcli/node/test/copilotcliSession.spec.ts `
		-t 'model|Model|Telegram mode'
	Assert-LastExitCode 'Copilot CLI model and safe-mode suite'
} finally {
	Pop-Location
}

if (-not $SkipCoreTest) {
	Push-Location $repositoryRoot
	try {
		if (-not $SkipCoreBuild) {
			& npm run gulp compile
			Assert-LastExitCode 'Core workbench build'
		}
		& .\scripts\test.bat --run src/vs/workbench/contrib/chat/test/browser/chatSessions/chatSessionsService.test.ts
		Assert-LastExitCode 'Core workbench chat-session command test'
	} finally {
		Pop-Location
	}
}
