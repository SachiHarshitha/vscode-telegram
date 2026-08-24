/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import MarkdownIt = require('markdown-it');
import * as l10n from '@vscode/l10n';
import type { TelegramRichText, TelegramRichTextStyle } from '../common/telegramTypes';

export const telegramMaximumMessageLength = 4_096;
const maximumFinalAnswerChunks = 4;
const maximumLinkLength = 2_048;
const maximumRichSummaryLength = 3_500;

interface ListState {
	readonly ordered: boolean;
	next: number;
}

interface OpenTelegramHtmlTag {
	readonly name: string;
	readonly open: string;
	readonly close: string;
}

/** Converts CommonMark-style assistant output into Telegram's strict, regular-message HTML subset. */
export function renderTelegramMarkdownAnswer(markdown: string): readonly string[] {
	const html = renderTelegramMarkdownHtml(markdown);
	if (!html) {
		return [];
	}
	const chunks = splitSafeTelegramHtml(html);
	if (chunks.length <= maximumFinalAnswerChunks) {
		return chunks;
	}
	return [
		...chunks.slice(0, maximumFinalAnswerChunks - 1),
		`<i>${escapeTelegramHtml(l10n.t('Response truncated'))}</i>`,
	];
}

/** Converts assistant Markdown to block-summary RichText while preserving paragraph/list newlines. */
export function renderTelegramMarkdownRichText(markdown: string): TelegramRichText {
	const redacted = redactTelegramSecrets(markdown);
	const bounded = redacted.length <= maximumRichSummaryLength
		? redacted
		: `${redacted.slice(0, maximumRichSummaryLength - 1)}…`;
	const html = createTelegramMarkdownParser().render(neutralizeUnsupportedLinks(bounded), {}).trim();
	return telegramHtmlToRichText(html);
}

function renderTelegramMarkdownHtml(markdown: string): string {
	return createTelegramMarkdownParser().render(neutralizeUnsupportedLinks(redactTelegramSecrets(markdown)), {}).trim();
}

interface RichTextFrame {
	readonly tag: 'root' | TelegramRichTextStyle['type'];
	readonly parts: TelegramRichText[];
}

function telegramHtmlToRichText(html: string): TelegramRichText {
	const frames: RichTextFrame[] = [{ tag: 'root', parts: [] }];
	const append = (part: TelegramRichText) => {
		if (typeof part === 'string' && !part) {
			return;
		}
		const parts = frames.at(-1)!.parts;
		if (typeof part === 'string' && typeof parts.at(-1) === 'string') {
			parts[parts.length - 1] = `${parts.at(-1)}${part}`;
		} else {
			parts.push(part);
		}
	};

	for (const token of html.match(/<[^>]+>|[^<]+/g) ?? []) {
		const opening = /^<(b|i|code)(?:\s[^>]*)?>$/i.exec(token)?.[1].toLocaleLowerCase();
		if (opening) {
			frames.push({ tag: opening === 'b' ? 'bold' : opening === 'i' ? 'italic' : 'code', parts: [] });
			continue;
		}
		const closing = /^<\/(b|i|code)>$/i.exec(token)?.[1].toLocaleLowerCase();
		if (closing && frames.length > 1) {
			const expected = closing === 'b' ? 'bold' : closing === 'i' ? 'italic' : 'code';
			const frame = frames.at(-1)!;
			if (frame.tag === expected) {
				frames.pop();
				append({ type: frame.tag, text: frame.parts });
			}
			continue;
		}
		if (/^<blockquote>$/i.test(token)) {
			append('> ');
			continue;
		}
		if (/^<\/blockquote>$/i.test(token)) {
			append('\n');
			continue;
		}
		if (token.startsWith('<')) {
			continue;
		}
		append(decodeTelegramHtml(token));
	}
	while (frames.length > 1) {
		const frame = frames.pop()!;
		append({ type: frame.tag as TelegramRichTextStyle['type'], text: frame.parts });
	}
	return frames[0].parts.length === 1 ? frames[0].parts[0] : frames[0].parts;
}

function decodeTelegramHtml(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');
}

