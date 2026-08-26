/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import * as vscode from 'vscode';
import { IVSCodeExtensionContext } from '../../../platform/extContext/common/extensionContext';
import { Disposable } from '../../../util/vs/base/common/lifecycle';
import { TELEGRAM_REMOTE_BUILD_MARKER, TELEGRAM_REMOTE_PATCH_REVISION } from '../common/telegramRemoteCompatibility';
import type { TelegramPollingStatus } from '../common/telegramTypes';
import type { TelegramRemoteAuthorizationState } from './telegramRemoteContribution';

const maximumDiagnosticValueLength = 256;
const sensitiveDiagnosticKeyPattern = /(^|[_.-])(token|authorization|secret|password|prompt|answer|content|callbackData)([_.-]|$)/i;
const sensitiveValuePattern = /(?:\b\d{6,12}:[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._~-]+|(?:token|authorization|secret|password)\s*[=:]\s*\S+)/gi;

export type TelegramDiagnosticValue = string | number | boolean | undefined;

export interface TelegramRemoteDiagnosticSnapshot {
	readonly configured: boolean;
	readonly enabled: boolean;
	readonly paired: boolean;
	readonly authorizationState: TelegramRemoteAuthorizationState;
	readonly pollingStatus: TelegramPollingStatus;
	readonly consentScopeFingerprint: string;
}

export interface ITelegramRemoteDiagnostics {
	record(event: string, fields?: Readonly<Record<string, TelegramDiagnosticValue>>): void;
	show(): void;
	copyReport(snapshot: TelegramRemoteDiagnosticSnapshot): Promise<void>;
}

/** Owns a content-free, credential-redacted diagnostics channel and runtime report. */
export class TelegramRemoteDiagnostics extends Disposable implements ITelegramRemoteDiagnostics {
	private readonly channel = this._register(vscode.window.createOutputChannel(l10n.t('Telegram Remote')));

	constructor(
		@IVSCodeExtensionContext private readonly extensionContext: IVSCodeExtensionContext,
	) {
		super();
		this.record('diagnostics-ready', { patch: TELEGRAM_REMOTE_PATCH_REVISION });
	}

	record(event: string, fields: Readonly<Record<string, TelegramDiagnosticValue>> = {}): void {
		const safeEvent = sanitizeDiagnosticValue(event);
		const details = Object.entries(fields)
			.filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
			.map(([key, value]) => `${sanitizeDiagnosticKey(key)}=${sensitiveDiagnosticKeyPattern.test(key) ? '[redacted]' : sanitizeDiagnosticValue(String(value))}`)
			.join(' ');
		this.channel.appendLine(`${new Date().toISOString()} event=${safeEvent}${details ? ` ${details}` : ''}`);
	}

	show(): void {
		this.channel.show(true);
	}

	async copyReport(snapshot: TelegramRemoteDiagnosticSnapshot): Promise<void> {
		const packageJson = this.extensionContext.extension.packageJSON as { readonly version?: unknown; readonly enabledApiProposals?: unknown };
		const proposals = Array.isArray(packageJson.enabledApiProposals)
			? packageJson.enabledApiProposals.filter((value): value is string => typeof value === 'string').sort()
			: [];
		const report = {
			schemaVersion: 1,
			generatedAt: new Date().toISOString(),
			buildMarker: TELEGRAM_REMOTE_BUILD_MARKER,
			patchRevision: TELEGRAM_REMOTE_PATCH_REVISION,
			vscodeVersion: vscode.version,
			extensionVersion: typeof packageJson.version === 'string' ? packageJson.version : 'unknown',
			nodeVersion: process.version,
			platform: process.platform,
			architecture: process.arch,
			enabledApiProposals: proposals,
			configured: snapshot.configured,
			enabled: snapshot.enabled,
			paired: snapshot.paired,
			authorizationState: snapshot.authorizationState,
			pollingState: snapshot.pollingStatus.state,
			pollingFailure: snapshot.pollingStatus.state === 'failed' || snapshot.pollingStatus.state === 'retrying' ? snapshot.pollingStatus.reason : undefined,
			consentScopeFingerprint: snapshot.consentScopeFingerprint,
		};
		await vscode.env.clipboard.writeText(JSON.stringify(report, undefined, 2));
		this.record('diagnostics-copied', { authorizationState: snapshot.authorizationState, pollingState: snapshot.pollingStatus.state });
	}
}

function sanitizeDiagnosticKey(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64) || 'field';
}

function sanitizeDiagnosticValue(value: string): string {
	return value.replace(sensitiveValuePattern, '[redacted]').replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximumDiagnosticValueLength) || 'unknown';
}
