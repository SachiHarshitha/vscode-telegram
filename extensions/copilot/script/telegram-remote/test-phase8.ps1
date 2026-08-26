# Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

[CmdletBinding()]
param(
	[switch]$SkipTypecheck,
	[switch]$SkipLint,
	[switch]$SkipPackage,
	[switch]$SkipCoreTests
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

function Assert-NoMatches {
	param([string]$Operation, [string[]]$Arguments)
	$output = & rg @Arguments
	if ($LASTEXITCODE -eq 0) {
		throw "$Operation failed:`n$($output -join [Environment]::NewLine)"
	}
	if ($LASTEXITCODE -ne 1) {
		throw "$Operation could not be evaluated (rg exit $LASTEXITCODE)."
	}
}

Push-Location $repositoryRoot
try {
	Assert-NoMatches 'Generic framework imports a Telegram adapter' @(
		'-n', 'telegramRemote',
		'extensions/copilot/src/extension/remoteControl',
		'extensions/copilot/src/extension/chatSessions/copilotcli',
		'extensions/copilot/src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts'
	)
	Assert-NoMatches 'Remote-control framework contains Telegram Bot API types' @(
		'-n', 'Telegram(Update|Message|Bot|Callback|Pairing|Consent)',
		'extensions/copilot/src/extension/remoteControl'
	)
} finally {
	Pop-Location
}

Push-Location $extensionRoot
try {
	if (-not $SkipTypecheck) {
		& npm run typecheck
		Assert-LastExitCode 'Copilot extension typecheck'
	}

	& npx vitest run src/extension/remoteControl src/extension/telegramRemote
	Assert-LastExitCode 'Remote-control framework and Telegram aggregate suites'

	& npx vitest run `
		src/extension/chatSessions/copilotcli/node/test/copilotcliSession.spec.ts `
		src/extension/chatSessions/copilotcli/vscode-node/test/chatSessionInitializer.spec.ts `
		src/extension/chatSessions/vscode-node/test/copilotCLIChatSessions.spec.ts `
		-t 'remote|Remote|Mission Control|additional model'
	Assert-LastExitCode 'Focused native remote-control regressions'

	if (-not $SkipLint) {
		& npx eslint `
			src/extension/remoteControl `
			src/extension/telegramRemote `
			src/extension/chatSessions/copilotcli/common/pendingRequestContext.ts `
			src/extension/chatSessions/copilotcli/node/copilotcliSession.ts `
			 src/extension/chatSessions/copilotcli/vscode-node/copilotCLIChatSessionInitializer.ts `
			 src/extension/chatSessions/vscode-node/chatSessions.ts `
			 src/extension/chatSessions/vscode-node/copilotCLIChatSessions.ts `
			 --max-warnings=0
		Assert-LastExitCode 'Phase 8 ESLint'
	}

	if (-not $SkipPackage) {
		& npm run compile
		Assert-LastExitCode 'Copilot extension packaging smoke build'
	}
} finally {
	Pop-Location
}

if (-not $SkipCoreTests) {
	Push-Location $repositoryRoot
	try {
		& .\scripts\test.bat --run src/vs/workbench/contrib/chat/test/browser/chatSessions/chatSessionsService.test.ts
		Assert-LastExitCode 'Core native-dispatch regression'
	} finally {
		Pop-Location
	}
}