function neutralizeUnsupportedLinks(markdown: string): string {
	return markdown
		.replace(/(?<image>!)?\[(?<label>[^\]]*)\]\((?<target>[^\s)]+)(?:\s+["'][^"']*["'])?\)/g, (match, _image, _label, _target, _offset, _source, groups?: { image?: string; label?: string; target?: string }) => {
			const label = groups?.label ?? '';
			if (groups?.image) {
				return label ? l10n.t('Image: {0}', label) : l10n.t('Image omitted');
			}
			return getSafeHttpUrl(groups?.target ?? '') ? match : label;
		})
		.replace(/\b(?:javascript|data|file):[^\s)]*/gi, l10n.t('unsafe link removed'));
}

/** Escapes text for Telegram HTML. No caller-controlled tags pass through this function. */
export function escapeTelegramHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Redacts credential-shaped values before either activity or assistant content reaches Telegram. */
export function redactTelegramSecrets(value: string): string {
	return value
		.replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, 'redacted bot token')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer redacted')
		.replace(/((?:^|[\s,{])["']?[A-Za-z0-9_.-]*(?:api[_-]?key|authorization|token|password|secret|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gim, '$1redacted')
		.replace(/\b(api[_-]?key|authorization|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2redacted');
}

function createTelegramMarkdownParser(): MarkdownIt {
	const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
	parser.core.ruler.after('inline', 'telegram-list-prefixes', state => annotateListPrefixes(state.tokens));

	parser.renderer.rules.text = (tokens, index) => escapeTelegramHtml(tokens[index].content);
	parser.renderer.rules.softbreak = () => '\n';
	parser.renderer.rules.hardbreak = () => '\n';
	parser.renderer.rules.strong_open = () => '<b>';
	parser.renderer.rules.strong_close = () => '</b>';
	parser.renderer.rules.em_open = () => '<i>';
	parser.renderer.rules.em_close = () => '</i>';
	parser.renderer.rules.s_open = () => '<s>';
	parser.renderer.rules.s_close = () => '</s>';
	parser.renderer.rules.code_inline = (tokens, index) => `<code>${escapeTelegramHtml(tokens[index].content)}</code>`;
	parser.renderer.rules.fence = (tokens, index) => renderCodeBlock(tokens[index]);
	parser.renderer.rules.code_block = (tokens, index) => renderCodeBlock(tokens[index]);
	parser.renderer.rules.heading_open = () => '<b>';
	parser.renderer.rules.heading_close = () => '</b>\n\n';
	parser.renderer.rules.paragraph_open = () => '';
	parser.renderer.rules.paragraph_close = (tokens, index) => tokens[index].hidden ? '' : '\n\n';
	parser.renderer.rules.blockquote_open = () => '<blockquote>';
	parser.renderer.rules.blockquote_close = () => '</blockquote>\n';
	parser.renderer.rules.bullet_list_open = () => '';
	parser.renderer.rules.bullet_list_close = () => '\n';
	parser.renderer.rules.ordered_list_open = () => '';
	parser.renderer.rules.ordered_list_close = () => '\n';
	parser.renderer.rules.list_item_open = (tokens, index) => escapeTelegramHtml(tokens[index].attrGet('telegram-prefix') ?? '• ');
	parser.renderer.rules.list_item_close = () => '\n';
	parser.renderer.rules.link_open = (tokens, index) => {
		const href = tokens[index].attrGet('href');
		const safeHref = getSafeHttpUrl(href);
		tokens[index].attrSet('telegram-safe-link', safeHref ? 'true' : 'false');
		return safeHref ? `<a href="${escapeTelegramHtml(safeHref)}">` : '';
	};
	parser.renderer.rules.link_close = (tokens, index) => matchingLinkIsSafe(tokens, index) ? '</a>' : '';
	parser.renderer.rules.image = (tokens, index) => {
		const alt = tokens[index].content.trim();
		return escapeTelegramHtml(alt ? l10n.t('Image: {0}', alt) : l10n.t('Image omitted'));
	};
	parser.renderer.rules.html_inline = (tokens, index) => escapeTelegramHtml(tokens[index].content);
	parser.renderer.rules.html_block = (tokens, index) => `${escapeTelegramHtml(tokens[index].content)}\n`;
	parser.renderer.rules.hr = () => '────────\n';
	parser.renderer.rules.table_open = () => '';
	parser.renderer.rules.table_close = () => '\n';
	parser.renderer.rules.thead_open = () => '';
	parser.renderer.rules.thead_close = () => '';
	parser.renderer.rules.tbody_open = () => '';
	parser.renderer.rules.tbody_close = () => '';
	parser.renderer.rules.tr_open = () => '';
	parser.renderer.rules.tr_close = () => '\n';
	parser.renderer.rules.th_open = () => '';
	parser.renderer.rules.th_close = () => ' | ';
	parser.renderer.rules.td_open = () => '';
	parser.renderer.rules.td_close = () => ' | ';
	return parser;
}

function annotateListPrefixes(tokens: MarkdownIt.Token[]): void {
	const lists: ListState[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'bullet_list_open':
				lists.push({ ordered: false, next: 1 });
				break;
			case 'ordered_list_open': {
				const start = Number(token.attrGet('start') ?? '1');
				lists.push({ ordered: true, next: Number.isSafeInteger(start) && start > 0 ? start : 1 });
				break;
			}
			case 'bullet_list_close':
			case 'ordered_list_close':
				lists.pop();
				break;
			case 'list_item_open': {
				const list = lists.at(-1);
				const indentation = '  '.repeat(Math.max(0, lists.length - 1));
				const marker = list?.ordered ? `${list.next++}. ` : '• ';
				token.attrSet('telegram-prefix', `${indentation}${marker}`);
				break;
			}
		}
	}
}

function renderCodeBlock(token: MarkdownIt.Token): string {
	const language = /^[A-Za-z0-9_+-]{1,32}$/.test(token.info.trim()) ? token.info.trim() : undefined;
	const codeTag = language ? `<code class="language-${language}">` : '<code>';
	return `<pre>${codeTag}${escapeTelegramHtml(token.content.replace(/\n$/, ''))}</code></pre>\n`;
}

function getSafeHttpUrl(value: string | null): string | undefined {
	if (!value || value.length > maximumLinkLength) {
		return undefined;
	}
	try {
		const parsed = new URL(value);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
	} catch {
		return undefined;
	}
}

function matchingLinkIsSafe(tokens: readonly MarkdownIt.Token[], closeIndex: number): boolean {
	let depth = 0;
	for (let index = closeIndex - 1; index >= 0; index--) {
		if (tokens[index].type === 'link_close') {
			depth++;
		} else if (tokens[index].type === 'link_open') {
			if (depth === 0) {
				return tokens[index].attrGet('telegram-safe-link') === 'true';
			}
			depth--;
		}
	}
	return false;
}

function splitSafeTelegramHtml(html: string): readonly string[] {
	const tokens = html.match(/<[^>]+>|&(?:lt|gt|amp|quot|#\d+|#x[0-9a-f]+);|[\s\S]/giu) ?? [];
	const chunks: string[] = [];
	const openTags: OpenTelegramHtmlTag[] = [];
	let current = '';

	const closingTags = () => [...openTags].reverse().map(tag => tag.close).join('');
	const flush = () => {
		const closed = `${current}${closingTags()}`.trim();
		if (closed) {
			chunks.push(closed);
		}
		current = openTags.map(tag => tag.open).join('');
	};

	for (const token of tokens) {
		const closing = parseClosingTag(token);
		if (closing) {
			const tagIndex = openTags.map(tag => tag.name).lastIndexOf(closing);
			const remainingClosings = tagIndex >= 0
				? openTags.filter((_tag, index) => index !== tagIndex).reverse().map(tag => tag.close).join('')
				: closingTags();
			if (current.length + token.length + remainingClosings.length > telegramMaximumMessageLength) {
				flush();
			}
			if (tagIndex >= 0) {
				openTags.splice(tagIndex, 1);
			}
			current += token;
			continue;
		}

		const opening = parseOpeningTag(token);
		const futureClosingLength = closingTags().length + (opening?.close.length ?? 0);
		if (current.length + token.length + futureClosingLength > telegramMaximumMessageLength) {
			flush();
		}
		current += token;
		if (opening) {
			openTags.push(opening);
		}
	}
	flush();
	return chunks;
}

function parseOpeningTag(token: string): OpenTelegramHtmlTag | undefined {
	const match = /^<(b|i|u|s|code|pre|blockquote|a)(?:\s[^>]*)?>$/i.exec(token);
	if (!match) {
		return undefined;
	}
	const name = match[1].toLowerCase();
	return { name, open: token, close: `</${name}>` };
}

function parseClosingTag(token: string): string | undefined {
	return /^<\/(b|i|u|s|code|pre|blockquote|a)>$/i.exec(token)?.[1].toLowerCase();
}
