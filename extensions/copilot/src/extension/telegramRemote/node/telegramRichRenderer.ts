/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as l10n from '@vscode/l10n';
import type { ActivityRound, ActivityRoundDetail } from '../common/activityRound';
import type { TelegramInputRichBlock, TelegramInputRichMessage, TelegramRichText } from '../common/telegramTypes';
import { redactTelegramSecrets, renderTelegramMarkdownAnswer } from './telegramMarkdown';

const maximumRichDetailLength = 3_500;
const maximumRichListItems = 24;
export type TelegramRichActivityDetail = 'compact' | 'detailed' | 'debug';

/** Renders one semantic activity round without forcing every round into an expander. */
export function renderTelegramActivityRound(round: ActivityRound, disclosure: TelegramRichActivityDetail = 'compact'): TelegramInputRichMessage {
	if (round.type === 'answer') {
		return renderTelegramAssistantAnswer(round.details?.[0]?.value ?? round.summary);
	}
	const visibleDetails = round.details?.filter(detail =>
		(disclosure !== 'compact' || detail.visibility !== 'detailed') && !duplicatesSummary(round, detail)
	) ?? [];
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
		return {
			blocks: [{ type: 'paragraph', text: summaryText(round) }],
			skip_entity_detection: true,
		};
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
	const html = renderTelegramMarkdownAnswer(content).join('\n');
	if (html) {
		return { html, skip_entity_detection: true };
	}
	return {
		blocks: [{ type: 'paragraph', text: l10n.t('Copilot returned an empty response.') }],
		skip_entity_detection: true,
	};
}

function summaryText(round: ActivityRound): TelegramRichText {
	return [icon(round), ' ', { type: 'bold', text: bounded(round.summary) }];
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
		case 'progress': return round.status === 'running' ? '⏳' : '▶';
		case 'answer': return '✓';
		case 'search': return '🔎';
		case 'read': return '🔎';
		case 'edit': return '✏';
		case 'command': return '⌘';
		case 'permission': return '⚠';
		case 'question': return '❓';
		case 'subagent': return '↳';
		case 'other': return '•';
	}
}

function duplicatesSummary(round: ActivityRound, detail: ActivityRoundDetail): boolean {
	return !detail.label && normalize(detail.value) === normalize(round.summary);
}

function normalize(value: string): string {
	return value.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ').trim();
}

function bounded(value: string): string {
	const redacted = redactTelegramSecrets(value);
	return redacted.length <= maximumRichDetailLength ? redacted : `${redacted.slice(0, maximumRichDetailLength - 1)}…`;
}

function safeLanguage(value: string | undefined): string | undefined {
	return value && /^[A-Za-z0-9_+-]{1,32}$/.test(value) ? value : undefined;
}
