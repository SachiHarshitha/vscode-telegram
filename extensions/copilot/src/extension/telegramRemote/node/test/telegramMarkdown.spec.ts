/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Sachith H. Liyanagama, Emagin8 UG. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import { renderTelegramMarkdownAnswer, telegramMaximumMessageLength } from '../telegramMarkdown';

describe('TelegramMarkdown', () => {
	it('converts supported CommonMark to a strict Telegram HTML subset', () => {
		const chunks = renderTelegramMarkdownAnswer([
			'# Heading',
			'',
			'**bold** *italic* ~~strike~~ and `code`.',
			'',
			'- first',
			'- second',
			'',
			'3. third',
			'4. fourth',
			'',
			'> quoted 😀',
			'',
			'```ts',
			'const emoji = "🚀";',
			'```',
		].join('\n'));
		const html = chunks.join('\n');

		expect(html).toContain('<b>Heading</b>');
		expect(html).toContain('<b>bold</b> <i>italic</i> <s>strike</s> and <code>code</code>');
		expect(html).toContain('• first');
		expect(html).toContain('3. third');
		expect(html).toContain('<blockquote>quoted 😀');
		expect(html).toContain('</blockquote>');
		expect(html).toContain('<pre><code class="language-ts">const emoji = &quot;🚀&quot;;</code></pre>');
	});

	it('escapes raw HTML, neutralizes images, rejects unsafe links, and keeps safe links', () => {
		const html = renderTelegramMarkdownAnswer('<script>alert(1)</script> ![secret](file:///private.png) [safe](https://example.com/x) [js](javascript:alert(1)) [data](data:text/plain,secret)').join('');

		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain('Image: secret');
		expect(html).not.toContain('file:///');
		expect(html).toContain('<a href="https://example.com/x">safe</a>');
		expect(html).not.toContain('javascript:');
		expect(html).not.toContain('data:text');
	});

	it('produces independently valid bounded chunks without splitting entities, tags, or surrogate pairs', () => {
		const chunks = renderTelegramMarkdownAnswer(`**${'😀 & < > '.repeat(3_000)}**`);

		expect(chunks).toHaveLength(4);
		expect(chunks.every(chunk => chunk.length <= telegramMaximumMessageLength)).toBe(true);
		expect(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
		expect(chunks.every(chunk => (chunk.match(/<b>/g)?.length ?? 0) === (chunk.match(/<\/b>/g)?.length ?? 0))).toBe(true);
		expect(chunks.every(chunk => !/&(?:a|am|amp|l|lt|g|gt|q|quo|quot)?$/.test(chunk))).toBe(true);
		expect(chunks.at(-1)).toContain('Response truncated');
	});
});
