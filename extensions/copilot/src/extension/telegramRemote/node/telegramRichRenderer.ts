/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { ActivityRound, ActivityRoundDetail } from '../common/activityRound';
import type { TelegramInputRichBlock, TelegramInputRichMessage, TelegramRichText } from '../common/telegramTypes';
import { redactTelegramSecrets } from './telegramMarkdown';

const maximumRichDetailLength = 3_500;
const maximumRichListItems = 24;
export type TelegramRichActivityDetail = 'compact' | 'detailed' | 'debug';

/** Renders exactly one semantic activity round as one expandable Telegram Rich Message. */
export function renderTelegramActivityRound(round: ActivityRound, disclosure: TelegramRichActivityDetail = 'compact'): TelegramInputRichMessage {
	const visibleDetails = round.details?.filter(detail => disclosure !== 'compact' || detail.visibility !== 'detailed') ?? [];
	const detailBlocks = visibleDetails.flatMap(renderDetail).slice(0, maximumRichListItems);
	if (disclosure === 'debug') {
		detailBlocks.push({ type: 'heading', size: 6, text: l10n.t('Correlation') });
		detailBlocks.push({ type: 'pre', language: 'text', text: bounded([
			`activity=${round.id}`,
			`session=${round.sessionId}`,
			round.requestId ? `request=${round.requestId}` : undefined,
			round.toolCallId ? `tool=${round.toolCallId}` : undefined,
		].filter(Boolean).join('\n')) });
	}
	if (detailBlocks.length === 0) {
		detailBlocks.push({ type: 'paragraph', text: statusDescription(round) });
	}
	if (round.startedAt !== undefined) {
		detailBlocks.push({ type: 'divider' });
		detailBlocks.push({ type: 'paragraph', text: timingText(round) });
	}
	return {
		blocks: [{
			type: 'details',
			summary: summaryText(round),
			blocks: detailBlocks,
		}],
		skip_entity_detection: true,
	};
}

export function renderTelegramAssistantAnswer(content: string): TelegramInputRichMessage {
	return {
		blocks: [{ type: 'paragraph', text: bounded(content) }],
		skip_entity_detection: true,
	};
}

function summaryText(round: ActivityRound): TelegramRichText {
	return [icon(round), ' ', { type: 'bold', text: bounded(round.summary) }, statusSuffix(round)];
}

function renderDetail(detail: ActivityRoundDetail): readonly TelegramInputRichBlock[] {
	const value = bounded(detail.value);
	if (detail.format === 'list') {
		const items = value.split(/\r?\n/).filter(Boolean).slice(0, maximumRichListItems).map(item => ({
			blocks: [{ type: 'paragraph' as const, text: bounded(item) }],
		}));
		return [
			...(detail.label ? [{ type: 'heading' as const, size: 6 as const, text: bounded(detail.label) }] : []),
			{ type: 'list' as const, items },
		];
	}
	if (detail.format === 'code') {
		return [
			...(detail.label ? [{ type: 'heading' as const, size: 6 as const, text: bounded(detail.label) }] : []),
			{ type: 'pre' as const, text: value, language: safeLanguage(detail.language) },
		];
	}
	return [{
		type: 'paragraph',
		text: detail.label ? [{ type: 'bold', text: `${bounded(detail.label)}: ` }, value] : value,
	}];
}

function icon(round: ActivityRound): string {
	if (round.status === 'failed') {
		return '✗';
	}
	if (round.status === 'completed' && round.type === 'other') {
		return '✓';
	}
	switch (round.type) {
		case 'reasoning': return '🧠';
		case 'progress': return round.status === 'running' ? '◌' : '✓';
		case 'search': return '🔎';
		case 'read': return '🔎';
		case 'edit': return '✎';
		case 'command': return '⌘';
		case 'permission': return '⚠';
		case 'question': return '?';
		case 'subagent': return '↳';
		case 'other': return '•';
	}
}

function statusSuffix(round: ActivityRound): string {
	return round.status === 'running' ? l10n.t(' · running…')
		: round.status === 'waiting' ? l10n.t(' · waiting')
			: '';
}

function statusDescription(round: ActivityRound): string {
	return round.status === 'running' ? l10n.t('This activity is still running.')
		: round.status === 'waiting' ? l10n.t('Copilot is waiting for a response.')
			: round.status === 'failed' ? l10n.t('This activity failed.') : l10n.t('This activity completed.');
}

function timingText(round: ActivityRound): string {
	if (round.startedAt === undefined) {
		return '';
	}
	const duration = round.completedAt === undefined ? undefined : Math.max(0, round.completedAt - round.startedAt);
	return duration === undefined ? l10n.t('Started {0}', new Date(round.startedAt).toLocaleTimeString())
		: l10n.t('Duration: {0}', duration < 1_000 ? `${duration}ms` : `${(duration / 1_000).toFixed(duration < 10_000 ? 1 : 0)}s`);
}

function bounded(value: string): string {
	const redacted = redactTelegramSecrets(value);
	return redacted.length <= maximumRichDetailLength ? redacted : `${redacted.slice(0, maximumRichDetailLength - 1)}…`;
}

function safeLanguage(value: string | undefined): string | undefined {
	return value && /^[A-Za-z0-9_+-]{1,32}$/.test(value) ? value : undefined;
}
